// clock-api — 高精度對時 API（Cloudflare Worker）
//
// /api/time         回傳 Worker 的時間（Cloudflare 的時鐘與 NTP 同步）。
// /api/proxy-time   用「秒邊界夾擠法」量出目標網站時鐘與 Worker 時鐘的差。
//
// 關於 Worker 的 Date.now()：為了防範 Spectre，Worker 執行期間時間是凍結的，
// 只有在 I/O（fetch、setTimeout）結束後才會前進。所以：
//   - /api/time 拿到的是「請求抵達 Worker 的時間」，剛好落在前端量測區間的前半段，
//     前端用 RTT/2 的假設不會被 Worker 的處理時間干擾。
//   - /api/proxy-time 每次 fetch 前後都有 I/O，t1、t2 都是準的；
//     就算 t1 偏舊，也只會讓區間變寬（保守），不會讓結果變錯。

// ---------- 設定 ----------

// 允許呼叫 /api/proxy-time 的前端網域。另外允許 localhost 方便本機測試。
// 可在 wrangler.toml 的 [vars] 用 ALLOWED_ORIGINS="https://a.com,https://b.com" 覆寫。
const DEFAULT_ALLOWED_ORIGINS = ['https://time.candy.moe'];

const PROBE_ROUNDS_DEFAULT = 8;
const PROBE_ROUNDS_MAX = 12;
const PROBE_TIMEOUT_MS = 6000;
const PROBE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

// ---------- 小工具 ----------

// open = true：任何網域都能呼叫（/api/time 只回傳時間，沒有濫用風險，
// 開放後「售票頁懸浮時鐘」書籤小工具可以直接在售票網站上對時）。
function corsHeaders(request, env, open = false) {
  if (open) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Timing-Allow-Origin': '*',
    };
  }
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : DEFAULT_ALLOWED_ORIGINS).map(s => s.trim());
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allowOrigin = allowed.includes(origin) || isLocal ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // 讓前端可以用 Resource Timing 拿到 requestStart / responseStart，
    // 把 DNS、TCP、TLS 與排隊時間從 RTT 中扣掉。
    'Timing-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
  };
}

function json(body, status, request, env, open = false) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env, open),
    },
  });
}

// 任何公開網站都可以探測；只擋本機與內網位址，避免被拿來掃內部網路。
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mod1000 = x => ((x % 1000) + 1000) % 1000;
const rand = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 探測用的網址。首頁常被 CDN 快取（Date 會是存進快取當時的時間），
// 所以準備幾個備案：加亂數參數的首頁、使用者給的網址、一個不存在的路徑（通常不會被快取）。
function probePaths(target) {
  return [
    u => `${u.origin}/?_t=${rand()}`,
    u => `${u.origin}${u.pathname}${u.search ? u.search + '&' : '?'}_t=${rand()}`,
    u => `${u.origin}/_tc_probe_${rand()}`,
  ].map(f => () => f(target));
}

// 打一次 HEAD，回傳送出與收到的 Worker 時間、Date 標頭（毫秒）
async function headOnce(url) {
  const t1 = Date.now();
  const res = await fetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': PROBE_UA, 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const t2 = Date.now();
  const dateHeader = res.headers.get('date');
  const age = parseInt(res.headers.get('age') || '0', 10) || 0;
  const date = dateHeader ? Date.parse(dateHeader) : NaN;
  return { t1, t2, date, age, status: res.status };
}

// 秒邊界夾擠法
//
// Date 標頭只到秒且被捨去，所以一次回應只告訴我們：
//   目標時鐘在「蓋章那一刻」介於 [D, D+1000)，而蓋章發生在 Worker 時間 [t1, t2] 之間。
// 因此 offset = 目標時間 − Worker 時間 必定落在 [D − t2, D + 1000 − t1]。
// 每次都瞄準「預測中的整秒交界」送出請求，回來的秒數有沒有進位，
// 就能把區間砍掉大約一半，最後收斂到約 ±RTT/2。
async function probeTarget(target, rounds) {
  let lo = -Infinity, hi = Infinity;
  let oneWay = 50;
  const samples = [];

  // 先找一個「回應沒被快取、有 Date 標頭」的探測網址（第一次也順便暖機）
  let makeUrl = null, firstErr = null;
  for (const candidate of probePaths(target)) {
    try {
      const s = await headOnce(candidate());
      samples.push({ rtt: s.t2 - s.t1, status: s.status, age: s.age, warmup: true });
      if (!Number.isNaN(s.date) && s.age === 0) { makeUrl = candidate; break; }
    } catch (e) { firstErr = firstErr || e; }
  }
  if (!makeUrl) {
    if (firstErr && !samples.length) throw new Error('連不到目標網站：' + firstErr.message);
    const hasDate = samples.length > 0;
    throw new Error(hasDate ? '目標網站的回應都來自快取，無法量測' : '目標網站沒有回傳 Date 標頭');
  }

  const take = async () => {
    const s = await headOnce(makeUrl());
    samples.push({ rtt: s.t2 - s.t1, status: s.status, age: s.age });
    oneWay = (s.t2 - s.t1) / 2;
    if (Number.isNaN(s.date) || s.age > 0) return; // 快取回應的 Date 不可信，丟掉
    const newLo = Math.max(lo, s.date - s.t2);
    const newHi = Math.min(hi, s.date + 1000 - s.t1);
    if (newLo > newHi) {
      // 前後矛盾：通常是目標背後有多台時鐘不一致的伺服器。保留較新的這筆，重新開始夾擠。
      lo = s.date - s.t2; hi = s.date + 1000 - s.t1;
      samples[samples.length - 1].reset = true;
    } else {
      lo = newLo; hi = newHi;
    }
  };

  // 暖機那次包含 DNS/TCP/TLS 握手，蓋章時間偏晚，但區間仍然成立；這裡再取一次正式樣本
  await take();

  for (let i = 0; i < rounds; i++) {
    const mid = Number.isFinite(lo) ? (lo + hi) / 2 : 0;
    // 預測：現在送出，請求抵達目標時，目標時鐘的「秒內毫秒數」
    const arrivePhase = mod1000(Date.now() + oneWay + mid);
    let wait = 1000 - arrivePhase;     // 等到預測的整秒交界
    if (wait < 5) wait += 1000;
    await sleep(wait);
    try { await take(); } catch { /* 單次逾時就跳過 */ }
    if (Number.isFinite(lo) && hi - lo <= 2 * oneWay + 4) break; // 已經夾到網路允許的極限
  }

  return { lo, hi, samples };
}

// ---------- 主程式 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request, env, url.pathname === '/api/time') });
    }

    // API 1：標準時間
    if (url.pathname === '/api/time') {
      return json({ status: 'success', serverTime: Date.now() }, 200, request, env, true);
    }

    // API 2：搶票模式——量測目標網站時鐘
    if (url.pathname === '/api/proxy-time') {
      let raw = (url.searchParams.get('url') || '').trim();
      if (!raw) return json({ status: 'error', message: '缺少 url 參數' }, 400, request, env);
      if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;   // 只打網域也可以

      let target;
      try { target = new URL(raw); } catch { return json({ status: 'error', message: '網址格式錯誤' }, 400, request, env); }
      if (!['https:', 'http:'].includes(target.protocol)) return json({ status: 'error', message: '只接受 http/https 網址' }, 400, request, env);
      if (isPrivateHost(target.hostname)) return json({ status: 'error', message: '不能探測本機或內網位址' }, 400, request, env);

      const rounds = Math.min(PROBE_ROUNDS_MAX, Math.max(1, parseInt(url.searchParams.get('rounds') || PROBE_ROUNDS_DEFAULT, 10) || PROBE_ROUNDS_DEFAULT));

      try {
        const { lo, hi, samples } = await probeTarget(target, rounds);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          return json({ status: 'error', message: '目標網站的回應都來自快取，無法量測' }, 502, request, env);
        }
        const offset = (lo + hi) / 2;          // 目標時鐘 − Worker 時鐘
        const uncertainty = (hi - lo) / 2;
        const workerTime = Date.now();
        const measured = samples.filter(s => !s.warmup);
        return json({
          status: 'success',
          host: target.hostname,
          offset,                                // 新版前端使用
          uncertainty,
          workerTime,
          samples,
          // 舊版前端相容欄位
          targetTime: Math.round(workerTime + offset),
          rtt: measured.length ? Math.min(...measured.map(s => s.rtt)) : null,
        }, 200, request, env);
      } catch (err) {
        return json({ status: 'error', message: err.message }, 502, request, env);
      }
    }

    return json({ error: 'Not found' }, 404, request, env);
  },
};

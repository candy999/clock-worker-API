import htmlContent from './index.html';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 提供前端 HTML 介面
    if (url.pathname === '/') {
      return new Response(htmlContent, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // 2. API: 獲取標準時間
    // Cloudflare Edge 節點與 Stratum-1 NTP 伺服器保持高精度同步
    // 因此 Worker 的 Date.now() 已經是極高精準度的標準時間
    if (url.pathname === '/api/time') {
      const serverTime = Date.now();
      return new Response(JSON.stringify({
        status: 'success',
        serverTime: serverTime
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 3. API: 搶票模式代理 (Proxy Time)
    // 用於獲取售票網站的 Date 標頭，突破 CORS 限制
    if (url.pathname === '/api/proxy-time') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return new Response('Missing URL', { status: 400 });

      const start = Date.now();
      try {
        const fetchRes = await fetch(targetUrl, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const end = Date.now();
        const dateHeader = fetchRes.headers.get('date');

        let targetTime = null;
        if (dateHeader) {
          targetTime = new Date(dateHeader).getTime();
        }

        return new Response(JSON.stringify({
          status: 'success',
          targetTime: targetTime,
          rtt: end - start // Worker 到售票網站的延遲
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ status: 'error', message: err.message }), { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
};
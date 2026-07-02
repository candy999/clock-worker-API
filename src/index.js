// 統一設定 CORS 標頭，為了安全，只允許你的前端網域存取
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://time.candy.moe", // 嚴格限制來源
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ★ 處理 CORS 預檢請求 (Preflight Request)
    // 當瀏覽器發送跨網域請求前，會先發一個 OPTIONS 請求確認伺服器是否允許
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders
      });
    }

    // API 1: 獲取標準時間
    if (url.pathname === '/api/time') {
      const serverTime = Date.now();
      return new Response(JSON.stringify({
        status: 'success',
        serverTime: serverTime
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders // 附加 CORS 標頭
        }
      });
    }

    // API 2: 搶票模式代理 (Proxy Time)
    if (url.pathname === '/api/proxy-time') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return new Response('Missing URL', { status: 400, headers: corsHeaders });
      }

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
          rtt: end - start
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders // 附加 CORS 標頭
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ status: 'error', message: err.message }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json', ...corsHeaders } 
        });
      }
    }

    // 找不到路由
    return new Response(JSON.stringify({ error: 'Not found' }), { 
      status: 404, 
      headers: { 'Content-Type': 'application/json', ...corsHeaders } 
    });
  }
};

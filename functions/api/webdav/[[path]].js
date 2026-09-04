/* =====================================================================
   个人全能工作台 · 云端同步同源代理（Pages Functions）
   ---------------------------------------------------------------------
   文件路径必须是： functions/api/webdav/[[path]].js
   [[path]] 是 Cloudflare Pages 的「通配路由」，只有带它，
   /api/webdav/worktable-backup.json 这类带文件名的请求才会进到本文件，
   否则只能匹配 /api/webdav 本身，文件名会 404。

   作用：
     浏览器有「跨域（CORS）」限制 —— 坚果云等网盘没有放开浏览器直连，
     网页端 fetch 会在预检阶段被拦（报 Failed to fetch）。
     而第三方 workers.dev 代理域名在国内又被墙，同样连不上。
     这个文件把代理放进工作台自己的域名下：前端请求 /api/webdav/xxx，
     和页面同源，既没有 CORS 问题，线路也一定可达（能打开工作台就能同步）。

   转发规则：
     /api/webdav/<文件名>  →  $WEBDAV_BASE/<文件名>
     WEBDAV_BASE 未配置时默认坚果云：https://dav.jianguoyun.com/dav
     （换 Nextcloud / 群晖等，只需在 Pages 项目
       设置 → 环境变量 里加 WEBDAV_BASE = 你的 WebDAV 目录地址）

   账号与应用密码仍由工作台页面填写，本代理只原样转发
   Authorization 头，不做任何存储。
   ===================================================================== */

/* 允许转发的 HTTP 方法白名单：够 WebDAV 增删改查用，其余一律拒绝 */
const METHODS = new Set([
  'GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS',
  'PROPFIND', 'MKCOL', 'MOVE', 'COPY'
]);

/* 请求里需要带给网盘的头（Authorization = 账号密码，Depth = WebDAV 目录查询深度） */
const REQ_HEADERS = [
  'authorization', 'content-type', 'depth',
  'if-match', 'if-none-match', 'if-range', 'range',
  'overwrite', 'destination'
];

/* 响应里需要透传回浏览器的头。
   注意：刻意不透传 www-authenticate —— 401 时带上它会让浏览器弹出
   原生「登录」对话框（显示的是工作台自己的域名，用户会一头雾水），
   headless/自动化环境里更会直接挂起。密码错误统一走应用内的提示文案。 */
const RES_HEADERS = [
  'content-type', 'etag', 'last-modified', 'dav', 'ms-author-via',
  'location', 'content-range'
];

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  if (!METHODS.has(method)) {
    return json({ error: 'method not allowed: ' + method }, 405);
  }

  /* 目标网盘基址：环境变量可换，默认坚果云 */
  const base = (env && env.WEBDAV_BASE || 'https://dav.jianguoyun.com/dav/').replace(/\/+$/, '');

  /* 剩余路径原样拼接（pathname 本身已是编码形态，不要 decode，
     否则含中文/空格的文件名会拼出非法 URL） */
  const url = new URL(request.url);
  const rel = url.pathname.replace(/^\/api\/webdav\/?/, '');
  const target = base + '/' + rel;

  /* 逐头搬运，不透传 host/cookie 等无关头 */
  const headers = new Headers();
  REQ_HEADERS.forEach(h => {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  });

  let upstream;
  try {
    upstream = await fetch(target, {
      method: method,
      headers: headers,
      /* GET/HEAD 不带 body；其余（PUT 等）流式透传 */
      body: (method === 'GET' || method === 'HEAD') ? undefined : request.body,
      redirect: 'follow'
    });
  } catch (e) {
    return json({ error: 'upstream unreachable: ' + (e && e.message || e) }, 502);
  }

  const respHeaders = new Headers();
  RES_HEADERS.forEach(h => {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  });
  /* 禁止缓存：备份文件每次都要拿到最新版，绝不能吃缓存 */
  respHeaders.set('cache-control', 'no-store');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' }
  });
}


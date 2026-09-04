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

   自检端点（排障用，浏览器直接打开）：
     https://你的域名/api/webdav/?diag=1        查看真实配置与拼出的目标地址
     https://你的域名/api/webdav/?diag=1&ping=1 额外向网盘发一次真实探测并给出结论
     不想暴露时，在 Pages 环境变量里设 WEBDAV_DIAG = 0 即可关闭。

   ---------------------------------------------------------------------
   关于 HTTP 520（本版重点加固）：
   520 = 代码抛了未捕获异常。旧版只在 fetch() 外包了 try/catch，
   响应构造那段是裸奔的。这里把每一处都补齐：
     · 入口总兜底 —— 任何漏网异常都返回 JSON，绝不再变成裸 520
     · 去掉 statusText —— HTTP/2 没有状态短语，取到的是空串，是头号崩溃嫌疑
     · 状态码范围校验 —— 不在 200–599 一律按 502 处理
     · null body 状态码（204/205/304）必须丢弃 body，否则 new Response 直接抛
     · 每个响应头 set() 单独 try/catch，非法头跳过而不连坐
     · new Response 失败时降级为空 body 再试一次，仍失败才报 500
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

/* 这些状态码按 HTTP 规范不允许带 body。
   一把上游的流塞进去，new Response 会直接抛 TypeError → 520。
   坚果云 PUT 成功返回 201，部分网盘返回 204，正好踩在这条线上。 */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

const DEFAULT_BASE = 'https://dav.jianguoyun.com/dav/';

/* ---------- 小工具 ---------- */

/* 安全写头：非法值（含换行、非法字符）会被 Headers 拒绝。
   单独吞掉并记一笔 note，绝不让一个坏头连坐整个响应。 */
function safeSet(headers, name, value, notes) {
  if (value === null || value === undefined || value === '') return;
  try {
    headers.set(name, value);
  } catch (e) {
    /* note 会写进 x-proxy-notes 响应头，而 HTTP 头只允许 ASCII，
       所以这里刻意用英文 —— 中文塞进去会被打成乱码问号，反而没法看。 */
    if (notes) notes.push('skipped invalid header "' + name + '": ' + (e && e.message || e));
  }
}

/* 把异常压成可 JSON 化的形状（stack 截断，避免响应体过大） */
function errInfo(e, extra) {
  const o = {
    name: (e && e.name) || 'Error',
    message: (e && e.message) || String(e),
    stack: String((e && e.stack) || '').slice(0, 2000)
  };
  if (extra) Object.assign(o, extra);
  return o;
}

/* 构造 JSON 响应。这里本身也可能是崩溃点，所以再兜一层 */
function json(obj, status) {
  try {
    return new Response(JSON.stringify(obj, null, 2), {
      status: status,
      headers: {
        'content-type': 'application/json;charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  } catch (e) {
    return new Response(
      '{"error":"json build failed","message":' + JSON.stringify(String((e && e.message) || e)) + '}',
      { status: 500, headers: { 'content-type': 'application/json;charset=utf-8' } }
    );
  }
}

/* 解析目标地址：环境变量可有可无，缺省用内置默认值（坚果云） */
function resolve(env, url) {
  const raw = env && env.WEBDAV_BASE;
  const base = String(raw || DEFAULT_BASE).replace(/\/+$/, '');
  const rel = url.pathname.replace(/^\/api\/webdav\/?/, '');
  return {
    base: base,
    rel: rel,
    target: base + '/' + rel,
    fromEnv: !!raw
  };
}

/* ---------- 自检端点 ----------
   带 ?diag=1 时不再转发，直接把真实环境吐出来。
   排障时不用再翻抓不到的日志，浏览器打开就能看。 */
async function diag(request, env, url) {
  const r = resolve(env, url);
  const auth = request.headers.get('authorization') || '';

  const info = {
    ok: true,
    endpoint: 'webdav-proxy diag',
    time: new Date().toISOString(),

    /* 一、真实生效的配置 */
    config: {
      WEBDAV_BASE_env: r.fromEnv ? env.WEBDAV_BASE : null,
      WEBDAV_BASE_source: r.fromEnv ? '来自 Pages 环境变量（已生效）' : '未设置环境变量 → 使用内置默认值',
      WEBDAV_BASE_default: DEFAULT_BASE,
      WEBDAV_BASE_used: r.base,
      diagEnabled: true
    },

    /* 二、本次请求解析出的目标地址（这就是真正转发去的地方） */
    resolved: {
      incomingPath: url.pathname,
      rel: r.rel,
      target: r.target
    },

    /* 三、请求侧信息（Authorization 只报长度和 scheme，绝不回显内容） */
    request: {
      method: request.method,
      hasAuthorization: !!auth,
      authorizationLength: auth.length,
      authorizationScheme: auth ? auth.split(' ')[0] : null,
      userAgent: (request.headers.get('user-agent') || '').slice(0, 120)
    },

    /* 四、运行时环境（键名过滤掉疑似敏感项） */
    runtime: {
      hasEnv: !!env,
      envKeys: env ? Object.keys(env).filter(k => !/secret|token|key|pass|pwd/i.test(k)) : []
    }
  };

  /* 五、可选真实探测：?diag=1&ping=1
     真的往网盘发一次 PROPFIND，把结果、耗时和结论一并报出来 */
  if (url.searchParams.get('ping') === '1') {
    const t0 = Date.now();
    const h = { depth: '0' };
    if (auth) h.authorization = auth;
    try {
      const probe = await fetch(r.target, { method: 'PROPFIND', headers: h, redirect: 'follow' });
      const s = probe.status;
      info.ping = {
        ok: true,
        status: s,
        ms: Date.now() - t0,
        /* 直接给出结论，省得再对照一遍 */
        verdict:
          (s === 207 || s === 200) ? '✓ 目录可达、账号密码正确 —— 同步可以正常工作'
            : (s === 401 || s === 403) ? '✗ 账号或应用密码不对。坚果云要填「应用密码」（账户信息 → 安全选项 → 添加应用密码），不是登录密码'
              : s === 404 ? '✗ 目录不存在。请到网盘网页版先把目录建好，地址填到目录为止'
                : '? 网盘返回 HTTP ' + s + '（线路和密码都通过了，但服务器没接受这个请求）'
      };
    } catch (e) {
      info.ping = Object.assign(
        { ok: false, ms: Date.now() - t0, detail: '连不到网盘，检查 WEBDAV_BASE 是否写错或该域名是否被墙' },
        errInfo(e, { target: r.target })
      );
    }
  }

  return json(info, 200);
}

/* ---------- 主流程 ---------- */
async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  /* 0) 自检端点优先 —— 任何方法、任何路径都能自检 */
  if (url.searchParams.get('diag') === '1' && (env && env.WEBDAV_DIAG) !== '0') {
    return await diag(request, env || {}, url);
  }

  /* 1) 方法白名单 */
  const method = (request.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) {
    return json({
      error: 'method not allowed: ' + method,
      allowed: Array.from(METHODS),
      hint: '工作台只需要 GET / PUT / PROPFIND。出现别的方法，通常是地址被填成了网页地址。'
    }, 405);
  }

  /* 2) 解析目标地址 */
  const r = resolve(env, url);

  /* 3) 搬运请求头（无关头不转发，避免把 host/cookie 泄给网盘） */
  const headers = new Headers();
  REQ_HEADERS.forEach(h => safeSet(headers, h, request.headers.get(h)));

  /* 4) 转发 —— 网络层异常 */
  let upstream;
  try {
    upstream = await fetch(r.target, {
      method: method,
      headers: headers,
      /* GET/HEAD 不带 body；其余（PUT 等）流式透传 */
      body: (method === 'GET' || method === 'HEAD') ? undefined : request.body,
      redirect: 'follow'
    });
  } catch (e) {
    return json({
      error: 'upstream unreachable',
      detail: '连不到网盘服务器。常见于 WEBDAV_BASE 写错、网盘域名被墙、或目标需要代理。',
      target: r.target,
      exception: errInfo(e)
    }, 502);
  }

  /* ========= 响应构造（旧版裸奔区，本版全副武装） ========= */
  const notes = [];
  try {
    /* 5.1) 状态码范围校验：
           1xx / 非法值 / 0（opaque 响应）一律降级成 502，
           否则 new Response 会抛 RangeError → 520 */
    let status = upstream.status;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      notes.push('illegal upstream status ' + JSON.stringify(upstream.status) + ' -> downgraded to 502');
      status = 502;
    }

    /* 5.2) 搬运响应头：每个 set 单独 try/catch，坏头跳过不连坐 */
    const respHeaders = new Headers();
    RES_HEADERS.forEach(h => safeSet(respHeaders, h, upstream.headers.get(h), notes));
    /* 禁止缓存：备份文件每次都要拿到最新版，绝不能吃缓存 */
    safeSet(respHeaders, 'cache-control', 'no-store', notes);

    /* 5.3) body 处理：null body 状态码 / HEAD 必须丢弃 body，
           否则 new Response 抛 TypeError → 520 */
    let body = upstream.body;
    if (NULL_BODY_STATUS.has(status) || method === 'HEAD') {
      if (body) notes.push('body dropped: HTTP ' + status + ' must not carry a body');
      body = null;
    }

    /* 5.4) 构造响应。
           刻意不传 statusText —— HTTP/2 没有状态短语，取到的是空串，
           旧版把它原样塞进去正是 520 的头号嫌疑点。 */
    let resp;
    try {
      resp = new Response(body, { status: status, headers: respHeaders });
    } catch (e) {
      /* 带 body 构造失败时降级为「只带状态码、不带 body」再试一次，
         仍失败才报 500 —— 宁可少给内容，也不能给 520 */
      notes.push('body attach failed -> downgraded to empty body: ' + ((e && e.message) || e));
      resp = new Response(null, { status: status, headers: respHeaders });
    }

    /* 跳过头 / 降级这类非致命情况，塞进响应头里方便排查 */
    if (notes.length) {
      try {
        resp.headers.set(
          'x-proxy-notes',
          notes.join(' | ').replace(/[^\x20-\x7e]/g, '?').slice(0, 500)
        );
      } catch (e) { /* 头都设不进去就算了，不影响主响应 */ }
    }
    return resp;
  } catch (e) {
    return json({
      error: 'response build failed',
      detail: '已连上网盘，但把响应转交给浏览器时出错。多半是网盘返回了不规范的响应。',
      target: r.target,
      upstreamStatus: upstream && upstream.status,
      notes: notes,
      exception: errInfo(e)
    }, 500);
  }
}

/* ---------- 入口：总兜底 ----------
   只要这里还有漏网异常，Workers 就会返回裸 520（什么信息都没有）。
   现在任何异常都会变成带 message 和 stack 的 JSON，浏览器直接能看到。 */
export async function onRequest(context) {
  try {
    return await handle(context || {});
  } catch (e) {
    return json({
      error: 'unhandled exception',
      detail: '代理内部抛出未捕获异常。把下面这段完整内容贴出来即可定位。',
      url: context && context.request && context.request.url,
      method: context && context.request && context.request.method,
      exception: errInfo(e)
    }, 500);
  }
}



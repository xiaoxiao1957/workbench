/* =====================================================================
   个人全能工作台 · 云端同步后端（Pages Functions + Cloudflare Workers KV）
   ---------------------------------------------------------------------
   文件路径必须是： functions/api/webdav/[[path]].js
   [[path]] 是 Cloudflare Pages 的通配路由，只有带它，
   /api/webdav/worktable-backup.json 这类带文件名的请求才会进到本文件。

   后端演进（每一步都是被现实逼的，不是瞎折腾）：
     ① 直连坚果云      → 浏览器被 CORS 挡死（坚果云不发跨域头）
     ② 经本站代理转发  → 坚果云屏蔽 Cloudflare Workers IP 段，一律 520
     ③ Cloudflare R2   → 能用，但开通 R2 要绑支付方式
     ④ Cloudflare KV   → 现在这版。免费额度就够，不用绑卡。

   ★ 前端零改动：
     工作台的 SYNC.up / down / test 依旧对 /api/webdav/ 发
     PUT / GET / PROPFIND，设置页地址仍填 /api/webdav/。
     「WebDAV 语义 → KV 操作」的转换全部在本文件内部完成：

       PUT      /api/webdav/备份.json  →  env.MY_KV.put(key, text)
       GET      同上                   →  env.MY_KV.get(key)      无则 404
       PROPFIND 目录（rel 为空）        →  env.MY_KV.list()        探测命名空间可达
       PROPFIND 文件                   →  getWithMetadata(key)    存在 207 / 无 404
       HEAD                           →  getWithMetadata(key)    只要元数据
       DELETE                         →  env.MY_KV.delete(key)

   ★ KV 的两个特性，代码里都做了处理：
     1. 单条 value 上限 25 MiB。超限直接返回 413 并说明，绝不写进去一半。
     2. 最终一致：写入后全球同步约 60 秒。刚上传完立刻拉取可能拿到旧值 ——
        这是 KV 的正常特性，不是同步失败。PUT 响应头会带提示，
        diag 里也有专门一段说明，避免误判。

   访问控制（可选）：
     在 Pages 环境变量里设 SYNC_TOKEN 后，请求必须带
       x-sync-token: <token>   或   Authorization: Bearer <token>
     未设置 SYNC_TOKEN 时不鉴权（保持前端零改动也能用）。

   自检端点（浏览器直接打开，排障用）：
     /api/webdav/?diag=1                    环境信息 + 命名空间绑定状态 + KV 探测
     /api/webdav/?diag=1&raw=1              深度探测：get/list 逐个跑，带耗时与异常栈
     /api/webdav/?diag=1&raw=1&write=1      额外做一次真实写入-删除往返，验证写权限
     不想暴露：环境变量设 WEBDAV_DIAG = 0 关闭。

   安全底线：
     · diag 只回显密钥的「长度和 scheme」，绝不回显内容
     · 响应头 ASCII 净化 + 控制字符丢弃（否则 CF 边缘发不出响应 → 裸 520）
     · 入口全局 try/catch，任何异常都变成带 message/stack 的 JSON
   ===================================================================== */

const DEFAULT_FILE = 'worktable-backup.json';
const JSON_CONTENT_TYPE = 'application/json;charset=utf-8';

/* KV 命名空间绑定的变量名。改这个常量，代码里的 env.X 会跟着变，
   但 Pages 面板里填的名字也必须跟着改 —— 两处必须一字不差。 */
const KV_BINDING = 'MY_KV';

/* KV 单条 value 上限 25 MiB（Cloudflare 官方限制） */
const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;
/* KV key 上限 512 字节 */
const KV_MAX_KEY_BYTES = 512;

/* null body 状态码：这些状态不允许带 body，塞了 new Response 直接抛 TypeError */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/* 响应头里的最终一致提示（必须是纯 ASCII，否则 CF 边缘发不出去 → 裸 520） */
const CONSISTENCY_NOTE =
  'eventual-consistency: KV syncs globally in up to 60s; ' +
  'pulling right after upload may return the previous value (not a failure)';

/* ---------- 小工具 ---------- */

/* 只保留可打印 ASCII。
   HTTP 头值里出现非 ASCII 时，Cloudflare 边缘可能根本发不出这个响应，
   直接回 520 —— 而 Worker 代码一步异常都没抛，任何 try/catch 都抓不到。 */
function asciiSafe(v) {
  return String(v).replace(/[^\x20-\x7e\t]/g, '?');
}

/* 安全写响应头。
   ① 控制字符（\n \r \0）＝ 头注入风险 → 整个头丢弃，绝不改写成 '?' 放行
   ② 非法值被 Headers 拒绝 → 跳过并记 note，不连坐其他头
   ③ 回浏览器的头一律做 ASCII 净化 */
function safeSet(headers, name, value, notes) {
  if (value === null || value === undefined || value === '') return;
  const v = String(value);
  if (/[\r\n\0]/.test(v)) {
    if (notes) notes.push('dropped unsafe header "' + name + '": contains control characters');
    return;
  }
  try {
    headers.set(name, asciiSafe(v));
  } catch (e) {
    /* note 会写进 x-proxy-notes 响应头，HTTP 头只允许 ASCII，故用英文 */
    if (notes) notes.push('skipped invalid header "' + name + '": ' + (e && e.message || e));
  }
}

function errInfo(e, extra) {
  const o = {
    name: (e && e.name) || 'Error',
    message: (e && e.message) || String(e),
    stack: String((e && e.stack) || '').slice(0, 2000)
  };
  if (extra) Object.assign(o, extra);
  return o;
}

/* 字节长度。限制判断必须按字节算：中文一个字 3 字节，
   按 JS 的 .length（字符数）算会低估三倍，容易在真·临界点上翻车。 */
function byteLen(s) {
  try { return new TextEncoder().encode(s).length; } catch (e) { return String(s).length; }
}

/* 简易哈希，用来给 KV 造一个稳定的 etag（KV 本身不提供 etag） */
function simpleHash(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function etagOf(text, uploadedAt) {
  return '"' + byteLen(text).toString(16) + '-' + simpleHash(String(uploadedAt) + '|' + text.length) + '"';
}

/* 构造 JSON 响应，本身也兜一层 */
function json(obj, status, notes) {
  try {
    const h = { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store' };
    if (notes && notes.length) {
      h['x-proxy-notes'] = asciiSafe(notes.join(' | ').replace(/[\r\n\0]/g, ' ')).slice(0, 500);
    }
    return new Response(JSON.stringify(obj, null, 2), { status: status, headers: h });
  } catch (e) {
    return new Response(
      '{"error":"json build failed","message":' + JSON.stringify(String((e && e.message) || e)) + '}',
      { status: 500, headers: { 'content-type': JSON_CONTENT_TYPE } }
    );
  }
}

/* 把 KV 里的值包装成 HTTP 响应。
   KV 不提供 etag / last-modified，用 metadata 里自己记的 uploadedAt 补上。 */
function valueResponse(value, meta, key, notes, method) {
  const h = new Headers();
  safeSet(h, 'content-type', JSON_CONTENT_TYPE, notes);
  const uploadedAt = meta && meta.uploadedAt;
  if (uploadedAt) {
    safeSet(h, 'last-modified', new Date(uploadedAt).toUTCString(), notes);
    safeSet(h, 'etag', etagOf(value, uploadedAt), notes);
    /* ★ 最终一致提示：60 秒内拉取可能拿到旧值。给前端/F12 一个明确信号，
       免得用户以为同步失败。 */
    const ageSec = Math.round((Date.now() - new Date(uploadedAt).getTime()) / 1000);
    safeSet(h, 'x-kv-age-seconds', String(ageSec), notes);
    if (ageSec < 60) safeSet(h, 'x-kv-may-be-stale', '1', notes);
  }
  safeSet(h, 'content-length', String(byteLen(value)), notes);
  safeSet(h, 'cache-control', 'no-store', notes);
  safeSet(h, 'x-kv-key', key, notes);
  if (meta && typeof meta === 'object') {
    Object.keys(meta).slice(0, 10).forEach(k => {
      safeSet(h, 'x-kv-meta-' + k.toLowerCase().replace(/[^a-z0-9-]/g, '-'), meta[k], notes);
    });
  }
  if (notes && notes.length) safeSet(h, 'x-proxy-notes', notes.join(' | '), notes);
  /* HEAD 不带 body */
  return new Response(method === 'HEAD' ? null : value, { status: 200, headers: h });
}

/* ---------- 鉴权 ---------- */

/* 定时安全比较：逐字符异或，长度也纳入比较，避免通过响应耗时猜 token */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* 返回 null 表示通过；否则是要直接发出的 401/403 响应。
   ★ SYNC_TOKEN 未配置 → 不鉴权，保持「前端零改动也能用」。 */
function checkAuth(request, env, notes) {
  const expected = env && env.SYNC_TOKEN;
  if (!expected) return null;
  /* ★ 只有 Bearer scheme 才算同步密钥。
     前端为了兼容保留了 WebDAV 语义的 Authorization: Basic <账号:密码>，
     若不区分 scheme，填过账号密码却没填密钥的请求会被误判成 403「密钥不对」，
     而正确答案是 401「没带密钥」—— 提示一错，用户就往反方向查。 */
  const authz = String(request.headers.get('authorization') || '');
  const bearer = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '') : '';
  const got = request.headers.get('x-sync-token') || bearer;
  if (!got) {
    return json({
      error: 'missing sync token',
      detail: '这个站点设了同步密钥（SYNC_TOKEN），但本次请求没带。',
      fix: '工作台 → 设置 → 云端同步 → 把「同步密钥」填进去，与 Pages 环境变量 SYNC_TOKEN 保持一致。',
      accepts: ['x-sync-token: <token>', 'Authorization: Bearer <token>']
    }, 401, notes);
  }
  if (!safeEqual(got, expected)) {
    return json({
      error: 'invalid sync token',
      detail: '同步密钥不对。',
      fix: '核对工作台里的「同步密钥」与 Pages 环境变量 SYNC_TOKEN 是否一字不差（注意别多复制空格）。',
      receivedLength: got.length
    }, 403, notes);
  }
  return null;
}

/* ---------- 命名空间未绑定的降级提示 ----------
   最容易踩的一步：Pages 绑定没做，env.MY_KV 就是 undefined。
   必须给一份「照着点就能修好」的指引，并列出当前 env 实际可见的变量名 ——
   填成 MY_KV2 / my_kv / MY-KV 的人，一眼就能看出自己错在哪。 */
function kvMissingResponse(env, notes) {
  return json({
    error: 'KV namespace not bound',
    detail: 'KV 命名空间还没绑定到这个 Pages 项目 —— 这不是代码问题，是配置还没做完。',
    howToFix: [
      '① Cloudflare 面板 → 左侧「Workers 和 Pages」→ 点 KV',
      '② 右上角「创建命名空间」（Create namespace）',
      '   名称随意，例如 workbench-backup → 点「添加」',
      '③ 回到 Workers & Pages → 点进你的工作台项目',
      '④ 设置（Settings）→ 函数（Functions）',
      '⑤ 找到 KV 命名空间绑定（KV namespace bindings）→ 添加绑定（Add binding）',
      '⑥ 变量名称（Variable name）必须一字不差填：' + KV_BINDING,
      '⑦ KV 命名空间（KV namespace）选刚才建的那个 → 保存',
      '⑧ 部署（Deployments）→ 对最新一次点 ⋯ → 重新部署（Retry deployment）',
      '   注意：只改绑定不重新部署，绑定不会生效'
    ],
    expectedVariableName: KV_BINDING,
    bindingsCurrentlyVisible: env ? Object.keys(env) : [],
    hint: '上面列出了当前 env 里能看到的变量名 —— 若其中没有 ' + KV_BINDING +
      '，就是第 ⑤ 步没做对；若看到了一个名字很像但不一样的（比如 my_kv / MY_KV2），说明变量名填错了。'
  }, 503, notes);
}

/* ---------- 键名 ---------- */
/* pathname 已是编码形态，不要 decode，否则中文/空格文件名会拼坏 */
function keyOf(url) {
  const rel = url.pathname.replace(/^\/api\/webdav\/?/, '');
  return rel || DEFAULT_FILE;
}

async function readAll(request) {
  if (!request.body) return '';
  return await request.text();
}

/* 超限检查：KV 单条 25 MiB。返回 null 表示没问题，否则返回要直接发出的响应。
   双重保险：先看 content-length 头（不用读完 body 就能拒），再按字节精确算。 */
function oversizeResponse(declaredBytes, actualBytes, key, notes) {
  const over = Math.max(declaredBytes || 0, actualBytes || 0);
  return json({
    error: 'value too large for KV',
    detail: '这次要存的内容 ' + over + ' 字节，超过了 KV 单条值上限 ' + KV_MAX_VALUE_BYTES +
      ' 字节（25 MiB）。不是同步功能坏了，是数据量顶到天花板了。',
    key: key,
    bytes: over,
    limitBytes: KV_MAX_VALUE_BYTES,
    howToFix: [
      '① 先在工作台里清掉不需要的历史数据（尤其是日志、已完成很久的条目）',
      '② 如果确实要存这么大，说明该换 R2 了 —— R2 单对象上限 5 TB，但要绑支付方式'
    ]
  }, 413, notes);
}

/* ---------- 自检端点 ---------- */
async function diag(request, env, url) {
  const kv = env && env[KV_BINDING];
  /* 与 checkAuth 保持一致：只有 Bearer scheme 才算密钥，
     否则前端保留的 Basic 头会被当成密钥，长度和存在性全报错 */
  const authz = String(request.headers.get('authorization') || '');
  const bearer = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '') : '';
  const token = request.headers.get('x-sync-token') || bearer;
  const expectedToken = env && env.SYNC_TOKEN;

  const info = {
    ok: true,
    endpoint: 'webdav-proxy diag (KV backend)',
    backend: 'Cloudflare Workers KV',
    time: new Date().toISOString(),

    /* 一、命名空间绑定状态 —— 排障第一眼看这里 */
    kv: {
      namespaceBound: !!kv,
      bindingName: KV_BINDING,
      status: kv
        ? '✓ 已绑定，可以读写'
        : '✗ 未绑定：env.' + KV_BINDING + ' 不存在，同步一定会失败',
      bindingsVisible: env ? Object.keys(env) : []
    },

    /* 二、KV 特性说明（这两条最容易让人误判成「同步失败」，写在这里省得反复解释） */
    kvCharacteristics: {
      consistency: '最终一致：写入后全球各节点同步约需 60 秒',
      whatYouMaySee: '刚点完「上传到云端」立刻点「从云端拉取」，60 秒内可能拿到上一版数据',
      isThisABug: '不是 bug，也不代表上传失败。等 60 秒再拉就是新的。',
      whereToConfirm: '看下面的 probe.lastModified —— 它才是云端的真实写入时间',
      valueSizeLimit: '单条值上限 25 MiB（当前这份备份远小于此，见 limits 段）'
    },

    /* 三、鉴权状态（只报长度，绝不回显内容） */
    auth: {
      SYNC_TOKEN_configured: !!expectedToken,
      mode: expectedToken
        ? '需要密钥：请求须带 x-sync-token'
        : '未设 SYNC_TOKEN → 不鉴权，前端零改动可用',
      configuredTokenLength: expectedToken ? String(expectedToken).length : 0,
      requestTokenPresent: !!token,
      requestTokenLength: token.length
    },

    /* 四、本次请求 */
    request: {
      method: request.method,
      incomingPath: url.pathname,
      kvKey: keyOf(url),
      userAgent: (request.headers.get('user-agent') || '').slice(0, 120)
    }
  };

  /* 五、KV 真实探测：读一次，验证绑定是否真的可用 */
  if (kv) {
    const key = keyOf(url);
    const t0 = Date.now();
    try {
      const got = await kv.getWithMetadata(key, { type: 'text' });
      const value = got && got.value;
      const meta = (got && got.metadata) || null;
      info.probe = {
        ok: true,
        key: key,
        valueExists: value !== null && value !== undefined,
        bytes: value === null || value === undefined ? null : byteLen(value),
        lastModified: meta && meta.uploadedAt ? meta.uploadedAt : null,
        ms: Date.now() - t0,
        verdict: (value === null || value === undefined)
          ? '△ 云端还没有备份文件 —— 正常现象，第一次点「上传到云端」就会创建'
          : '✓ 云端已有备份文件（' + byteLen(value) + ' 字节，写入于 ' +
            (meta && meta.uploadedAt ? meta.uploadedAt : '未知') + '），可以直接「从云端拉取」'
      };

      /* 容量占用：离 25 MiB 上限还有多远 */
      if (value !== null && value !== undefined) {
        const b = byteLen(value);
        info.limits = {
          currentBytes: b,
          limitBytes: KV_MAX_VALUE_BYTES,
          usedPercent: Math.round(b / KV_MAX_VALUE_BYTES * 10000) / 100,
          remainingBytes: KV_MAX_VALUE_BYTES - b,
          verdict: b > KV_MAX_VALUE_BYTES
            ? '✗ 已超限，下次上传会被拒（413）'
            : '✓ 远低于 25 MiB 上限，随便用'
        };
      }
    } catch (e) {
      info.probe = Object.assign({ ok: false, key: key, ms: Date.now() - t0 }, errInfo(e, {
        verdict: '✗ 读 KV 时出错：命名空间绑定了但权限/配置不对，见 stack'
      }));
    }

    try {
      const list = await kv.list({ limit: 20 });
      info.namespaceContents = (list.keys || []).map(k => ({
        key: k.name,
        uploadedAt: k.metadata && k.metadata.uploadedAt ? k.metadata.uploadedAt : null
      }));
    } catch (e) {
      info.namespaceContents = Object.assign({ error: true }, errInfo(e));
    }
  }

  /* 六、raw 深度探测：get / list 逐个跑，带耗时、异常栈与内容预览 */
  if (url.searchParams.get('raw') === '1') {
    const key = keyOf(url);
    info.raw = { key: key, steps: [] };

    if (!kv) {
      info.raw.steps.push({
        step: 'precondition', ok: false,
        verdict: '✗ 跳过全部探测：env.' + KV_BINDING + ' 不存在，先按 kv.status 的指引完成绑定'
      });
    } else {
      /* getWithMetadata：连元数据一起取，能看到云端真实写入时间 */
      let t = Date.now();
      try {
        const got = await kv.getWithMetadata(key, { type: 'text' });
        const v = got && got.value;
        info.raw.steps.push({
          step: 'getWithMetadata', ok: true, ms: Date.now() - t,
          exists: v !== null && v !== undefined,
          bytes: (v === null || v === undefined) ? null : byteLen(v),
          uploadedAt: got && got.metadata ? (got.metadata.uploadedAt || null) : null
        });
      } catch (e) {
        info.raw.steps.push(Object.assign({ step: 'getWithMetadata', ok: false, ms: Date.now() - t }, errInfo(e)));
      }

      /* get + 内容预览前 500 字符（看清云端存的到底是不是工作台备份） */
      t = Date.now();
      try {
        const text = await kv.get(key, { type: 'text' });
        if (text === null || text === undefined) {
          info.raw.steps.push({
            step: 'get', ok: true, ms: Date.now() - t, exists: false,
            verdict: '文件不存在（还没上传过）'
          });
        } else {
          let isBackup = false, parseError = null;
          try {
            const parsed = JSON.parse(text);
            isBackup = !!(parsed && parsed.__wb);
          } catch (pe) { parseError = String((pe && pe.message) || pe).slice(0, 200); }
          info.raw.steps.push({
            step: 'get', ok: true, ms: Date.now() - t, exists: true,
            bytes: byteLen(text),
            bodyPreview: text.slice(0, 500),
            jsonParsed: !parseError,
            parseError: parseError,
            isWorkbenchBackup: isBackup,
            verdict: isBackup
              ? '✓ 云端存的是合法的工作台备份（含 __wb 字段）'
              : (parseError
                ? '✗ 云端文件不是合法 JSON：' + parseError
                : '✗ 云端文件缺 __wb 字段，可能不是本工作台的备份')
          });
        }
      } catch (e) {
        info.raw.steps.push(Object.assign({ step: 'get', ok: false, ms: Date.now() - t }, errInfo(e)));
      }

      /* list */
      t = Date.now();
      try {
        const l = await kv.list({ limit: 20 });
        info.raw.steps.push({
          step: 'list', ok: true, ms: Date.now() - t,
          count: (l.keys || []).length,
          keys: (l.keys || []).map(k => k.name)
        });
      } catch (e) {
        info.raw.steps.push(Object.assign({ step: 'list', ok: false, ms: Date.now() - t }, errInfo(e)));
      }

      /* 可选写权限验证：写入 → 读回 → 删除，不留垃圾。
         ★ KV 是最终一致的，所以「写进去却没立刻读回来」是正常现象，不是写入失败。
           判据要看 kv.put 有没有抛异常 —— 没抛就是写成功了。
           这里如实记录两种情况，并明确给出各自的含义，避免误判。 */
      if (url.searchParams.get('write') === '1') {
        const probeKey = '__wb_write_probe__.txt';
        t = Date.now();
        let writeOk = true, writeErr = null;
        try {
          await kv.put(probeKey, 'probe ' + new Date().toISOString(), {
            metadata: { uploadedAt: new Date().toISOString(), source: 'diag-write-probe' }
          });
        } catch (e) {
          writeOk = false; writeErr = errInfo(e);
        }

        if (!writeOk) {
          info.raw.steps.push(Object.assign({
            step: 'write-roundtrip', ok: false, ms: Date.now() - t,
            verdict: '✗ 写入失败：命名空间可能是只读绑定，或权限不足'
          }, writeErr));
        } else {
          let readBack = null;
          try { readBack = await kv.get(probeKey, { type: 'text' }); } catch (e) { readBack = null; }
          try { await kv.delete(probeKey); } catch (e) { /* 清理失败不影响结论 */ }
          info.raw.steps.push({
            step: 'write-roundtrip', ok: true, ms: Date.now() - t,
            putSucceeded: true,
            readBackImmediately: readBack !== null && readBack !== undefined,
            cleanedUp: true,
            verdict: (readBack !== null && readBack !== undefined)
              ? '✓ 写入-读取-删除往返成功，命名空间可正常读写'
              : '✓ 写入成功（put 没报错），但刚写完立刻读还是空的 —— 这正是 KV 最终一致的正常表现，' +
                '不是写入失败。等几秒再读就有了。'
          });
        }
      }
    }

    info.raw.summary = {
      totalSteps: info.raw.steps.length,
      failedSteps: info.raw.steps.filter(s => s.ok === false).length,
      conclusion: !kv
        ? '✗ 命名空间未绑定，先按 kv.status 的指引完成 Pages 绑定并重新部署'
        : (info.raw.steps.some(s => s.ok === false)
          ? '✗ 有步骤失败，逐条看对应 step 的 message 与 stack'
          : '✓ KV 读写全部正常')
    };
  }

  return json(info, 200);
}

/* ---------- 主流程 ---------- */
async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const notes = [];

  /* 0) 自检端点优先（任何方法、任何路径都能自检） */
  if (url.searchParams.get('diag') === '1' && (env && env.WEBDAV_DIAG) !== '0') {
    return await diag(request, env || {}, url);
  }

  /* 1) 鉴权（未设 SYNC_TOKEN 时直接放行） */
  const denied = checkAuth(request, env, notes);
  if (denied) return denied;

  /* 2) 命名空间未绑定 → 明确指引，绝不笼统 520 */
  const kv = env && env[KV_BINDING];
  if (!kv) return kvMissingResponse(env, notes);

  /* 3) 方法路由 */
  const method = (request.method || 'GET').toUpperCase();
  const key = keyOf(url);

  try {
    /* --- PUT：写入备份 --- */
    if (method === 'PUT') {
      /* 先看声明长度，超了直接拒，省得把 25MB 全读进内存 */
      const declared = Number(request.headers.get('content-length') || 0);
      if (declared > KV_MAX_VALUE_BYTES) {
        return oversizeResponse(declared, 0, key, notes);
      }
      if (byteLen(key) > KV_MAX_KEY_BYTES) {
        return json({
          error: 'key too long for KV',
          detail: '键名 ' + byteLen(key) + ' 字节，超过 KV 的 512 字节上限。检查同步地址是不是填得太长。',
          key: key
        }, 400, notes);
      }

      const body = await readAll(request);
      const bytes = byteLen(body);
      if (bytes > KV_MAX_VALUE_BYTES) {
        return oversizeResponse(declared, bytes, key, notes);
      }

      const uploadedAt = new Date().toISOString();
      await kv.put(key, body, {
        metadata: { uploadedAt: uploadedAt, source: 'worktable-web', bytes: String(bytes) }
      });

      const h = new Headers();
      safeSet(h, 'etag', etagOf(body, uploadedAt), notes);
      safeSet(h, 'content-type', JSON_CONTENT_TYPE, notes);
      safeSet(h, 'cache-control', 'no-store', notes);
      safeSet(h, 'x-kv-key', key, notes);
      safeSet(h, 'x-kv-size', String(bytes), notes);
      /* ★ 最终一致提示放进响应头：F12 里看得见，也提醒未来的自己别误判 */
      safeSet(h, 'x-kv-consistency', CONSISTENCY_NOTE, notes);
      safeSet(h, 'x-kv-uploaded-at', uploadedAt, notes);
      if (notes.length) safeSet(h, 'x-proxy-notes', notes.join(' | '), notes);
      return new Response(null, { status: 201, headers: h });
    }

    /* --- GET：读取备份；不存在 → 404（前端据此提示「还没上传过」） --- */
    if (method === 'GET') {
      const got = await kv.getWithMetadata(key, { type: 'text' });
      const value = got && got.value;
      if (value === null || value === undefined) {
        return new Response(null, {
          status: 404,
          headers: { 'cache-control': 'no-store', 'content-type': JSON_CONTENT_TYPE }
        });
      }
      return valueResponse(value, (got && got.metadata) || null, key, notes, 'GET');
    }

    /* --- HEAD：只要元数据 --- */
    if (method === 'HEAD') {
      const got = await kv.getWithMetadata(key, { type: 'text' });
      const value = got && got.value;
      if (value === null || value === undefined) {
        return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      return valueResponse(value, (got && got.metadata) || null, key, notes, 'HEAD');
    }

    /* --- PROPFIND：测试连接用 ---
       前端测的是「目录」（rel 为空）→ 改为 list() 探测命名空间可达性，
       返回 207 表示存储可用。绝不因为「文件还没上传」就误报目录不存在。 */
    if (method === 'PROPFIND') {
      const path = url.pathname.replace(/\/+$/, '');
      const isDirProbe = (path === '/api/webdav');
      if (isDirProbe) {
        const list = await kv.list({ limit: 1 });
        const h = new Headers();
        safeSet(h, 'content-type', 'application/xml;charset=utf-8', notes);
        safeSet(h, 'cache-control', 'no-store', notes);
        safeSet(h, 'x-kv-key-count', String((list.keys || []).length), notes);
        if (notes.length) safeSet(h, 'x-proxy-notes', notes.join(' | '), notes);
        return new Response('<?xml version="1.0"?><multistatus xmlns="DAV:"/>', { status: 207, headers: h });
      }
      const got = await kv.getWithMetadata(key, { type: 'text' });
      const value = got && got.value;
      if (value === null || value === undefined) {
        return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      const h = new Headers();
      safeSet(h, 'content-type', 'application/xml;charset=utf-8', notes);
      const meta = (got && got.metadata) || null;
      if (meta && meta.uploadedAt) safeSet(h, 'etag', etagOf(value, meta.uploadedAt), notes);
      safeSet(h, 'content-length', String(byteLen(value)), notes);
      safeSet(h, 'cache-control', 'no-store', notes);
      if (notes.length) safeSet(h, 'x-proxy-notes', notes.join(' | '), notes);
      return new Response('<?xml version="1.0"?><multistatus xmlns="DAV:"/>', { status: 207, headers: h });
    }

    /* --- DELETE --- */
    if (method === 'DELETE') {
      await kv.delete(key);
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }

    /* --- OPTIONS --- */
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'cache-control': 'no-store', 'dav': '1,2', 'allow': 'GET,HEAD,PUT,DELETE,PROPFIND,OPTIONS' }
      });
    }

    return json({
      error: 'method not allowed: ' + method,
      allowed: ['GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'OPTIONS'],
      hint: '工作台只需要 GET / PUT / PROPFIND。'
    }, 405, notes);
  } catch (e) {
    return json({
      error: 'kv operation failed',
      detail: 'KV 读写出错。命名空间已绑定，问题多半出在权限、key 或数据量上。',
      method: method,
      key: key,
      notes: notes,
      exception: errInfo(e)
    }, 500, notes);
  }
}

/* ---------- 入口：全局兜底 ----------
   任何漏网异常都变成带 message + stack 的 JSON，绝不裸崩成 520。 */
export async function onRequest(context) {
  try {
    return await handle(context || {});
  } catch (e) {
    return json({
      error: 'unhandled exception',
      detail: '代理内部抛出未捕获异常。把下面这段完整内容贴给开发者即可定位。',
      url: context && context.request && context.request.url,
      method: context && context.request && context.request.method,
      exception: errInfo(e)
    }, 500);
  }
}


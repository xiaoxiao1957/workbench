/* ============================================================================
 * /api/ai —— 统一 AI 网关（模型注册表 + 多通道降级 + 与 webdav 一致的鉴权）
 * ============================================================================
 *
 * 【这个文件解决什么问题】
 *   以前如果想换个模型，要在业务代码里搜模型名字符串逐个改。
 *   这里改成「注册表 + 统一网关」：模型是数据，不是代码。
 *   以后加一个模型 = 往 MODELS 数组加一项（需要 Key 的再加一个环境变量），
 *   业务代码（前端 /api/ai 调用方）一个字都不用动。
 *
 * 【调用方式】
 *   POST /api/ai
 *     { scene:'title', prompt:'帮我想 5 个标题', prefer:'cf-glm47', fallback:'zhipu-glm47' }
 *   返回
 *     { ok:true, text:'...', model:'cf-glm47', provider:'cloudflare', estNeurons:20, degraded:false }
 *
 *   GET  /api/ai?op=models   → 可用模型列表（前端下拉从这里自动生成，永远和后端同步）
 *   GET  /api/ai?diag=1      → 自检（谁配了、谁没配、谁能用；不回显任何密钥内容）
 *   GET  /api/ai?diag=1&probe=1 → 在上面基础上真跑一次最小请求，验证链路
 *
 * 【设计约定】
 *   1. 业务代码里禁止出现具体模型名 —— 只传 scene 和（可选的）模型 id
 *   2. 未配置 Key 的模型自动置为不可用，不报错、不连坐其他模型
 *   3. 任何情况下都不抛异常到边缘：全部失败也返回结构化 JSON + 友好文案
 *   4. 响应头 ASCII 净化 + 全局 try/catch —— 非 ASCII 响应头会让 CF 边缘直接回 520，
 *      而且代码一步都不抛、任何 try/catch 都抓不到（这个坑在 webdav 那轮踩过）
 *   5. 不设置 www-authenticate —— 会让浏览器弹原生登录框并挂住请求
 *
 * 【不动的东西】
 *   functions/api/webdav/[[path]].js（KV 同步）一行未动；sw.js 一行未动。
 *   两者是两条独立路由，且 sw.js 早已对 /api/ 全部 pass-through，无需改动。
 * ========================================================================== */

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/* 总预算 50 秒。主力与备用各走各的计时，不共用 30 秒 ——
   否则主力耗掉 25 秒后才失败，备用只剩 5 秒，必然也超时，等于没有兜底。 */
const TIMEOUT_PRIMARY_MS = 20000;
const TIMEOUT_FALLBACK_MS = 25000;

/* 单次请求允许的最大输入字符数（按字节算，中文一个字 3 字节） */
const MAX_INPUT_BYTES = 40000;

/* ---------------------------------------------------------------------------
 * 一、模型注册表
 * ---------------------------------------------------------------------------
 * 以后新增模型：只往这个数组加一项。字段说明：
 *   id       前端下拉用的稳定标识（改了要同步前端设置里已存的偏好，别乱改）
 *   name     下拉里显示的中文名
 *   provider 'cloudflare' | 'zhipu' | 任何其他已在 PROVIDERS 里注册的适配器名
 *   modelId   provider 认识的模型名
 *   endpoint 仅外部 HTTP  provider 需要
 *   needsKey  true 表示必须配 envVar 指定的环境变量，否则自动置为不可用
 *   envVar    needsKey 时读哪个环境变量
 *   ctx       上下文窗口（前端可用来提示"这条内容超长了"）
 *   tier      'fast' | 'long'，仅前端展示用
 *   priceIn / priceOut   每百万 token 消耗多少 Neurons（用于估算额度）
 *                         不走 Neurons 计费的 provider 填 null
 */
const MODELS = [
  {
    id: 'cf-glm47',
    name: 'Cloudflare GLM-4.7-Flash（快，推荐）',
    provider: 'cloudflare',
    modelId: '@cf/zai-org/glm-4.7-flash',
    needsKey: false,
    ctx: 131072,
    tier: 'fast',
    priceIn: 5500,
    priceOut: 36400,
    note: '免费层，约 2.5 秒返回，每天 1 万 Neurons 大约能跑几百次轻量请求'
  },
  {
    id: 'cf-llama31',
    name: 'Cloudflare Llama-3.1-8B（备用）',
    provider: 'cloudflare',
    modelId: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    needsKey: false,
    ctx: 131072,
    tier: 'fast',
    priceIn: 4119,
    priceOut: 34868,
    note: '免费层，主力挂了或超额时的第二道 CF 防线，不需要额外配 Key'
  },
  {
    id: 'zhipu-glm47',
    name: '智谱 GLM-4.7-Flash（200K 长上下文）',
    provider: 'zhipu',
    modelId: 'glm-4.7-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    needsKey: true,
    envVar: 'ZHIPU_KEY',
    ctx: 200000,
    tier: 'long',
    priceIn: null,
    priceOut: null,
    note: '需配置环境变量 ZHIPU_KEY。限 1 并发、响应 15-25 秒，适合超长上下文兜底'
  }
];

/* ---------------------------------------------------------------------------
 * 二、场景表：每个场景的输出上限 + 系统提示词
 * ---------------------------------------------------------------------------
 * max_tokens 必须封顶：GLM-4.7-Flash 输出单价 36400 Neurons/百万 token，
 * 是输入的 6.6 倍。不封顶的话一个"详细攻略"可能单次烧掉 300+ Neurons，
 * 一天 1 万额度跑不了几十次。
 */
const SCENES = {
  title: {
    label: '标题 / 标签',
    max_tokens: 150,
    system: '你是标题与标签助手。输出只要结果，不要解释、不要前缀、不要序号说明。标题简短有力，标签用逗号分隔。'
  },
  polish: {
    label: '润色笔记',
    max_tokens: 800,
    system: '你是中文写作润色助手。保留原意与作者语气，只改通顺度、结构与错别字。直接输出润色后的正文，不要加点评。'
  },
  script: {
    label: '短视频脚本',
    max_tokens: 2500,
    system: '你是短视频脚本策划。输出结构：钩子（前 3 秒）→ 正文分镜 → 结尾引导。给出可照读的台词。'
  },
  guide: {
    label: '详细攻略',
    max_tokens: 4000,
    system: '你是攻略作者。输出分步骤、可执行的详细内容，每步说明"做什么"和"为什么"。用 Markdown 小标题分节。'
  },
  plan: {
    label: '学习计划',
    max_tokens: 4000,
    system: '你是学习计划设计师。把目标拆成阶段性任务，给出每天可完成的具体动作与检查点。用 Markdown 分节。'
  }
};

/* ---------------------------------------------------------------------------
 * 三、小工具（与 webdav 那份同规格，独立实现以免改动 webdav）
 * --------------------------------------------------------------------------- */

/* 只保留可打印 ASCII：HTTP 头里出现非 ASCII，CF 边缘可能直接回 520，
   而 Worker 代码一步异常都不抛，任何 try/catch 都抓不到。 */
function asciiSafe(v) {
  return String(v).replace(/[^\x20-\x7e\t]/g, '?');
}

/* 安全写响应头
   ① 控制字符（\n \r \0）＝ 头注入风险 → 整个头丢弃，绝不改写成 '?' 放行
   ② 非法值被 Headers 拒绝 → 跳过并记 note，不连坐其他头 */
function safeSet(headers, name, value, notes) {
  if (value === null || value === undefined || value === '') return;
  const v = String(value);
  if (/[\r\n\0]/.test(v)) {
    if (notes) notes.push('dropped unsafe header "' + name + '": control characters');
    return;
  }
  try {
    headers.set(name, asciiSafe(v));
  } catch (e) {
    if (notes) notes.push('skipped invalid header "' + name + '": ' + (e && e.message || e));
  }
}

function byteLen(s) {
  try { return new TextEncoder().encode(s).length; } catch (e) { return String(s).length; }
}

function errInfo(e, extra) {
  const o = {
    name: (e && e.name) || 'Error',
    message: (e && e.message) || String(e),
    stack: String((e && e.stack) || '').slice(0, 1200)
  };
  if (extra) Object.assign(o, extra);
  return o;
}

function json(obj, status, notes, extraHeaders) {
  try {
    const h = new Headers();
    safeSet(h, 'content-type', JSON_CONTENT_TYPE, notes);
    safeSet(h, 'cache-control', 'no-store', notes);
    if (extraHeaders) {
      Object.keys(extraHeaders).forEach(function (k) { safeSet(h, k, extraHeaders[k], notes); });
    }
    if (notes && notes.length) {
      safeSet(h, 'x-proxy-notes', asciiSafe(notes.join(' | ').replace(/[\r\n\0]/g, ' ')).slice(0, 500), null);
    }
    return new Response(JSON.stringify(obj, null, 2), { status: status, headers: h });
  } catch (e) {
    return new Response(
      '{"error":"json build failed","message":' + JSON.stringify(String((e && e.message) || e)) + '}',
      { status: 500, headers: { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store' } }
    );
  }
}

/* 恒定时间比较，避免通过响应耗时逐字符猜密钥 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* 给一个 promise 套上超时。
   env.AI.run 不接受 signal，只能用 race —— 超时后底层请求仍在跑但结果被丢弃，
   这是可接受的：我们要的是"用户不用干等"，不是真的掐断上游。 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error(label + ' timeout after ' + ms + 'ms')); }, ms);
  });
  return Promise.race([promise, guard]).then(function (v) {
    clearTimeout(timer); return v;
  }, function (e) {
    clearTimeout(timer); throw e;
  });
}

/* ---------------------------------------------------------------------------
 * 四、鉴权（与 webdav 完全一致，复用同一个 SYNC_TOKEN）
 * ---------------------------------------------------------------------------
 *   env.SYNC_TOKEN 已配置 → 严格校验 x-sync-token / Authorization: Bearer
 *   env.SYNC_TOKEN 未配置 → 不鉴权（和 webdav 保持同一套行为，用户只需记一个密码）
 */
function checkAuth(request, env, notes) {
  const expected = env && env.SYNC_TOKEN;
  if (!expected) return null;
  /* 只有 Bearer scheme 才算密钥：前端为兼容保留了 Authorization: Basic <账号:密码>，
     不区分 scheme 会把"填过账号密码但没填密钥"误判成 403，而正确答案是 401。 */
  const authz = String(request.headers.get('authorization') || '');
  const bearer = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '') : '';
  const got = request.headers.get('x-sync-token') || bearer;
  if (!got) {
    return json({
      error: 'missing sync token',
      detail: '这个站点设了同步密钥（SYNC_TOKEN），但本次请求没带。',
      fix: '工作台 → 设置 → 云端同步 → 把「同步密钥」填进去，与 Pages 环境变量 SYNC_TOKEN 保持一致。AI 功能复用同一个密钥。',
      accepts: ['x-sync-token: <token>', 'Authorization: Bearer <token>']
    }, 401, notes);
  }
  if (!safeEqual(got, expected)) {
    return json({
      error: 'invalid sync token',
      detail: '同步密钥不对（AI 与云端同步复用同一个密钥）。',
      fix: '核对工作台里的「同步密钥」与 Pages 环境变量 SYNC_TOKEN 是否一字不差（注意别多复制空格）。',
      receivedLength: got.length
    }, 403, notes);
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 五、模型可用性：没配 Key 的模型自动置为不可用，不报错、不连坐
 * --------------------------------------------------------------------------- */
function modelStatus(m, env) {
  const st = { id: m.id, name: m.name, provider: m.provider, tier: m.tier, ctx: m.ctx, note: m.note || '' };
  if (m.provider === 'cloudflare') {
    /* Workers AI 走 binding，不需要 Key；但 binding 本身可能没配 —— 那是运行时才知道的，
       这里只标"需要 binding"，具体等真正调用时再降级提示。 */
    st.needsKey = false;
    st.keyConfigured = true;
    st.available = true;
    st.reason = 'Workers AI binding（无需 Key）';
  } else if (m.needsKey) {
    const v = env && env[m.envVar];
    st.needsKey = true;
    st.envVar = m.envVar;
    st.keyConfigured = !!v;
    st.available = !!v;
    st.reason = v ? '已配置 ' + m.envVar : '未配置环境变量 ' + m.envVar + ' → 自动置为不可用';
  } else {
    st.needsKey = false;
    st.keyConfigured = true;
    st.available = true;
    st.reason = '无需 Key';
  }
  return st;
}

/* ---------------------------------------------------------------------------
 * 六、响应归一化
 * ---------------------------------------------------------------------------
 * 各家返回格式五花八门，这里统一成 { text, usage }：
 *   Workers AI 老 text-generation：{ response: '...' }
 *   Workers AI 包了一层：        { result: { response: '...' } }
 *   OpenAI 兼容（智谱 / CF 新模型）：{ choices: [{ message: { content } }] }
 *   某些模型的流式尾包：          { response: { response: '...' } }
 *   纯字符串
 */
function normalizeOutput(raw) {
  if (raw == null) return { text: '', usage: null };
  if (typeof raw === 'string') return { text: raw.trim(), usage: null };

  let text = '';
  if (typeof raw.response === 'string') text = raw.response;
  else if (raw.result && typeof raw.result.response === 'string') text = raw.result.response;
  else if (raw.result && typeof raw.result === 'string') text = raw.result;
  else if (Array.isArray(raw.choices) && raw.choices.length) {
    const c = raw.choices[0] || {};
    if (c.message && c.message.content != null) text = String(c.message.content);
    else if (c.text != null) text = String(c.text);
    else if (c.delta && c.delta.content != null) text = String(c.delta.content);
  } else if (raw.output_text != null) text = String(raw.output_text);
  else if (raw.text != null) text = String(raw.text);

  const usage = raw.usage || (raw.result && raw.result.usage) || null;
  return {
    text: String(text || '').trim(),
    usage: usage && (usage.prompt_tokens != null || usage.completion_tokens != null)
      ? {
          input: usage.prompt_tokens || usage.input_tokens || 0,
          output: usage.completion_tokens || usage.output_tokens || 0
        }
      : null
  };
}

/* 按模型费率估算 Neurons。不走 Neurons 计费的 provider 返回 null。 */
function estNeurons(m, usage) {
  if (!usage || m.priceIn == null || m.priceOut == null) return null;
  const n = (usage.input / 1e6) * m.priceIn + (usage.output / 1e6) * m.priceOut;
  return Math.round(n * 100) / 100;
}

/* ---------------------------------------------------------------------------
 * 七、Provider 适配器
 * ---------------------------------------------------------------------------
 * 以后加一个新的服务商（比如腾讯混元）：在这里加一个同名适配器即可，
 * MODELS 里加一项指过去，业务代码零改动。
 */
const PROVIDERS = {
  /* Cloudflare Workers AI：走 binding，不需要 API Key */
  cloudflare: async function (m, messages, maxTokens, env, timeoutMs, notes) {
    if (!env || !env.AI || typeof env.AI.run !== 'function') {
      const e = new Error('workers_ai_binding_missing');
      e.code = 'BINDING_MISSING';
      throw e;
    }
    const raw = await withTimeout(
      env.AI.run(m.modelId, { messages: messages, max_tokens: maxTokens }),
      timeoutMs,
      'cloudflare ' + m.id
    );
    return normalizeOutput(raw);
  },

  /* 智谱 GLM：OpenAI 兼容的 HTTP 端点，需要 Bearer Key */
  zhipu: async function (m, messages, maxTokens, env, timeoutMs, notes) {
    const key = env && env[m.envVar];
    if (!key) {
      const e = new Error('missing env ' + m.envVar);
      e.code = 'KEY_MISSING';
      throw e;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
    try {
      const res = await fetch(m.endpoint.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model: m.modelId,                 /* 写死 glm-4.7-flash，绝不自动改成 flashx 等变体 */
          messages: messages,
          max_tokens: maxTokens,
          temperature: 0.7
        })
      });
      const body = await res.text();
      if (!res.ok) {
        const e = new Error('zhipu HTTP ' + res.status + ' ' + String(body).slice(0, 300));
        e.code = 'HTTP_' + res.status;
        e.status = res.status;
        throw e;
      }
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
      return normalizeOutput(parsed);
    } finally {
      clearTimeout(timer);
    }
  }
};

/* ---------------------------------------------------------------------------
 * 八、统一网关：业务代码只调这一个，永远不出现具体模型名
 * ---------------------------------------------------------------------------
 * 顺序：首选 → 备用 → 全部失败给友好提示（不抛异常）
 */
async function gateway(opts, env, notes) {
  const scene = SCENES[opts.scene] || null;
  if (!scene) {
    return {
      ok: false, status: 400,
      body: {
        error: 'unknown scene',
        detail: '场景「' + String(opts.scene) + '」不存在。',
        supported: Object.keys(SCENES)
      }
    };
  }

  const byId = {};
  MODELS.forEach(function (m) { byId[m.id] = m; });

  /* 候选顺序：前端指定的首选 → 前端指定的备用 → 注册表里第一个可用的（兜底再兜底） */
  const wanted = [opts.prefer, opts.fallback].filter(Boolean);
  MODELS.forEach(function (m) { if (wanted.indexOf(m.id) < 0 && modelStatus(m, env).available) wanted.push(m.id); });

  const messages = [
    { role: 'system', content: scene.system },
    { role: 'user', content: opts.prompt }
  ];

  const attempts = [];
  for (let i = 0; i < wanted.length; i++) {
    const m = byId[wanted[i]];
    if (!m) { attempts.push({ id: wanted[i], ok: false, error: 'unknown model id' }); continue; }

    const st = modelStatus(m, env);
    if (!st.available) {
      attempts.push({ id: m.id, provider: m.provider, ok: false, skipped: st.reason });
      continue;                              /* 没配 Key 就跳过，不报错、不连坐 */
    }

    const adapter = PROVIDERS[m.provider];
    if (!adapter) {
      attempts.push({ id: m.id, ok: false, error: 'no adapter for provider ' + m.provider });
      continue;
    }

    /* ★ 每个通道独立计时，不共用总预算。
       主力 20 秒、备用 25 秒 —— 备用慢是已知的（智谱 15-25 秒），
       共用 30 秒的话主力一慢备用就必然来不及。 */
    const budget = (i === 0) ? TIMEOUT_PRIMARY_MS : TIMEOUT_FALLBACK_MS;
    const t0 = Date.now();
    try {
      const out = await adapter(m, messages, scene.max_tokens, env, budget, notes);
      if (!out.text) {
        attempts.push({ id: m.id, provider: m.provider, ok: false, ms: Date.now() - t0, error: 'empty response' });
        continue;                            /* 空结果也算失败，换下一个 */
      }
      const usage = out.usage;
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          text: out.text,
          model: m.id,
          modelName: m.name,
          provider: m.provider,
          scene: opts.scene,
          sceneLabel: scene.label,
          maxTokens: scene.max_tokens,
          degraded: i > 0,                   /* true = 用的不是首选，前端可显示小字提示 */
          attempts: attempts,
          usage: usage,
          estNeurons: estNeurons(m, usage),
          ms: Date.now() - t0
        }
      };
    } catch (e) {
      attempts.push({
        id: m.id, provider: m.provider, ok: false, ms: Date.now() - t0,
        error: e && e.code ? e.code : ((e && e.message) || String(e))
      });
      if (notes) notes.push('ai fail ' + m.id + ': ' + String((e && e.message) || e).slice(0, 120));
    }
  }

  /* 全部失败 —— 结构化返回，不抛异常、不白屏 */
  const hasKeyIssue = attempts.some(function (a) { return a.skipped; });
  return {
    ok: false,
    status: 503,
    body: {
      error: 'ai_unavailable',
      detail: 'AI 暂时不可用，刚才试了 ' + attempts.length + ' 个通道都没成功。工作台其他功能不受影响。',
      fix: hasKeyIssue
        ? '有通道因为没配 Key 被跳过（见 attempts）。去 Pages 项目 → Settings → Environment variables 补上即可。'
        : '可能是当天 1 万 Neurons 额度用完了（每天 00:00 UTC 重置），或上游临时故障。稍后再试。',
      attempts: attempts
    }
  };
}

/* ---------------------------------------------------------------------------
 * 九、路由入口
 * --------------------------------------------------------------------------- */
export async function onRequest(context) {
  const notes = [];
  try {
    const request = context.request;
    const env = context.env || {};
    const url = new URL(request.url);

    /* CORS 预检：同源页面用不到，但本地调试与自定义域名场景会打过来 */
    if (request.method === 'OPTIONS') {
      const h = new Headers();
      safeSet(h, 'access-control-allow-methods', 'GET, POST, OPTIONS', notes);
      safeSet(h, 'access-control-allow-headers', 'content-type, x-sync-token, authorization', notes);
      safeSet(h, 'cache-control', 'no-store', notes);
      return new Response(null, { status: 204, headers: h });
    }

    /* 1) 模型列表：前端下拉从这里生成，以后加了新模型自动出现 */
    if (request.method === 'GET' && (url.searchParams.get('op') === 'models' || url.searchParams.get('op') === 'list')) {
      const list = MODELS.map(function (m) { return modelStatus(m, env); });
      return json({
        ok: true,
        models: list,
        scenes: Object.keys(SCENES).map(function (k) {
          return { id: k, label: SCENES[k].label, maxTokens: SCENES[k].max_tokens };
        }),
        defaults: { prefer: MODELS[0].id, fallback: MODELS[1] ? MODELS[1].id : MODELS[0].id },
        timeouts: { primaryMs: TIMEOUT_PRIMARY_MS, fallbackMs: TIMEOUT_FALLBACK_MS }
      }, 200, notes);
    }

    /* 2) 自检：谁配了、谁没配、谁能用。不回显任何密钥内容，只给长度 */
    if (url.searchParams.get('diag') === '1') {
      const out = {
        ok: true,
        diag: 'ai',
        aiBinding: {
          bound: !!(env && env.AI && typeof env.AI.run === 'function'),
          bindingName: 'AI',
          status: (env && env.AI && typeof env.AI.run === 'function') ? '✓ 已绑定' : '✗ 未绑定'
        },
        auth: {
          syncTokenConfigured: !!(env && env.SYNC_TOKEN),
          mode: (env && env.SYNC_TOKEN)
            ? '需要密钥：请求须带 x-sync-token 或 Authorization: Bearer'
            : '未设 SYNC_TOKEN → 不鉴权（与 webdav 一致）'
        },
        models: MODELS.map(function (m) {
          const st = modelStatus(m, env);
          st.keyLength = m.needsKey && env[m.envVar] ? String(env[m.envVar]).length : 0;
          return st;
        }),
        scenes: Object.keys(SCENES),
        timeouts: { primaryMs: TIMEOUT_PRIMARY_MS, fallbackMs: TIMEOUT_FALLBACK_MS },
        note: '密钥内容不会出现在任何响应里，这里只给长度'
      };

      /* &probe=1 → 真跑一次最小请求，验证链路通不通 */
      if (url.searchParams.get('probe') === '1') {
        const probe = await gateway({ scene: 'title', prompt: 'ping', prefer: MODELS[0].id }, env, notes);
        out.probe = probe.body;
        out.probeStatus = probe.status;
      }
      return json(out, 200, notes);
    }

    /* 3) 鉴权（未设 SYNC_TOKEN 时直接放行，与 webdav 同规格） */
    const denied = checkAuth(request, env, notes);
    if (denied) return denied;

    /* 4) 只接受 POST */
    if (request.method !== 'POST') {
      return json({
        error: 'method not allowed',
        detail: 'AI 接口只接受 POST。',
        usage: 'POST /api/ai  body: { scene, prompt, prefer?, fallback? }',
        tip: '想看可用模型用 GET /api/ai?op=models，想自检用 GET /api/ai?diag=1'
      }, 405, notes);
    }

    /* 5) 解析请求体 */
    let payload = null;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'invalid json', detail: '请求体不是合法 JSON。' }, 400, notes);
    }
    payload = payload || {};

    const prompt = String(payload.prompt || '').trim();
    if (!prompt) {
      return json({ error: 'missing prompt', detail: 'prompt 不能为空。' }, 400, notes);
    }
    const pb = byteLen(prompt);
    if (pb > MAX_INPUT_BYTES) {
      return json({
        error: 'prompt too long',
        detail: '输入太长了（' + pb + ' 字节），上限 ' + MAX_INPUT_BYTES + ' 字节。',
        fix: '删掉一部分再试。注意中文一个字算 3 字节。'
      }, 413, notes);
    }

    /* 6) 走网关 */
    const result = await gateway({
      scene: payload.scene || 'polish',
      prompt: prompt,
      prefer: payload.prefer,
      fallback: payload.fallback
    }, env, notes);

    const b = result.body || {};
    return json(b, result.status, notes, {
      'x-ai-provider': b.provider || 'none',
      'x-ai-model': b.model || '',
      'x-ai-degraded': b.degraded ? '1' : '0',
      'x-ai-scene': b.scene || ''
    });
  } catch (e) {
    /* 最后一道防线：任何漏网的异常都不允许变成裸 520 */
    return json({
      error: 'unhandled exception',
      detail: String((e && e.message) || e),
      info: errInfo(e)
    }, 500, notes);
  }
}


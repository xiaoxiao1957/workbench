/* =====================================================================
   个人全能工作台 · Service Worker（第三轮路径修正版）
   部署：与 index.html、manifest.webmanifest、icon-192.png、icon-512.png
        放在同一目录（站点根目录）
   说明：本项目是单文件 HTML，所有 CSS / JS 都已内联，
        因此这里只缓存页面本体 + manifest + 两个图标，
        不存在任何 css / js 子资源需要预缓存。
   ===================================================================== */

/* ① 缓存版本号 +1：本轮改了缓存清单（去掉 '/'、换成 index.html），
      必须升版，否则已安装的旧 SW 不会生效、老缓存也不会被清掉。 */
const CACHE_NAME = 'workbench-v2';

/* ③ 只缓存真实存在的 4 个文件。
      刻意不再包含 '/' —— 站点根目录页（目录列表 / 404）不是应用，
      缓存它会导致离线降级时返回错误页面。
      用相对路径：Service Worker 基于自身所在目录解析，根部署与子目录部署都能命中。 */
const STATIC_ASSETS = [
  'index.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png'
];

/* ② 离线降级时优先返回的主页面，与部署文件名保持一致 */
const APP_PAGE = 'index.html';

// ============ Install ============
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // addAll 整体失败会丢弃整批缓存，这里捕获后仅告警，保证 SW 仍能正常安装
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] 部分资源缓存失败（不阻断安装）:', err);
      });
    })
  );
  self.skipWaiting();
});

// ============ Activate ============
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      // 清理所有非当前版本的旧缓存
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => {
      // clients.claim() 放在 waitUntil 的 .then() 链内：
      // 确保旧缓存清理完成后才接管所有客户端，避免新旧缓存交接时的竞态
      return self.clients.claim();
    })
  );
});

// ============ Fetch ============
self.addEventListener('fetch', event => {
  const req = event.request;

  // 1) 非 GET 请求直接放行 —— 保护 WebDAV 云端同步的 PUT / POST / DELETE 不被拦截
  if (req.method !== 'GET') {
    return;
  }

  // 2) 跨域请求直接放行 —— WebDAV 服务在第三方域，同样不能被 SW 接管
  let sameOrigin = false;
  try {
    sameOrigin = new URL(req.url).origin === self.location.origin;
  } catch (e) {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      // 命中缓存：直接返回（离线可用 + 秒开）
      if (cached) {
        return cached;
      }

      return fetch(req).then(response => {
        // 运行时缓存：仅缓存同源 GET 的成功响应
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => {
        // 网络不可达：降级返回应用主页面，保证用户始终能看到应用界面
        // （而不是一个空白页或纯文本错误）
        return caches.match(APP_PAGE).then(app => {
          // 极端情况：主页面也没缓存过，再降级为纯文本提示，
          // 避免 respondWith 收到 undefined 而直接抛错导致导航失败
          return app || new Response(
            '网络未连接，且本地暂无离线缓存。请联网后重新打开一次本应用。',
            { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } }
          );
        });
      });
    })
  );
});

/* 说明：push / notificationclick 事件监听按第二轮指令暂不实现。
   原因：当前没有推送服务端，且 Service Worker 是 Worker 环境，
        没有 document / window / canvas，无法用 Canvas 动态生成通知图标。
   后续如需接入推送，图标应使用系统默认（省略 icon 参数）
        或引用真实图片文件 URL（如 '/icon-192.png'），切勿在 SW 中调用 Canvas。 */

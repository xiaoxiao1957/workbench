/* =====================================================================
   个人全能工作台 · Service Worker（第四轮：HTML 网络优先 + 通知点击）
   部署：与 index.html、manifest.webmanifest、icon-192.png、icon-512.png
        放在同一目录（站点根目录）
   说明：本项目是单文件 HTML，所有 CSS / JS 都已内联，
        因此这里只缓存页面本体 + manifest + 两个图标，
        不存在任何 css / js 子资源需要预缓存。
   ===================================================================== */

/* ① 缓存版本号：v2 → v3
      本轮把 HTML 主文档从「缓存优先」改为「网络优先」，
      必须升版，否则已安装的旧 SW 不会生效、老缓存也不会被清掉。 */
const CACHE_NAME = 'workbench-v3';

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

/* 同源判定：跨域请求（WebDAV 云端同步）一律不能被 SW 接管 */
function isSameOrigin(req){
  try{ return new URL(req.url).origin === self.location.origin }
  catch(e){ return false }
}

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

  /* 0) HTML 主文档走网络优先（必须放在最开头并 return）
     原因：缓存优先时，部署过程中产生的错误响应（500 / 目录列表 / 中间态页面）
           会被永久缓存，之后无论服务器多正常都优先返回那份坏缓存，
           表现为 ERR_FAILED、页面再也打不开，且普通标签页也会被拦截。
     做法：永远先走网络，成功后顺手更新缓存；只有断网时才回退缓存，离线能力不丢。
     额外加了同源判定：跨域的 WebDAV GET 即使 Accept 带 text/html 也不进这条分支，
           继续往下走到跨域放行逻辑，保证云同步不被拦截。 */
  if (isSameOrigin(req) &&
      (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') >= 0)) {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          // waitUntil 保证 SW 在写入完成前不会被回收
          event.waitUntil(
            caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {})
          );
        }
        return res;
      }).catch(() => {
        // 断网：先按原请求找缓存，再退回应用主页面
        return caches.match(req).then(c => {
          return c || caches.match(APP_PAGE);
        });
      })
    );
    return;
  }

  // 1) 非 GET 请求直接放行 —— 保护 WebDAV 云端同步的 PUT / POST / DELETE 不被拦截
  if (req.method !== 'GET') {
    return;
  }

  // 2) 跨域请求直接放行 —— WebDAV 服务在第三方域，同样不能被 SW 接管
  if (!isSameOrigin(req)) {
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

/* ============ 点击通知 ============ */
/* 点击通知：聚焦已有窗口，否则打开应用。
   注意：Service Worker 是 Worker 环境，没有 window / document / Canvas，
        不能在这里动态生成通知图标；如需图标，应引用真实图片文件 URL
        （如 '/icon-192.png'）或省略 icon 使用系统默认图标。 */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.url.indexOf('index.html') >= 0 && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('index.html');
    })
  );
});

/* 说明：push 事件暂不实现 —— 当前没有推送服务端，
   定时提醒全部由页面内的 NOTIFY 定时器触发（reg.showNotification）。 */

/**
 * Web Push handler logic for the elizaOS service worker (iOS 16.4+ installed
 * PWA target). Extracted from `sw.js` into a standalone, dependency-free module
 * so the notification-shaping, click-routing, and badge logic can be unit
 * tested without a live ServiceWorkerGlobalScope.
 *
 * `sw.js` loads this via `importScripts("/sw-push.js")`, which runs the IIFE
 * below and attaches `self.__elizaPush` (the pure helpers) so the SW's event
 * listeners can delegate to tested code. Tests import the same file into a
 * jsdom global with a stubbed `self`/`navigator` and assert `self.__elizaPush`.
 *
 * NO framework, NO build step — this file ships verbatim from `public/`.
 */

"use strict";

(function initElizaPush(scope) {
  /**
   * Default notification presentation. A push payload may override any of these;
   * missing/garbage fields fall back so a malformed push still renders something
   * sane rather than throwing inside the `push` event (which would drop it).
   */
  const DEFAULT_TITLE = "New message";
  const DEFAULT_ICON = "/logos/icon-192.png";
  const DEFAULT_BADGE = "/logos/badge-72.png";
  const DEFAULT_TAG = "eliza-message";

  /**
   * Defensively parse a PushMessageData into a plain object. iOS/APNs delivers
   * the VAPID-encrypted payload as bytes; `event.data.json()` throws on
   * non-JSON, and a compromised/misbehaving sender could deliver anything. Any
   * failure yields `{}` so the caller renders defaults instead of crashing.
   */
  function parsePushData(data) {
    if (!data) return {};
    try {
      if (typeof data.json === "function") {
        const parsed = data.json();
        return parsed && typeof parsed === "object" ? parsed : {};
      }
      if (typeof data.text === "function") {
        const text = data.text();
        if (!text) return {};
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : {};
      }
    } catch {
      // Malformed / non-JSON push — render defaults rather than drop.
      return {};
    }
    return {};
  }

  /**
   * Shape a parsed push payload into `showNotification(title, options)` args.
   *
   * Payload contract (all optional):
   *   { title, body, icon, badge, tag, renotify, requireInteraction, silent,
   *     badgeCount, data: { deepLink, conversationId, agentId, ... } }
   *
   * `tag` + `renotify` control coalescing: same-tag pushes replace the prior
   * notification (one bubble per conversation) and only re-alert when
   * `renotify` is true. The `data` blob is carried onto the notification so
   * `notificationclick` can route to the right conversation.
   */
  function buildNotification(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const src = p.data && typeof p.data === "object" ? p.data : {};

    const title =
      typeof p.title === "string" && p.title.trim() ? p.title : DEFAULT_TITLE;

    const data = {
      ...src,
      deepLink: typeof src.deepLink === "string" ? src.deepLink : undefined,
      conversationId:
        typeof src.conversationId === "string" ? src.conversationId : undefined,
      agentId: typeof src.agentId === "string" ? src.agentId : undefined,
    };

    const options = {
      body: typeof p.body === "string" ? p.body : "",
      icon: typeof p.icon === "string" ? p.icon : DEFAULT_ICON,
      badge: typeof p.badge === "string" ? p.badge : DEFAULT_BADGE,
      // Same-conversation pushes coalesce onto one bubble.
      tag: typeof p.tag === "string" && p.tag ? p.tag : DEFAULT_TAG,
      renotify: p.renotify === true,
      requireInteraction: p.requireInteraction === true,
      silent: p.silent === true,
      data,
    };

    return { title, options };
  }

  /**
   * Derive the app-badge count from a payload. Returns a non-negative integer
   * when the sender provides `badgeCount`, otherwise `null` (leave the badge
   * untouched — a push with no count shouldn't clobber an existing badge).
   */
  function badgeCountFromPayload(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const raw = p.badgeCount;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
    return Math.floor(raw);
  }

  /**
   * Set the app badge if the platform supports it and a count was provided.
   * Feature-detected + best-effort: `setAppBadge` rejects are swallowed so a
   * badge failure never breaks the push. No-op where unsupported (most desktop
   * browsers, older iOS).
   */
  function applyBadge(navigatorLike, count) {
    if (count === null || count === undefined) return Promise.resolve();
    const nav = navigatorLike;
    if (!nav || typeof nav.setAppBadge !== "function") return Promise.resolve();
    try {
      if (count <= 0 && typeof nav.clearAppBadge === "function") {
        return Promise.resolve(nav.clearAppBadge()).catch(() => {});
      }
      return Promise.resolve(nav.setAppBadge(count)).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /** Clear the app badge if supported. Best-effort / feature-detected. */
  function clearBadge(navigatorLike) {
    const nav = navigatorLike;
    if (!nav || typeof nav.clearAppBadge !== "function") {
      return Promise.resolve();
    }
    try {
      return Promise.resolve(nav.clearAppBadge()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Whether a same-origin app path is a safe root-relative navigation target
   * (mirrors `navigate-deep-link.ts` `isSafeDeepLink` for the SW context, which
   * cannot import the UI module). Only `/foo` (not `//host`) is allowed here;
   * absolute `http(s)://` targets are handled by `openWindow` directly and are
   * validated by the caller. Anything else is dropped.
   */
  function isSafeAppPath(path) {
    return (
      typeof path === "string" && path.startsWith("/") && !path.startsWith("//")
    );
  }

  /**
   * Resolve the navigation target for a clicked notification. Prefers an
   * explicit `deepLink`, else builds `/?conversation=<id>&agent=<id>` from the
   * carried ids, else falls back to the app root. Returns an app-root-relative
   * URL string (never a foreign origin — a push can't redirect the app away).
   */
  function resolveClickTarget(notificationData, origin) {
    const d =
      notificationData && typeof notificationData === "object"
        ? notificationData
        : {};

    if (isSafeAppPath(d.deepLink)) {
      return d.deepLink;
    }

    if (typeof d.conversationId === "string" && d.conversationId) {
      const params = new URLSearchParams();
      params.set("conversation", d.conversationId);
      if (typeof d.agentId === "string" && d.agentId) {
        params.set("agent", d.agentId);
      }
      return `/?${params.toString()}`;
    }

    return "/";
  }

  /**
   * Focus an already-open client for the target path (if any) and post it a
   * navigate message; otherwise open a new window. Returns a promise.
   *
   * `clientsLike.matchAll` + `openWindow` are the injectable seams. A focused
   * client is told to navigate in-app (SPA route change) rather than a hard
   * reload; the message shape matches what the page's SW message listener reads.
   */
  function focusOrOpen(clientsLike, targetPath, origin) {
    const clients = clientsLike;
    if (!clients || typeof clients.matchAll !== "function") {
      return Promise.resolve(null);
    }
    const absoluteTarget = safeAbsolute(targetPath, origin);

    return clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        const list = Array.isArray(windowClients) ? windowClients : [];
        for (const client of list) {
          if (!client) continue;
          // Reuse any same-origin window rather than spawning a new one.
          const sameOrigin = isSameOrigin(client.url, origin);
          if (sameOrigin) {
            const focus =
              typeof client.focus === "function"
                ? client.focus()
                : Promise.resolve(client);
            if (typeof client.postMessage === "function") {
              client.postMessage({
                type: "eliza:push-navigate",
                path: targetPath,
              });
            }
            return Promise.resolve(focus).catch(() => client);
          }
        }
        if (typeof clients.openWindow === "function" && absoluteTarget) {
          return clients.openWindow(absoluteTarget);
        }
        return null;
      });
  }

  function isSameOrigin(url, origin) {
    if (typeof url !== "string") return false;
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  }

  /** Resolve an app-relative path against origin; drop anything unsafe. */
  function safeAbsolute(path, origin) {
    if (!isSafeAppPath(path)) return `${origin}/`;
    try {
      return new URL(path, `${origin}/`).toString();
    } catch {
      return `${origin}/`;
    }
  }

  const api = {
    DEFAULT_TITLE,
    DEFAULT_ICON,
    DEFAULT_BADGE,
    DEFAULT_TAG,
    parsePushData,
    buildNotification,
    badgeCountFromPayload,
    applyBadge,
    clearBadge,
    resolveClickTarget,
    focusOrOpen,
    isSafeAppPath,
  };

  // Attach to the SW global for `sw.js`; also export for CommonJS/ESM test envs.
  if (scope) scope.__elizaPush = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : undefined);

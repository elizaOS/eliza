# Isolate app views so backgrounds and global state cannot leak across surfaces

## Problem

Views are currently rendered into a shared app surface, and background behavior is resolved per route/view. Some views intentionally share the launcher background, while others are opaque. The visible result is inconsistent, and the architectural result is too much global coupling: a view can visually or behaviorally affect the rest of the app.

Screenshots:

- Settings on orange launcher background: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-settings.png`
- Settings Wallet & RPC with raw backend failure on shared orange background: `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-settings-wallet-rpc.png`
- Apps/launcher on shared orange background: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-apps.png`
- Browser opaque surface: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-browser.png`
- Browser active tab state: `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-browser-example-tab.png`
- Wallet opaque surface: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-inventory.png`
- Partial plugin capture with host API failure noise: `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-views/contacts-gui.png`
- Plugin route fallback/global-background debug capture: `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-view-sweep/debug-contacts-seeded.png`
- Plugin sweep manifests: `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-view-sweep/desktop-plugin-view-sweep.json`, `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-view-sweep/mobile-plugin-view-sweep.json`

## Code Evidence

- `packages/ui/src/App.tsx` mounts `AppBackground` at the shell root.
- `resolveActiveScreenBackgroundPolicy(...)` in `packages/ui/src/App.tsx` decides whether each route/view is `shared` or `opaque`.
- Dynamic/remote views are rendered through `DynamicViewLoader` inside the same shell tree.
- The background event channel is globally mounted via `AppBackground`.
- Registered plugin views in the visual harness share the host API/websocket surface; without the API server, the views repeatedly emit Vite-proxied `502 Bad Gateway` and websocket connection-refused diagnostics instead of rendering through an intentional offline/capability boundary.
- Wallet & RPC also leaks backend availability as a raw `HTTP 502` panel inside settings. This is the same boundary problem in a built-in normal view: a child capability failure is exposed as infrastructure text instead of a shell-brokered offline state.
- The bounded registered-plugin sweep accounted for all 55 plugin view cases at desktop and mobile. Desktop recorded 52 screenshots / 3 capture errors; mobile recorded 42 screenshots / 13 capture errors. Many early captures painted only the shared orange background. Direct seeded debug capture of `/contacts` showed the route rendering the home/launcher surface under the `/contacts` URL while the global body/html background stayed orange.

## Research Notes

- Electron documents `WebContentsView` as an embed option for additional web content; `BrowserView` is deprecated in favor of `WebContentsView`: https://electronjs.org/docs/latest/api/browser-view and https://electronjs.org/docs/latest/tutorial/web-embeds
- MDN warns that sandboxed iframes with both `allow-scripts` and `allow-same-origin` on same-origin content are not meaningfully sandboxed: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- Android WebView supports multiprocess renderer behavior and renderer-priority handling: https://developer.android.com/develop/ui/views/layout/webapps/managing-webview
- Android WebView security guidance says modern WebView renderer isolation separates renderer process from the host app: https://android-developers.googleblog.com/2017/06/whats-new-in-webview-security.html
- Apple exposes `WKWebView` and `WKProcessPool`; process pool selection controls which web views may safely share process space: https://developer.apple.com/documentation/webkit/wkwebview and https://developer.apple.com/documentation/webkit/wkprocesspool

## Proposed Direction

Define a cross-platform view-surface architecture:

- **Desktop:** normal app views should open as managed app windows or isolated view surfaces where appropriate. For embedded multi-view layouts, prefer a native child web-content surface (`WebContentsView`/Electrobun equivalent) over arbitrary shared DOM for untrusted or heavy plugin views.
- **Web:** trusted built-in shell views can remain in-process. Plugin/dynamic/untrusted views should render in sandboxed iframes with a postMessage capability broker. Avoid same-origin `allow-scripts` + `allow-same-origin` unless the view is trusted and the sandbox is not being relied on for security.
- **Mobile:** view manager should treat major views as layered surfaces managed by the native shell when lifecycle/isolation matters. Independent WebViews/WKWebViews should use explicit process/storage-sharing policy.

## Acceptance Criteria

- Normal views cannot mutate root/body classes, app background, global CSS variables, storage, or navigation except through an explicit shell capability broker.
- Shared app wallpaper is restricted to Home/Launcher/Background and explicitly marked immersive views.
- Settings, Browser, Wallet, and other normal views default to opaque token backgrounds.
- Dynamic/plugin views have documented isolation levels: trusted in-process, sandboxed iframe, native webview/window, or fullscreen immersive.
- A view-surface manifest declares background policy, header policy, lifecycle policy, and capability grants.
- Add tests that navigate between shared-background and opaque views and assert that the prior view's background does not remain visible.
- Add a plugin-view offline-state test: when a granted capability/backend is unavailable, the view renders a bounded local failure state rather than leaking host proxy/websocket errors through the shared surface.
- Add a built-in capability offline-state test for Wallet & RPC/browser bridge/wallet data so normal views show product-grade recovery copy when a backend capability is unavailable.
- Add a plugin route-readiness test that fails if a registered route paints only the global background or falls back to launcher/home content.

## Evidence Gaps

This issue is grounded in route screenshots, code inspection, a partial plugin-view capture, and a bounded registered-plugin sweep. It still needs a runtime mutation test that intentionally has a view attempt to modify global background/root state and verifies the shell blocks or scopes it. Plugin happy-path UX coverage also needs a clean API-backed/offline-capability-clean capture because several sweep records are fallback/background evidence rather than intended plugin content.

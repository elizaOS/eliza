# @elizaos/capacitor-browser-surface

`ElizaSurfaceManager` — the native Capacitor plugin that layers one **isolated
native web surface per Browser tab** on the mobile shell (issue #15245, deferred
from #14181, parent epic #13452).

The Browser view hosts arbitrary third-party web content. On desktop it embeds an
Electrobun `WebContentsView` (its own renderer process). On the web it degrades to
a sandboxed iframe. On a **native mobile shell** an in-realm iframe would still
share the host WebView's renderer process and storage partition — the exact
cross-surface leak the isolation epic closes. This plugin gives each tab its own
native child web surface instead:

- **iOS** — a `WKWebView` per surface. `isolated` process ⇒ a fresh
  `WKProcessPool` (distinct content process); `isolated` storage ⇒
  `WKWebsiteDataStore.nonPersistent()` (its own cookies/localStorage/IndexedDB).
  `shared` reuses a plugin-owned pool / the default store.
- **Android** — a `WebView` per surface with the platform out-of-process
  renderer; `isolated` storage ⇒ its own androidx.webkit multi-profile
  `Profile`. If the system WebView is too old for multi-profile, `createSurface`
  **rejects** (fail-fast) rather than silently sharing the default store.

## Explicit-policy invariant

Every surface carries an **explicit** process + storage policy. `createSurface`
rejects when either field is absent — there is no implicit platform default,
because a defaulted storage partition is the leak this closes. The policy is
derived from the view's `SurfaceManifest` on the JS side
(`packages/ui/src/surface/native-surface-shell.ts` → `deriveSurfacePlacement`).

## Consumer

The renderer never imports this package directly. `@elizaos/ui`'s
`capacitor-native-surface-shell.ts` models the method set structurally and calls
it through the Capacitor `Plugins` registry under the jsName `ElizaSurfaceManager`;
`use-mobile-native-tab-surfaces.ts` drives one surface per Browser tab
(create → setBounds/navigate → foreground/background → destroy) on the
`native-mobile-webview` render path.

## Non-goals

- Desktop `WebContentsView` embedding (shipped in #14181).
- Wallet / EIP-1193 injection and the desktop `BROWSER_TAB_PRELOAD_SCRIPT` — mobile
  native surfaces ship isolation only.

## Testing

- `bun run test` — the web-fallback rejection tests (`src/web.test.ts`).
- Android `connectedAndroidTest` — cross-profile storage-isolation on a real
  emulator (`BrowserSurfaceIsolationInstrumentedTest`).
- The JS driver + placement + per-tab hook are unit-tested in `@elizaos/ui`
  (`src/surface/*.test.ts`, `src/surface-embedding.test.ts`).

# @elizaos/capacitor-browser-surface — agent guide

Native Capacitor plugin `ElizaSurfaceManager`: layers one isolated native web
surface per Browser tab on the mobile shell (#15245). See `README.md` for the
product shape; this file is the contributor map.

## Layout

```
src/definitions.ts   Public API + types (the source of truth for both native impls)
src/index.ts         registerPlugin("ElizaSurfaceManager", { web })
src/web.ts           Web fallback — every method REJECTS (web has no native surface)
src/web.test.ts      Proves the web fallback rejects
ios/Sources/BrowserSurfacePlugin/BrowserSurfacePlugin.swift   WKWebView pool + data store
android/src/main/.../BrowserSurfacePlugin.kt                  WebView + androidx.webkit Profile
android/src/androidTest/.../BrowserSurfaceIsolationInstrumentedTest.kt  cross-profile isolation
```

## Non-negotiable invariants

- **jsName is `ElizaSurfaceManager`** — the renderer's
  `capacitor-native-surface-shell.ts` looks it up by that exact name. Do not rename.
- **Explicit policy or reject.** `createSurface` MUST reject when `process` or
  `storage` is absent. No implicit platform default — a defaulted storage
  partition is the cross-surface leak this plugin exists to close.
- **Fail-fast, never silent-degrade.** If the platform cannot honour `isolated`
  (Android without multi-profile; no out-of-process renderer), `createSurface`
  rejects. It does not fall back to shared storage.

## Build / test

```bash
bun run --cwd plugins/plugin-native-browser-surface build
bun run --cwd plugins/plugin-native-browser-surface test        # web-fallback vitest
bun run --cwd plugins/plugin-native-browser-surface typecheck
# native: Android connectedAndroidTest; iOS XCTest on the App scheme.
```

Repo-wide rules (logger-only, error policy, comments) live in the root
`AGENTS.md`. Evidence standard is non-negotiable: native changes require
per-platform device/simulator capture — see the repo Definition of Done.

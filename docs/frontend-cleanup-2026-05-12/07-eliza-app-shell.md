# App Shell Architecture Cleanup Plan

**Date:** 2026-05-12  
**Scope:** Frontend bootstrapping, React root mount, provider tree, global state setup  
**Files Analyzed:**
- `/packages/app/src/` (9 files) — Eliza canonical app shell
- `/apps/app/src/` (7 files) — Milady consumer app shell
- Root vite configs, index.html, package.json

---

## Executive Summary

Two distinct app shells exist in parallel:

1. **Eliza canonical** (`/packages/app/`) — the reference implementation
2. **Milady consumer** (`/apps/app/`) — a branded fork that imports from `@elizaos/app-core` (published packages)

The shells are **intentionally separate**: Milady is a consumer app that must work with published Eliza packages, while the Eliza shell includes in-tree plugins (`@elizaos/ui`, deep tree imports). However, there is **significant code duplication** in platform initialization, deep-link handling, and native plugin setup that should be factored into a shared bootstrap module in `@elizaos/ui` or a new `@elizaos/app-bootstrap` package.

**Render telemetry hook location:** `mountReactApp()` in both shells, after `createRoot(rootEl).render()` completes.

---

## 1. Bootstrap Order & Provider Tree

### React Mount Order

Both shells follow the same pattern:

```tsx
// Both shells:
createRoot(rootEl).render(
  <ErrorBoundary>
    <StrictMode>
      <AppProvider branding={APP_BRANDING}>
        {/* conditional routing logic: phone companion, detached shell, app window, or main app */}
      </AppProvider>
    </StrictMode>
  </ErrorBoundary>
)
```

**Key observations:**

- **ErrorBoundary** wraps everything (imported from `@elizaos/ui` in Eliza, `@elizaos/app-core` in Milady)
- **StrictMode** active in both (development double-invoke aware)
- **AppProvider** (from `@elizaos/ui` / `@elizaos/app-core`) supplies the theme and boot config
- Router logic **outside** AppProvider in Eliza (`DesktopSurfaceNavigationRuntime`, `DesktopTrayRuntime`, main `App`)
- Router logic **inside** AppProvider in Milady (includes `DesktopOnboardingRuntime`)

**Issue:** Eliza mounts `DesktopSurfaceNavigationRuntime` and `DesktopTrayRuntime` at the **same level as App**, meaning they're not wrapped by AppProvider's context. Milady wraps `DesktopOnboardingRuntime` inside AppProvider. This is inconsistent and may cause context-related bugs in Eliza when those runtimes try to consume app state.

---

### Global State Setup Before React

Both shells set up boot config and platform state **synchronously before mountReactApp()**:

```typescript
// Both shells:
1. setBootConfig(appBootConfig)  // branding, defaults, middleware, plugins
2. setupPlatformStyles()          // CSS variables for safe areas, platform classes
3. applyBuildTimeIosConnection()  // optional: inject dev API base for mobile
4. initializePlatform()           // async: capacitor bridge, listeners, device agent
5. mountReactApp()
```

This is sound, but **late initialization** (after React mount) includes:
- Desktop shortcut registration (`Desktop.registerShortcut`)
- Tray menu setup (`Desktop.setTrayMenu`)
- Mobile device bridge (`initializeMobileDeviceBridge`)
- Background runner config (`configureMobileBackgroundRunner`)

These fire in async tasks and can race with React render. Should be pre-flight checked and logged.

---

## 2. Shell Parity & Duplication

### Files in Sync (No Duplication Risk)

| File | Eliza | Milady | Status |
|------|-------|--------|--------|
| **app-config.ts** | 11 lines | 11 lines | ✓ identical |
| **character-catalog.ts** | 6 lines | 6 lines | ✓ identical (different import source: `@elizaos/shared` vs `@elizaos/shared/onboarding-presets`) |
| **env-prefix.js / .ts** | JS shim + TS decl | TS only | minor — Eliza exports normalizer, Milady defines inline |

### Critical Differences in main.tsx

| Aspect | Eliza | Milady | Issue |
|--------|-------|--------|-------|
| **App import** | `@elizaos/ui` | `@elizaos/app-core` | Different packages, unavoidable |
| **Phone companion** | `PhoneCompanionApp()` | `<CompanionShell tab="companion" />` | Different API; Milady also stubs this in `optional-eliza-app-stub.tsx` |
| **Desktop runtimes** | `DesktopSurfaceNavigationRuntime` + `DesktopTrayRuntime` (outside AppProvider) | `DesktopOnboardingRuntime` + `DesktopSurfaceNavigationRuntime` + `DesktopTrayRuntime` (inside AppProvider) | **Asymmetry**: Eliza missing `DesktopOnboardingRuntime`; context wrapping differs |
| **Side-effect imports** | ~20 imports registering plugins | ~14 imports (includes Milady-specific excludes) | Intentional branding difference; Milady excludes `app-babylon`, includes `app-screenshare` and `@clawville/app-clawville` |
| **Status bar init** | Explicit `initializeStatusBar()` in platform setup | Moved into `main()` function before platform init | Minor diff; should standardize |
| **Self-hosted token** | N/A | **340–376**: Fragment (#token=...) bootstrap for self-hosted instances | Milady-only; prevents insecure query-param tokens; good practice |
| **Mobile agent tunnel** | N/A | **949–978**: `initializeMobileAgentTunnel()` for tunnel-to-mobile mode | Milady-only; Eliza lacks this runtime mode |
| **Runtime config** | Uses `IosRuntimeConfig` directly from env | Adds `mobileModeToIosRuntimeMode()` validation wrapper | Milady is safer; Eliza can skip invalid modes silently |
| **MiladyOS detection** | N/A | **183–186**, **230–237**: User-agent sniffing + conditional registration of system apps | Milady-only; smart platform detection |

**Duplication hot spots:**
1. **Deep-link handler** (`handleDeepLink`) — ~100 lines in both, identical structure, could be in `@elizaos/ui`
2. **Platform initialization** (`initializePlatform`) — ~30 lines, nearly identical, with platform-specific branches that could be config-driven
3. **Keyboard handling** (`initializeKeyboard`) — identical 20-line function
4. **App lifecycle** (`initializeAppLifecycle`) — identical ~50-line function
5. **Desktop shell setup** (`initializeDesktopShell`) — identical ~50 lines
6. **Device bridge client** — ~100 lines of logic duplicated, different structure (Eliza uses `Promise.all`, Milady sequential)

---

## 3. Logic That Should Move to @elizaos/ui

### Candidates for Shared Bootstrap Module

1. **Deep-link routing** (`handleDeepLink`, `getDeepLinkPath`, `setHashRoute`)
   - Both shells parse and route deep links identically
   - Should be `useDeepLinkRouter()` hook + sync URL handler in `@elizaos/ui`
   - Allows custom handlers to be registered via plugin system

2. **Platform initialization orchestration**
   - Move to a factory function: `createPlatformInitializer(config: PlatformConfig)`
   - Inject platform-specific handlers for Capacitor, desktop, etc.
   - Both shells could call: `await initializePlatform(platformConfig)`

3. **Keyboard event listeners** (`initializeKeyboard`)
   - Identical in both; belongs in `@elizaos/ui` as a hook or effect
   - Should be called from `AppProvider`'s `useEffect`

4. **App lifecycle listeners** (`initializeAppLifecycle`)
   - Parse and re-dispatch as app-level events (already done)
   - Should be in `AppProvider` itself

5. **Desktop shell registration** (`initializeDesktopShell`)
   - The shortcut and tray logic is Eliza-agnostic
   - Move to `@elizaos/ui/platform/desktop` module
   - Config-driven so consumers can customize

### Candidates for Conditional Inclusion (Stay in Shell)

1. **Device bridge client** — platform-specific, requires native plugins; keep in shell
2. **Mobile agent tunnel** — Milady-only, specific to on-device agent mode
3. **MiladyOS detection** — Milady-only branding
4. **Self-hosted token bootstrap** — Milady-only, good security feature but not canonical

---

## 4. Global State & Window Globals

### Legitimate Globals (Justified)

| Global | Usage | Justification |
|--------|-------|---|
| `window.__ELIZA_APP_API_BASE__` | Pre-inject API base before React mount | ✓ Desktop shells inject this for routing to local agent; necessary before AppProvider |
| `window.__ELIZA_APP_CHARACTER_EDITOR__` | Register CharacterEditor for ViewRouter lazy load | ✓ ViewRouter in app-core picks this up; avoids circular imports |
| `window.__ELIZA_APP_SHARE_QUEUE__` | Buffer share-target payloads | ✓ Web Share Target API pushes data before React loads; queue is drained on mount |
| `window.__MILADY_API_BASE__` | Milady variant of above | ✓ Branded key; allows multi-app testing |
| `window.__ELIZAOS_APP_BOOT_CONFIG__` | Pre-set boot config before React | ✓ Desktop shells may hydrate this instead of calling setBootConfig |

**Issue:** Eliza uses `BRANDED_WINDOW_KEYS` (generic pattern) with `Reflect.get/set` for flexibility; Milady uses direct assignment for some keys. Eliza's approach is safer and should be the pattern.

### No Anti-Patterns Found

- No polluting `window` with state that should live in React context
- No globals that leak render state
- All globals are **initialization channels**, not persistent state

---

## 5. Vite & Build Configuration

### eliza/packages/app/vite.config.ts (47,756 bytes)

**Key observations:**
- **Extensive Capacitor plugin handling** — stubs for native plugins when absent
- **Native module stub plugin** (`nativeModuleStubPlugin`) — generates shims for unavailable native packages
- **esbuild transpilation** — handles JSX in .mjs files and native modules
- **Inline env var replacement** — templates HTML with `__APP_NAME__`, `__APP_THEME_COLOR__`, etc.
- **Correct Tailwind setup** — uses `@tailwindcss/vite` (modern approach)
- **Asset base URL** — supports custom asset hosting (desktop, mobile with custom CDN)

**Issues:**
1. **No service worker or PWA config** — neither shell registers a service worker; PWA manifest exists but no offline caching logic
2. **No build-time render tracking setup** — no hook for telemetry instrumentation during build
3. **Content-Security-Policy** (in index.html) is permissive for dev — `'unsafe-eval'` + `'unsafe-inline'`; should tighten for production

### apps/app/vite.config.ts (77,730 bytes)

**Key observations:**
- **Larger** than Eliza because it includes monorepo dependency resolution
- **Local Eliza source detection** — checks if `/eliza` submodule exists, uses local source if available
- **Different React plugin** — uses `@vitejs/plugin-react-swc` (faster) vs Eliza's `@vitejs/plugin-react`
- **Stricter error handling** — `requireResolve()` throws instead of returning undefined

**Issues:**
1. **Indirect Eliza sourcing** — if local Eliza is absent, falls back to published `@elizaos/*` packages; builds may break if published packages are out of sync with Milady source
2. **Larger config size** suggests feature creep — should extract reusable config into a shared module

---

## 6. Service Worker & PWA Setup

**Finding:** Neither shell sets up a service worker.

Both `index.html` files include `<link rel="manifest" href="/site.webmanifest" />`, but:
- No `registerServiceWorker()` call in `main.tsx`
- No `public/sw.js` or similar
- No offline caching strategy

**Recommendation:** If offline support or PWA installation is intended, add:
```tsx
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
```
in `main()` after `mountReactApp()`, with a precaching manifest built by Vite.

---

## 7. Render Telemetry Hook Location

**Ideal location for root-level render tracking:**

```typescript
// In src/main.tsx, after mountReactApp() completes:
function mountReactApp(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  const root = createRoot(rootEl);
  root.render(
    <ErrorBoundary>
      <StrictMode>
        <AppProvider branding={APP_BRANDING}>
          {/* ... */}
        </AppProvider>
      </StrictMode>
    </ErrorBoundary>,
  );

  // TELEMETRY HOOK HERE:
  // - Mark "shell render complete" event
  // - Measure time from DOMContentLoaded to this point
  // - Register performance observer for Core Web Vitals
  // Example:
  if (typeof window !== 'undefined' && window.performance) {
    performance.mark('shell-render-complete');
    if (performance.measure) {
      try {
        performance.measure('shell-render', 'navigationStart', 'shell-render-complete');
      } catch { /* already measured */ }
    }
    // Dispatch custom event for telemetry subscribers:
    window.dispatchEvent(new CustomEvent('elizaShellRenderComplete'));
  }
}
```

**Why here:**
- React render is synchronous (even with Concurrent features enabled at app level)
- This marks the **exact moment** the shell tree is attached to the DOM
- Early enough to measure boot performance before user interaction
- Late enough that AppProvider context is set up

**Alternative:** Use React's `useEffect` at the top level of App/AppProvider to detect mount, but that runs **after** render and doesn't capture actual DOM paint time.

---

## 8. Cross-Cutting Findings & Action Items

### A. Asymmetrical Provider Wrapping (Eliza Issue)

**Current state:**
```tsx
// ELIZA: DesktopSurfaceNavigationRuntime OUTSIDE AppProvider
<AppProvider branding={APP_BRANDING}>
  {/* conditional routes */}
</AppProvider>
<DesktopSurfaceNavigationRuntime />  // ← No context!
<DesktopTrayRuntime />                 // ← No context!
```

**Milady:**
```tsx
<AppProvider branding={APP_BRANDING}>
  <DesktopOnboardingRuntime />  // ← Has context
  <DesktopSurfaceNavigationRuntime />  // ← Has context
  <DesktopTrayRuntime />         // ← Has context
</AppProvider>
```

**Fix:** Move Eliza's runtimes inside AppProvider, add `DesktopOnboardingRuntime` if it exists.

### B. Platform-Specific Configuration Leakage

Both shells hardcode platform checks (`isNative`, `isIOS`, `isAndroid`, `isDesktopPlatform()`) inline. Should extract to a config object:

```typescript
const PLATFORM_CONFIG = {
  supports: {
    capacitor: isNative,
    desktop: isDesktopPlatform(),
    mobile: isNative && (isIOS || isAndroid),
  },
  native: { isIOS, isAndroid, platform },
  // ... etc
};

await initializePlatform(PLATFORM_CONFIG);
```

### C. Milady's Safety Improvements (Should Port to Eliza)

1. **Self-hosted token in fragment** — prevents server logs from containing auth tokens
2. **Mobile runtime mode validation** — `mobileModeToIosRuntimeMode()` guards against invalid modes
3. **MiladyOS detection** — smart conditional registration based on user-agent

Eliza should adopt #1 and #2 at minimum.

### D. Character Editor Registration

Both shells register `CharacterEditor` on window **and** on branded keys:
```typescript
window.__ELIZA_APP_CHARACTER_EDITOR__ = CharacterEditor;
Reflect.set(window, BRANDED_WINDOW_KEYS.characterEditor, CharacterEditor);
```

This is redundant. Should consolidate to:
```typescript
function registerCharacterEditor(editor: typeof CharacterEditor): void {
  window.__ELIZA_APP_CHARACTER_EDITOR__ = editor;
  if (APP_ENV_PREFIX !== 'ELIZA') {
    Reflect.set(window, `__${APP_ENV_PREFIX}_CHARACTER_EDITOR__`, editor);
  }
}
```

---

## 9. Recommendations Summary

| Priority | Item | Owner | Effort |
|----------|------|-------|--------|
| **P0** | Fix Eliza's asymmetrical AppProvider wrapping | Eliza team | 1h |
| **P0** | Move render telemetry hook to shell both roots | Telemetry team | 2h |
| **P1** | Extract deep-link routing to `@elizaos/ui` | UI team | 4h |
| **P1** | Extract platform initialization factory | UI team | 6h |
| **P1** | Port Milady's safety improvements (token, validation) to Eliza | Eliza team | 2h |
| **P2** | Add service worker registration (if PWA support needed) | Web team | 3h |
| **P2** | Standardize keyboard/lifecycle listener initialization | UI team | 2h |
| **P2** | Extract Vite config reusables to shared module | Build team | 4h |
| **P3** | Document platform detection pattern for future shells | Docs | 1h |

---

## 10. Canonical Shell Definition

**Eliza** (`/packages/app/`) is the **canonical implementation**:
- Contains full tree of in-repo plugins
- Reference for feature parity
- Desktop-first (desktop runtimes included)

**Milady** (`/apps/app/`) is an **intentional consumer variant**:
- Uses published `@elizaos/*` packages
- Adds platform-specific optimizations (MiladyOS, tunnel mode)
- Stubs optional features for leaner builds (see `optional-eliza-app-stub.tsx`)

**Neither should die**, but their shared logic should be extracted.


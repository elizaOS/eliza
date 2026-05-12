# Frontend Cleanup Plan: `/packages/ui/src/` Misc Folder Structure (2026-05-12)

## Overview

This codebase contains **~730 TypeScript/TSX files** across `/packages/ui/src`, organized into folders handling routing, layouts, state management, platform abstractions, configuration UI, and utilities. The 155 targeted files represent the "remainder" after core components and pages are excluded.

### Scope Summary (by folder)
- **onboarding/** (16 files, ~3010 LOC) — Flow state machines and deep-link handling
- **layouts/** (14 files, ~502 LOC) — Workspace/chat panel layout primitives with responsive logic
- **platform/** (14 files, ~2335 LOC) — Platform detection (iOS/Android/desktop/web) with permission clients
- **config/** (14 files, ~2687 LOC) — Plugin config catalogs, UI specs, branding, boot config
- **utils/** (43 files, ~3742 LOC) — Formatting, asset URLs, desktop dialogs, streaming text, workflow JSON
- **widgets/** (7 files) — Chat widgets, registry
- **voice/** (7 files) — Voice chat and TTS integration
- **desktop-runtime/** (5 files, ~631 LOC) — Tray, window rendering, shutdown handling
- **content-packs/** (4 files) — Content pack loaders
- **terminal/** (3 files) — Terminal view and command registry
- **navigation/** (3 files) — Tab/navigation constants
- **lib/** (2 files) — Utility library (`cn()`, clipboard, misc helpers)
- **i18n/** (2 files) — Translation provider and context
- **chat/** (2 files, top-level) — Chat-scoped state and event subscriptions
- **types/** (1 file) — Type definitions
- **themes/** (1 file) — Theme application
- **stories/** (1 file) — Storybook/demo stories
- **slots/** (1 file) — Task coordinator slot injection
- **character/** (1 file, top-level) — Character helpers

**Root files**: `App.tsx`, `app-shell-{components,registry}.ts`, `browser.ts`, `build-variant.ts`, `character-catalog.ts`, `index.ts`, `onboarding-config.ts`, `shell-params.ts`, `styles.ts`

---

## High-Priority Deep Dives

### 1. App.tsx — Root Shell & Router (1,298 LOC, 646–1,299)

**What it does**: The application's entry point after auth. Routes all 25+ tab destinations. Manages mobile/desktop layout state, overlay apps, custom actions, and startup gates.

**Current structure**:
- Lines 1–105: Imports and lazy-load helper (`lazyNamedView`)
- Lines 107–169: Static imports (CharacterEditor, DatabasePageView, etc.) + true lazy boundaries (AppsPageView, BrowserWorkspaceView, etc.)
- Lines 184–262: Wallet chat helper (WalletChatGuideBody, WalletChatGuideActions)
- Lines 264–289: MobileChatSurfaceButton — a 26-line toggle button
- Lines 290–303: `buildWalletPageScopedChatPaneProps()` — helper returning an object
- Lines 305–423: `useIsPopout()`, `TabScrollView`, `TabContentView`, `useResolvedDynamicPage` — layout wrapper components
- Lines 425–449: `DynamicPluginPage` — lightweight plugin page renderer
- Lines 466–644: `ViewRouter` — 200-line switch statement dispatching to 25 views
- Lines 646–1,299: **`App()` function** — the meat (650 LOC)

**Problem areas**:

1. **650 LOC monolithic render function** (lines 646–1,299):
   - `const shellContent = useMemo(...)` spans **450 lines** (lines 925–1,175) with 25 conditional branches
   - Each branch duplicates Header/AppWorkspaceChrome/LazyViewBoundary patterns
   - The dependency array (`[CompanionShell, tab, uiShellMode, isCompanionTab, ...]`) has 24 items — hard to reason about when one changes
   - Mobile chat layout logic interleaved with settings/character/wallet/apps shells

2. **useState calls scattered throughout** (lines 717–757):
   - `customActionsPanelOpen`, `customActionsEditorOpen`, `settingsInitialSection`, `widgetsPanelCollapsed` — local UI state
   - `isChatMobileLayout`, `mobileChatSurface`, `desktopShuttingDown`, `characterHeaderActions`
   - No consolidation into a reducer; each has its own setter and localStorage sync logic (line 722–742)

3. **Multiple useEffect calls** (lines 689–899):
   - Line 689–715: Overlay presence reporting (25s interval)
   - Line 805–811: Custom actions panel toggle listener
   - Line 836–847: Focus connector event listener
   - Line 849–857: Window resize handler
   - Line 859–872: Mobile layout sync side effects
   - Line 874–879: Settings page cleanup
   - Line 881–889: Keyboard scroll disable (iOS)
   - Line 891–899: Desktop shutdown subscription
   - Line 904–920: Startup timeout watchdog
   - **No clear ownership** — each effect is isolated; state machine logic could be clearer

4. **Derived booleans** (lines 759–768):
   - `isCompanionTab`, `isChat`, `isChatWorkspace`, `isCharacterPage`, `isWallets`, `isHeartbeats`, `isSettingsPage`, `isAppsToolPage`, `isDesktopWorkspacePage`
   - All derived from `tab`; useMemo overhead is minimal but adds noise

5. **Mobile chat surface controls** (lines 769–801):
   - Complex useMemo computing left/right panel buttons with ternary chains
   - Dependency: `[isChat, isChatMobileLayout, mobileChatSurface, t]`

**What to extract**:
- **Shell view routers**: Split the 25-branch `shellContent` memoization into a separate component (e.g., `<ShellContent tab={tab} ... />`). It's 450 LOC and that giant switch/conditional block deserves its own file.
- **Mobile layout wrapper**: `<MobileChatLayout>` component to handle `mobileChatSurface`, `setMobileChatSurface`, resize tracking.
- **UI panel state**: Consolidate `customActionsPanelOpen`, `customActionsEditorOpen`, `widgetsPanelCollapsed` into a single `useUIState()` hook (or reducer).
- **ViewRouter optimization**: The `ViewRouter` function (lines 466–644) is only called from within `shellContent` and inside `DynamicPluginPage`. It's a 200-line nested component that could move to a separate file for testability.

**Metrics**:
- 24-item useMemo dependency array
- 9 useEffect calls
- 8 useState calls
- 450 LOC in a single useMemo block
- 25 tab routing branches (consider a routing table)

---

### 2. Onboarding Flow & State Machine (~/3,010 LOC across 16 files)

**What it does**: Multi-step wizard (deployment → providers → features). Coordinates cloud login, local agent detection, runtime mode selection, and API key setup.

**File breakdown**:
- `flow.ts` (141 LOC) — Pure step graph: `getStepOrder()`, `resolveOnboardingNextStep()`, `canRevertOnboardingTo()`
- `__tests__/flow.test.ts` (612 LOC) — Tests for flow logic
- `__tests__/deep-link-entry.test.ts` (354 LOC) — Deep link handler tests
- `__tests__/mobile-runtime-mode-hardening.test.ts` (397 LOC) — Mobile runtime mode tests
- `__tests__/sandbox-variant-detection.test.ts` (188 LOC) — Sandbox detection tests
- `deep-link-handler.ts` (211 LOC) — Deep link routing (`/onboarding?step=...`, `/pair?code=...`)
- `probe-local-agent.ts` (280 LOC) — Liveness probe for local agent on 127.0.0.1
- `probe-local-agent.test.ts` (131 LOC) — Probe tests
- `pre-seed-local-runtime.ts` (133 LOC) — Pre-seed local runtime with an agent
- `mobile-runtime-mode.ts` (119 LOC) — Detect if running on ElizaOS device or vanilla APK
- `mobile-runtime-mode.test.ts` (62 LOC) — Mobile mode tests
- `auto-download-recommended.ts` (121 LOC) — Auto-download recommendation logic
- `auto-download-recommended.test.ts` (93 LOC) — Auto-download tests
- `local-agent-token.ts` (92 LOC) — Token generation for local agent access
- `reload-into-runtime-picker.ts` (51 LOC) — Reload page into runtime selector
- `server-target.ts` (25 LOC) — Enum for server target (cloud/remote/local)

**Problem areas**:

1. **Onboarding state machine is split across AppContext + useOnboardingCallbacks + useOnboardingState**:
   - `useOnboardingState()` (461 LOC in `/state/`) — state vars like `onboardingStep`, `onboardingError`, `onboardingBusy`
   - `useOnboardingCallbacks()` (1,144 LOC) — handlers for step transitions, cloud login, provider detection
   - `useOnboardingCompat()` in AppContext — compatibility layer between old and new flow
   - No single place to see the state machine; requires cross-referencing 3 files

2. **Deep-link entry points are scattered**:
   - `deep-link-handler.ts` watches for `window.location.hash` changes (line 211)
   - `mobile-runtime-mode.ts` detects ElizaOS and triggers different UI (line 119)
   - `auto-download-recommended.ts` checks for stored download state
   - `installOnboardingDeepLinkListener()` is only called in app init; exported but rarely used

3. **Probe logic is tangled with detection logic**:
   - `probe-local-agent.ts` does HTTP retries + polling + exponential backoff (280 LOC)
   - `pre-seed-local-runtime.ts` assumes the probe succeeded, then downloads agent (133 LOC)
   - Called from `useOnboardingCallbacks`, but error handling is in the callback, not in the module

4. **Mobile runtime mode detection is overly defensive**:
   - Reads `ro.elizaos.product` from user-agent (line 6)
   - Falls back to checking if running on Android + checking for navigator (line 52)
   - Called from multiple places; no memoization of the check result

**What to consolidate**:
- **OnboardingMachine** — Create a separate file/module (`onboarding-machine.ts`) with:
  - State type: `{ step, provider, voiceProvider, cloudLoggedIn, detectedProviders, error, busy }`
  - Reducer: `(state, action) => newState`
  - Actions: `ADVANCE_STEP`, `REVERT_TO_STEP`, `SET_PROVIDER`, `SET_VOICE_PROVIDER`, `COMPLETE`, `ERROR`
  - Use this as the canonical "onboarding brain"
- **Platform/runtime detection** — Move `isElizaOS()`, `canRunLocal()`, `canHostLocalAgent()` into a single `usePlatformCapabilities()` hook with memoization
- **Deep-link router** — Consolidate `deep-link-handler.ts` + `reload-into-runtime-picker.ts` into one `onboarding-router.ts` that handles all entry points
- **Probe module** — Extract retry logic into a generic `httpProbeWithBackoff()` utility, leaving `probe-local-agent.ts` to be 50 LOC

**Metrics**:
- 3 separate files defining onboarding state (AppContext, useOnboardingState, useOnboardingCallbacks)
- 1,144 LOC in one callbacks hook
- 5+ entry points (deep link, mobile mode, cloud login, local agent, auto-download)
- No unified state machine; each file knows only its piece

---

### 3. Layouts & Layout Duplication (~/502 LOC across 14 files)

**What it does**: Two main layout systems (`WorkspaceLayout` for responsive sidebar + content, `ChatPanelLayout` for overlay chat), plus page-layout header/drawer wrappers.

**File breakdown**:
- `workspace-layout/workspace-layout.tsx` (176 LOC) — Main layout with responsive sidebar
- `workspace-layout/workspace-layout-types.ts` (22 LOC) — Props interface
- `workspace-layout/workspace-mobile-sidebar-controls.tsx` (19 LOC) — Mobile sidebar button (collapse/expand)
- `workspace-layout/index.ts` (3 LOC) — Re-export
- `chat-panel-layout/chat-panel-layout.tsx` (109 LOC) — Overlay chat container (full-overlay vs companion-dock variant)
- `chat-panel-layout/index.ts` (1 LOC) — Re-export
- `page-layout/page-layout.tsx` (6 LOC) — Thin wrapper
- `page-layout/page-layout-header.tsx` (16 LOC) — Optional header above main content
- `page-layout/page-layout-mobile-drawer.tsx` (81 LOC) — Mobile drawer logic (on/off, animation)
- `page-layout/page-layout-types.ts` (18 LOC) — Props interface
- `page-layout/index.ts` (4 LOC) — Re-export
- `content-layout/content-layout.tsx` (42 LOC) — Simple left/right split
- `content-layout/index.ts` (1 LOC) — Re-export
- `layouts/index.ts` (4 LOC) — Root barrel

**Problem areas**:

1. **Responsive logic duplicated across 3 layouts**:
   - `WorkspaceLayout.useWorkspaceLayoutDesktopMode()` (lines 18–53) — polls `window.matchMedia("(min-width: 820px)")`
   - `ChatPanelLayout.useMatchMedia()` (lines 15–44) — generic media query hook (nearly identical)
   - Both re-implement the same event listener cleanup (addEventListener vs. addListener fallback)
   - No shared hook; duplication of intent

2. **Mobile drawer state management scattered**:
   - `WorkspaceLayout` manages `mobileSidebarOpen` state (line 74)
   - `PageLayoutMobileDrawer` manages its own animation state (81 LOC with custom CSS transitions)
   - `App.tsx` manages `mobileChatSurface` ("left" | "center" | "right")
   - No single "mobile state" hook; each layout owns its own

3. **ChatPanelLayout has two entirely different renderers** (lines 61–80):
   - `isCompanionDock ? "absolute inset-0..." : "absolute inset-[max(1rem,6vh)...]"`
   - Two separate classNames branches with different border/shadow/blur styles
   - Could be extracted as `<CompanionDock>` vs. `<GameOverlay>` subcomponents

4. **No layout composition helpers**:
   - Wrapping layouts requires nesting: `<WorkspaceLayout><ChatPanelLayout><Content/></ChatPanelLayout></WorkspaceLayout>`
   - No `<TwoColumnLayout>` or `<ResponsiveLayout>` primitives; each layout is monolithic
   - Props interfaces are verbose (WorkspaceLayoutProps has 11+ optional fields)

**What to extract**:
- **useResponsiveMedia** — Consolidate `useWorkspaceLayoutDesktopMode()` + `useMatchMedia()` into a shared `useMediaQuery(breakpoint: string): boolean` hook (10 LOC). Both layouts use it.
- **MobileStateProvider** — A context for mobile layout state (`isMobileLayout`, `activeDrawer`, `setActiveDrawer`). Simplifies App.tsx's 9 mobile-related useState calls.
- **Companion dock vs. game overlay split** — Extract `ChatPanelLayout.tsx` into `<ChatPanelLayout variant="full-overlay" | "companion-dock">`, or split into two simpler components.
- **PageLayoutMobileDrawer cleanup** — The 81-line file is mostly CSS; consider moving animation classNames to a utility or CSS module.

**Metrics**:
- 2 implementations of responsive media query logic
- 3+ places managing mobile layout state (App, WorkspaceLayout, PageLayoutMobileDrawer)
- 11+ props on WorkspaceLayout interface
- 81 LOC for a mobile drawer (half of which is classNames)

---

### 4. Platform Abstraction (~/2,335 LOC across 14 files)

**What it does**: Detects platform (iOS/Android/desktop/web), manages permissions, handles runtime initialization.

**File breakdown**:
- `init.ts` (282 LOC) — Platform detection (Capacitor.getPlatform), runtime checks (isElizaOS, canRunLocal, canHostLocalAgent), share target dispatch
- `mobile-permissions-client.ts` (412 LOC) — iOS/Android permission request bridge (camera, microphone, etc.)
- `mobile-permissions-client.test.ts` (333 LOC) — Permission client tests
- `desktop-permissions-client.ts` (321 LOC) — Desktop permission request bridge
- `browser-launch.ts` (199 LOC) — Open URLs in system browser (Capacitor or fallback)
- `onboarding-reset.ts` (164 LOC) — Clear onboarding state for factory reset
- `cloud-preference-patch.ts` (141 LOC) — Patch cloud preferences (cloud only vs. local + cloud)
- `ios-runtime.ts` (127 LOC) — iOS-specific runtime setup (app lifecycle, keyboard, statusbar)
- `window-shell.ts` (122 LOC) — Window/frame detection (iframe vs. top-level, WebView detection)
- `android-runtime.ts` (65 LOC) — Android-specific runtime setup
- `types.ts` (57 LOC) — Platform-specific types (PermissionClientLike, RuntimeTarget)
- `empty-node-module.ts` (48 LOC) — Fallback for Node imports on browser platforms
- `index.ts` (45 LOC) — Re-exports
- `is-native-server.ts` (19 LOC) — Check if platform is native

**Problem areas**:

1. **Platform forks scattered across the codebase** (336 grep hits for platform checks):
   - 30+ files check `isNative`, `isIOS`, `isAndroid`, `isDesktop`, `isWebPlatform` directly
   - No abstraction layer; each consumer reimports from `platform/init.ts`
   - Examples:
     - `App.tsx` (line 75) imports `isIOS`, `isNative`
     - `MessageContent.tsx` checks `isNative` to decide on link handling
     - `RuntimeGate.tsx` checks `isDesktopPlatform()` to decide UI mode
     - `BrowserWorkspaceView.tsx` checks `isAndroid` for keyboard behavior
   - This is fine for 2–3 checks, but 336 hits suggests coupling

2. **Permission clients have overlapping logic**:
   - `MobilePermissionsClient` (412 LOC) — handles Capacitor plugins + fallback
   - `DesktopPermissionsClient` (321 LOC) — handles Electrobun IPC + fallback
   - Both define `PermissionId`, status enums, result types
   - No shared interface (abstract class or trait); each is standalone
   - Called from `PermissionsSection.tsx` via a platform check:
     ```tsx
     const client = isDesktop ? new DesktopPermissionsClient() : new MobilePermissionsClient()
     ```

3. **Runtime initialization is procedural, not declarative**:
   - `ios-runtime.ts` calls `Keyboard.setScroll()`, sets statusbar color
   - `android-runtime.ts` calls `StatusBar.show()`
   - Neither is imported; they're called from `useAppProviderEffects` or in `App.tsx` effects
   - No single `initializePlatform()` function; setup is scattered

4. **Cloud-only feature detection is fragmented**:
   - `cloud-only.ts` (19 LOC) just exports `CLOUD_ONLY_FEATURES` array
   - Checked in `config/app-config.ts`, `navigation/index.ts`, and various component files
   - No single place that says "this feature is cloud-only on this platform"

**What to consolidate**:
- **PermissionClient abstraction** — Create a `PermissionClient` interface that both mobile and desktop implement:
  ```tsx
  interface PermissionClient {
    getPermission(id: PermissionId): Promise<PermissionStatus>;
    requestPermission(id: PermissionId): Promise<PermissionStatus>;
  }
  ```
  Then a factory function: `getPermissionClient(): PermissionClient` that returns the right impl based on platform.
- **Platform capabilities hook** — `usePlatformCapabilities()` returning `{ isNative, isIOS, isAndroid, isDesktop, canRunLocal, ... }` so consumers don't re-import; they get it from context/hook.
- **Runtime init consolidation** — Move iOS + Android setup into a `initializeRuntime()` function called once at app boot (in AppProvider), not scattered across effects.
- **Feature flag centralization** — Expand `cloud-only.ts` into `feature-flags.ts` with `isFeatureAvailable(feature: string, platform: Platform): boolean`.

**Metrics**:
- 336 platform check calls across the codebase
- 2 nearly-identical permission client implementations (733 LOC combined)
- 3+ places checking `isDesktopPlatform()` for UI decisions
- No shared PermissionClient interface

---

### 5. Config Catalog & UI Specs (~/2,687 LOC across 14 files)

**What it does**: Plugin configuration form generation, UI spec rendering, branding management, boot config storage.

**File breakdown**:
- `config-catalog.ts` (1,072 LOC) — Field catalog, registry, visibility/validation logic (json-render pattern)
- `boot-config-store.ts` (480 LOC) — LocalStorage persistence of boot config
- `plugin-ui-spec.ts` (311 LOC) — Plugin-specific UI spec types and helpers
- `app-config.ts` (306 LOC) — App-level config structures
- `ui-spec.ts` (256 LOC) — Generic UI spec types (fields, actions, validation)
- `branding-base.ts` (90 LOC) — Branding defaults (colors, fonts, logos)
- `allowed-hosts.ts` (70 LOC) — Allowlist logic for API hosts
- `api-key-prefix-hints.ts` (35 LOC) — Hints for API key prefixes (sk-, pk-, etc.)
- `cloud-only.ts` (19 LOC) — Cloud-only features list
- `branding-react.tsx` (15 LOC) — React context for branding
- `boot-config-react.tsx` (12 LOC) — React context for boot config
- `index.ts` (14 LOC) — Re-exports
- `boot-config.ts` (5 LOC) — Getter/setter for boot config
- `branding.ts` (2 LOC) — Re-export

**Problem areas**:

1. **config-catalog.ts is doing too much** (1,072 LOC):
   - Lines 1–200: JSON Schema types and getByPath/setByPath utilities
   - Lines 200–400: Field catalog interfaces and validation logic
   - Lines 400–700: Registry definition and field resolution
   - Lines 700–1,072: Visibility expressions, logic evaluation, form validation
   - **No clear separation of concerns**; utility functions, type definitions, and form logic are all in one file
   - Could be split into:
     - `config-types.ts` — JSON Schema types, interfaces
     - `config-utils.ts` — getByPath/setByPath, visibility/validation helpers
     - `config-registry.ts` — Registry + field resolution
     - `config-catalog.ts` — Catalog definition only

2. **boot-config storage is verbose** (480 LOC in boot-config-store.ts):
   - Defines 20+ getter/setter pairs for individual fields (branding, lifeOpsPageView, etc.)
   - Each follows the same pattern:
     ```tsx
     export function getBootConfigFoo(): Foo | undefined {
       return getBootConfig().foo;
     }
     export function setBootConfigFoo(value: Foo): void {
       const config = getBootConfig();
       setBootConfig({ ...config, foo: value });
     }
     ```
   - Could be replaced by a generic `useBootConfigField<T>(key: keyof BootConfig)` hook
   - Alternatively, export the entire BootConfig and let consumers use it directly

3. **Branding is split across 3 files**:
   - `branding-base.ts` — default logo, colors, etc.
   - `branding-react.tsx` — React context (15 LOC, just a Context.Provider)
   - `branding.ts` — re-export (2 LOC, dead file)
   - `index.ts` imports and re-exports both
   - Could be consolidated into one `branding.ts` with both defaults and context

4. **UI spec types are scattered**:
   - `ui-spec.ts` — generic UI spec (UiElement, UiAction, UiComponentType)
   - `plugin-ui-spec.ts` — plugin-specific types (extends ui-spec)
   - `app-config.ts` — app-config structure (references ui-spec)
   - No clear type hierarchy; feels like an incremental build rather than a designed module

**What to refactor**:
- **Split config-catalog.ts**:
  - `config-types.ts` — JSON Schema types, interfaces (150 LOC)
  - `config-utils.ts` — getByPath, setByPath, utility functions (200 LOC)
  - `config-registry.ts` — Registry definition and resolution (300 LOC)
  - `config-catalog.ts` — Catalog definition only (100 LOC)
- **Boot config accessors** — Replace 20 getter/setter pairs with:
  ```tsx
  export function getBootConfigField<K extends keyof BootConfig>(key: K): BootConfig[K] | undefined {
    return getBootConfig()[key];
  }
  ```
  Or just export `getBootConfig()` and let callers do `getBootConfig().foo`
- **Consolidate branding** — Merge `branding-base.ts` + `branding-react.tsx` + `branding.ts` into one file
- **UI spec hierarchy** — Move `plugin-ui-spec.ts` types into `ui-spec.ts` or create a clearer inheritance tree

**Metrics**:
- 1,072 LOC monolithic file (config-catalog)
- 3 files for branding (35 LOC that could be 20)
- 20+ getter/setter pairs following the same pattern (480 LOC in boot-config-store)
- No clear separation of concerns between types, utils, and registry

---

## Per-Folder Summary

### onboarding/ (16 files, ~3,010 LOC)

**Status**: Mostly well-organized test coverage and pure logic.

**Issues**:
- Onboarding state machine split across AppContext + useOnboardingState + useOnboardingCallbacks
- Deep-link entry points scattered (flow.ts, deep-link-handler.ts, mobile-runtime-mode.ts)
- Probe + pre-seed logic tightly coupled to callbacks

**Action items**:
1. Consolidate onboarding state into a reducer (useOnboardingMachine.ts)
2. Unify deep-link router (onboarding-router.ts)
3. Extract probe retry logic into a reusable HTTP utility

---

### layouts/ (14 files, ~502 LOC)

**Status**: Cleanly structured but with responsive logic duplication and no state abstraction.

**Issues**:
- Two implementations of media query hook (useWorkspaceLayoutDesktopMode vs. useMatchMedia)
- Mobile layout state scattered across App, WorkspaceLayout, PageLayoutMobileDrawer
- ChatPanelLayout has two entirely different renders (companion-dock vs. full-overlay)
- Props interfaces are verbose; composition is nested

**Action items**:
1. Extract useMediaQuery hook
2. Create MobileLayoutProvider/context for shared mobile state
3. Split ChatPanelLayout into two simpler components or variant subcomponents
4. Simplify props interfaces with composition

---

### platform/ (14 files, ~2,335 LOC)

**Status**: Reasonable abstraction but permission clients lack interface and runtime init is procedural.

**Issues**:
- 336 direct platform checks across codebase (isNative, isIOS, isAndroid, etc.)
- MobilePermissionsClient + DesktopPermissionsClient have overlapping logic but no shared interface
- Runtime initialization is scattered (ios-runtime.ts, android-runtime.ts called from multiple places)
- Cloud-only feature detection in a separate 19-LOC file (cloud-only.ts)

**Action items**:
1. Create PermissionClient interface and factory function
2. Create usePlatformCapabilities() hook to reduce direct imports
3. Consolidate runtime init into initializePlatform()
4. Expand cloud-only.ts into a centralized feature-flags module

---

### config/ (14 files, ~2,687 LOC)

**Status**: Functional but monolithic and verbose.

**Issues**:
- config-catalog.ts is 1,072 LOC with no clear separation of types/utils/registry
- boot-config-store.ts has 20+ getter/setter pairs following identical patterns (480 LOC)
- Branding scattered across 3 files (35 LOC that could be 20)
- UI spec types lack a clear hierarchy

**Action items**:
1. Split config-catalog.ts into (types, utils, registry)
2. Replace boot-config getters/setters with a generic accessor
3. Consolidate branding into one file
4. Unify UI spec type hierarchy

---

### utils/ (43 files, ~3,742 LOC)

**Status**: Diverse utilities, mostly focused but some are trivial one-liners.

**Key files**:
- `desktop-workspace.ts` (369 LOC) — Desktop workspace management
- `documents-upload-image.ts` (215 LOC) — Image compression + upload
- `desktop-dialogs.ts` (191 LOC) — File/directory dialogs via Electrobun
- `character-message-examples.ts` (183 LOC) — Character message example parsing
- `workflow-json.ts` (181 LOC) — Workflow JSON serialization
- `assistant-text.ts` (180 LOC) — Assistant text formatting
- `format.ts` (173 LOC) — Date/time/duration/byte formatting
- `asset-url.ts` (168 LOC) — Asset URL resolution
- `streaming-text.ts` (162 LOC) — Streaming text accumulation + diffing

**Issues**:
- Large utility files (desktop-workspace at 369 LOC) could be split by concern
- Some trivial helpers (e.g., `rate-limiter.ts`, `cron-format.ts`) might be inlineable or better as a single utils module
- No clear organization; 43 files with no sub-grouping (e.g., desktop/ subfolder, formatting/ subfolder)

**Action items**:
1. Group related utilities: desktop/ (desktop-workspace, desktop-dialogs, desktop-bug-report), formatting/ (format, date, time), document/ (documents-upload-image, asset-url)
2. Review trivial utilities (<50 LOC) and consider consolidating into aggregate modules
3. Split large utilities (>250 LOC) by concern

---

### widgets/, voice/, desktop-runtime/, content-packs/, terminal/, navigation/, lib/, i18n/, chat/, types/, themes/, stories/, slots/, character/

**Status**: All small, mostly focused. No major cleanup needed.

- **widgets/** (7 files) — Chat widget registry and types; minimal
- **voice/** (7 files) — Voice chat and TTS; focused but hooks like useVoiceChat.ts are 1,774 LOC (should be split)
- **desktop-runtime/** (5 files, ~631 LOC) — Desktop tray, window rendering; reasonable size
- **content-packs/** (4 files) — Content pack loaders; simple
- **terminal/** (3 files) — Terminal view; minimal
- **navigation/** (3 files) — Tab constants and helpers; minimal
- **lib/** (2 files) — cn() utility, clipboard helpers; focused
- **i18n/** (2 files) — Translation provider; focused
- **chat/** (2 files, top-level) — Chat event subscription and state; minimal
- **types/** (1 file) — Type definitions; single file is fine
- **themes/** (1 file) — Theme application; single file is fine
- **stories/** (1 file) — Storybook; minimal
- **slots/** (1 file) — Task coordinator injection; minimal
- **character/** (1 file, top-level) — Character helpers; minimal

**One issue**: `voice/useVoiceChat.ts` (1,774 LOC) is massive and should be split into sub-hooks (synthesis, recognition, streaming, state management).

---

## Cross-Cutting Findings

### 1. Provider & Context Tree (App.tsx Bootstrap)

**Current stack** (lines 2714–2732 in AppContext.tsx):
```
<TranslationProvider>
  <AppBootContext.Provider>
    <BrandingContext.Provider>
      <CompanionSceneConfigCtx.Provider>
        <PtySessionsCtx.Provider>
          <ChatInputRefCtx.Provider>
            <ChatComposerCtx.Provider>
              <AppContext.Provider>
                {children}
                <ConfirmDialog>
                <PromptDialog>
              </AppContext.Provider>
            </ChatComposerCtx.Provider>
          </ChatInputRefCtx.Provider>
        </PtySessionsCtx.Provider>
      </CompanionSceneConfigCtx.Provider>
    </BrandingContext.Provider>
  </AppBootContext.Provider>
</TranslationProvider>
```

**Observations**:
- 8 nested providers; each adds a layer of indirection
- `AppContext` is the largest, containing 2,700+ LOC of state (chat, onboarding, plugins, wallet, etc.)
- No clear separation of concerns (UI chrome vs. chat state vs. plugin state)
- `PtySessionsCtx` is intentionally isolated (not passed in AppContext value) to avoid full re-renders on PTY changes
- `ConfirmDialog` + `PromptDialog` are modal singletons, not provider-based

**Recommended refactoring**:
1. **Split AppContext into smaller contexts**:
   - `UIShellContext` — tab, modals, sidebar state (App.tsx needs most of this)
   - `ChatContext` — conversations, messages, streaming state
   - `OnboardingContext` — step, provider, busy state
   - `PluginsContext` — plugins, skills, triggers
   - `WalletContext` — addresses, balances, inventory
   
   This would reduce the 2,733-LOC monolith into ~400-LOC per context, each with its own reducer.

2. **Hoist platform capabilities** — Create `PlatformCapabilitiesProvider` so consumers don't import isNative/isAndroid/isIOS directly.

3. **Consolidate modal providers** — Instead of singleton ConfirmDialog + PromptDialog, make them part of a `ModalsProvider` that gives children hooks (useConfirm, usePrompt).

---

### 2. Hook Organization

**Large hooks scattered across /hooks and /state**:
- `useVoiceChat.ts` (1,774 LOC) — Should be split into synthesis, recognition, streaming, session management
- `useChatCallbacks.ts` (1,233 LOC) — Chat message send, receive, streaming; could separate send/receive/stream pipelines
- `useChatLifecycle.ts` (1,156 LOC) — Chat init, cleanup, conversation loading; OK at this size but high coupling to AppContext
- `useOnboardingCallbacks.ts` (1,144 LOC) — Onboarding step handlers; could be split by step (deployment, providers, features)
- `useStartupCoordinator.ts` (600+ LOC) — Startup phases and coordination; reasonable

**Recommendation**:
1. Split 1,000+ LOC hooks using the "sub-hooks" pattern:
   ```tsx
   // useVoiceChat.ts (150 LOC, public API only)
   export function useVoiceChat() {
     const { synthesis } = useVoiceSynthesis();
     const { recognition } = useVoiceRecognition();
     const { streaming } = useVoiceStreaming();
     return { synthesis, recognition, streaming };
   }
   
   // useVoiceSynthesis.ts (300 LOC, private)
   function useVoiceSynthesis() { ... }
   ```
2. Test sub-hooks in isolation
3. Reduce main hook boilerplate

---

### 3. State Management Pattern

**Current pattern**: Zustand-like but in React Context + useReducer equivalents spread across files.

**Observations**:
- `AppContext` value is a plain object with 100+ fields
- No single reducer; state is built from 10+ custom hooks (useCharacterState, useChatState, useCloudState, etc.) each calling `useState`
- Updates are via setter functions or callbacks (no dispatch)
- Persistence via localStorage in multiple places (boot-config-store, persistence.ts, browser-tab-kit)

**Recommendation**:
- Keep Context but clarify the pattern:
  - Create a `AppStateReducer` file that documents the full state tree
  - Use a single `useReducer()` + `useMemo()` for AppContext value instead of 10 separate custom hooks
  - This would improve debuggability and make state changes traceable
  - Alternative: migrate to Zustand (external dependency but cleaner)

---

### 4. TypeScript & Type Safety

**Observations**:
- Only 1 instance of `as any` (minimal type-unsafety concerns)
- Good coverage of Zod validation in config-catalog.ts
- Types are generally well-structured, but some interfaces are verbose (e.g., WorkspaceLayoutProps with 11 optional fields)

**Recommendation**:
- No major action needed; codebase is type-safe
- Consider using discriminated unions for modal types (instead of `{ confirmOpen: boolean, promptOpen: boolean }`, use `{ modal: { type: 'confirm' } | { type: 'prompt' } | null }`)

---

### 5. Testing Coverage

**Observations**:
- Good test coverage in onboarding/ (612 + 354 + 397 + 188 LOC of tests)
- Minimal tests in layouts/, config/, utils/
- Platform tests exist (mobile-permissions-client.test.ts) but not comprehensive

**Recommendation**:
- Add unit tests for layout hooks (useMediaQuery, mobile state management)
- Add tests for config-catalog refactoring to ensure registry behavior is preserved
- Mock platform detection in component tests (instead of relying on Capacitor)

---

## Recommended Implementation Order

### Phase 1: Low-Risk Extractions (Week 1)

1. **Extract useMediaQuery** from layouts/ (2 hours)
   - Consolidate useWorkspaceLayoutDesktopMode + useMatchMedia
   - Both layouts now import one hook; no behavioral change
   - Test: verify both layouts still respond to breakpoint changes

2. **Consolidate branding** in config/ (2 hours)
   - Merge branding-base.ts + branding-react.tsx + branding.ts into branding.ts
   - Update imports in 5–10 files
   - No behavioral change

3. **Split config-catalog.ts** (8 hours)
   - Extract types into config-types.ts (150 LOC)
   - Extract utils into config-utils.ts (200 LOC)
   - Extract registry into config-registry.ts (300 LOC)
   - Update imports; run tests
   - **Outcome**: Four focused files instead of one 1,072-LOC monolith

4. **Extract PermissionClient interface** (6 hours)
   - Define `PermissionClient` interface
   - Have MobilePermissionsClient + DesktopPermissionsClient implement it
   - Create factory function `getPermissionClient()`
   - Update PermissionsSection.tsx to use factory instead of platform check
   - **Outcome**: Reduced coupling in PermissionsSection.tsx

### Phase 2: App.tsx Refactoring (Week 2)

5. **Extract ShellContent component** from App.tsx (8 hours)
   - Move lines 925–1,175 (the 450-LOC memoized switch statement) into a new `components/shell/ShellContent.tsx`
   - Props: `{ tab, uiShellMode, ... }` + all the callbacks
   - App.tsx becomes ~800 LOC
   - Test: verify all 25 tabs still render correctly

6. **Extract MobileChatLayout** from App.tsx (6 hours)
   - Move mobile-specific logic (mobileChatSurface, left/right panels, resize tracking)
   - Create `components/shell/MobileChatLayout.tsx`
   - App.tsx delegates to it; responsibility is clearer
   - **Outcome**: App.tsx reduced to ~650 LOC

7. **Consolidate panel state** (4 hours)
   - Merge customActionsPanelOpen, customActionsEditorOpen, widgetsPanelCollapsed into a `useUIState()` hook
   - Reduces App.tsx useState calls from 8 to 5

### Phase 3: Onboarding Consolidation (Week 2–3)

8. **Create useOnboardingMachine hook** (12 hours)
   - Define onboarding state machine as a reducer
   - Consolidate AppContext onboarding state + useOnboardingState + useOnboardingCallbacks
   - Tests for all transitions (deployment → providers → features)
   - **Outcome**: Single source of truth for onboarding flow

9. **Unify deep-link router** (6 hours)
   - Consolidate deep-link-handler.ts + reload-into-runtime-picker.ts into onboarding-router.ts
   - **Outcome**: One entry point for all onboarding deep links

### Phase 4: Platform Abstraction Refinement (Week 3)

10. **Create usePlatformCapabilities hook** (4 hours)
    - Move isNative, isIOS, isAndroid, isDesktop, canRunLocal, canHostLocalAgent into one hook
    - Consumers call `usePlatformCapabilities()` instead of importing functions
    - **Outcome**: Reduced coupling to platform/init.ts

11. **Consolidate runtime initialization** (6 hours)
    - Move ios-runtime.ts + android-runtime.ts setup into initializePlatform()
    - Call once from AppProvider
    - **Outcome**: Single boot path instead of scattered effects

### Phase 5: Utils Organization (Week 4)

12. **Refactor utils/ folder structure** (8 hours)
    - Group utilities into subfolders:
      - `utils/desktop/` (desktop-workspace, desktop-dialogs, desktop-bug-report)
      - `utils/formatting/` (format, date, time)
      - `utils/document/` (documents-upload-image, asset-url)
      - `utils/core/` (trivial helpers like cn(), clipboard)
    - Update imports across codebase
    - **Outcome**: 43 flat files → organized hierarchy

13. **Split useVoiceChat hook** (12 hours)
    - Sub-hooks for synthesis, recognition, streaming, session management
    - Main hook composes them
    - Add tests for each sub-hook
    - **Outcome**: 1,774 LOC → 200 LOC main + 400 LOC per sub-hook

### Phase 6: Context Refactoring (Week 4–5, optional but high-impact)

14. **Split AppContext into specialized contexts** (16 hours, optional)
    - UIShellContext (tab, modals, sidebar)
    - ChatContext (conversations, messages, streaming)
    - OnboardingContext (if not already done in Phase 3)
    - PluginsContext (plugins, skills, triggers)
    - WalletContext (addresses, balances, inventory)
    - **Outcome**: 2,733-LOC monolith → 5 × 400–500 LOC contexts, better ergonomics for consumers

---

## Success Criteria

After completing Phases 1–5 (recommended):

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| App.tsx LOC | 1,298 | ~800 | <1,000 |
| App.tsx useState calls | 8 | 5 | <5 |
| App.tsx useEffect calls | 9 | 5 | <7 |
| App.tsx useMemo dependency array | 24 items | 12 items | <15 |
| config-catalog.ts LOC | 1,072 | 4 × 300 | Modular |
| boot-config-store getters | 20+ pairs | 1 generic | Parameterized |
| Layout media query hooks | 2 implementations | 1 shared | Consolidation |
| PermissionClient implementations | 2 loose | 1 interface | Abstracted |
| Platform checks in codebase | 336 hits | 200 hits | Reduced coupling |
| utils/ file count | 43 flat | 40 organized | Better hierarchy |
| useVoiceChat.ts LOC | 1,774 | 200 main | Modular sub-hooks |

---

## Caveats & Dependencies

- **Phase 4 refactoring depends on Phase 3** (onboarding state must be unified before moving platform checks)
- **Phase 6 is optional** but high-impact if pursuing full state management clarity
- All phases include unit test updates; ensure CI passes before merging
- Some consumers may need import path updates (e.g., `from "./config/branding"` → `from "./config"`); grep for these

---

## Notes for Reviewers

1. **Avoid premature micro-optimizations**: The goal is clarity, not bundle size. Some larger functions (1,000+ LOC) are justified if they have a single clear purpose.
2. **Test coverage is critical**: Each refactoring should include unit tests to prevent regressions.
3. **Rollout by phase**: Phases 1–2 are low-risk and can be merged immediately. Phase 6 (AppContext split) is high-impact but requires careful planning.
4. **Documentation**: Update CLAUDE.md with architecture decisions (why we split contexts, how platform checks flow, etc.).


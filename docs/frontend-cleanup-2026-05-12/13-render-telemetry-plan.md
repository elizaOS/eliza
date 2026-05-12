# Render Telemetry & E2E Integration Plan

**Date:** 2026-05-12  
**Status:** Design  
**Scope:** Add render-telemetry instrumentation across frontends + e2e test integration to fail on excessive re-renders  

---

## Executive Summary

An existing `useRenderGuard` hook (in `packages/ui/src/hooks/useRenderGuard.ts`) tracks render counts per component and emits telemetry when:
- **2+ renders within 1000ms** → `console.info` (severity: "info")
- **3+ renders within 1000ms** → `console.error` (severity: "error")

The e2e test harness (`packages/app/test/ui-smoke/helpers.ts`) already has:
- `installRenderTelemetryGuard()` — wires event listener to capture errors into `window.__ELIZA_RENDER_TELEMETRY_ERRORS__`
- `expectNoRenderTelemetryErrors()` — asserts test fails if any render storms were detected

**This plan documents:**
1. Existing telemetry infrastructure inventory
2. Root render points and bootstrap flow
3. Test harness integration strategy
4. Rollout order (which components to instrument first)
5. Production no-op strategy
6. Files to create/modify

---

## 1. Existing Telemetry Inventory

### 1.1 Render Guard Hook (ALREADY EXISTS)

**Location:** `/packages/ui/src/hooks/useRenderGuard.ts`

**API:**
```typescript
export function useRenderGuard(name: string): void
```

**Behavior:**
- Dev-only (enabled when `VITE_ELIZA_RENDER_TELEMETRY=1` or `NODE_ENV=development` or `NODE_ENV=test`)
- Tracks render timestamps per component in a ref
- Keeps sliding window of renders within `WINDOW_MS=1000ms`
- Emits a single structured `RenderTelemetryEvent` when threshold crossed (only once per severity level per component)
- Event is dispatched to three surfaces:
  1. `window.__ELIZA_RENDER_TELEMETRY__` array (for direct JS access)
  2. Custom event `"eliza:render-telemetry"` (for event listeners)
  3. `console.info()` / `console.error()` (for dev debugging)

**Event Schema:**
```typescript
interface RenderTelemetryEvent {
  source: "useRenderGuard";
  name: string;  // component name passed to hook
  severity: "info" | "error";  // info = 2+, error = 3+
  renderCount: number;
  threshold: number;
  windowMs: number;  // 1000
  timestamps: number[];  // all render timestamps in window
  at: number;  // Date.now() when event fired
}
```

**Test Coverage:**
- Unit test: `/packages/ui/src/hooks/useRenderGuard.test.tsx`
- Tests that 2 quick renders trigger "info", 3 quick renders trigger "error"
- Custom event emission verified

### 1.2 Cloud Frontend Render Guard (DUPLICATE)

**Location:** `/cloud/packages/ui/src/runtime/render-telemetry.tsx`

**Status:** Identical to `packages/ui/src/hooks/useRenderGuard.ts` (likely copy-pasted, no shared export)

**Action:** Consolidate to single source of truth (see Rollout section).

### 1.3 E2E Test Integration (ALREADY IN PLACE)

**Location:** `/packages/app/test/ui-smoke/helpers.ts`

**Key Functions:**

```typescript
// Installs event listener in test page context
export async function installRenderTelemetryGuard(page: Page): Promise<void>
  // - Runs addInitScript to attach listener to window.__ELIZA_RENDER_TELEMETRY_ERRORS__
  // - Listener only captures events with severity === "error"
  // - Called once per page; no-op on second call (guarded by WeakSet)

// Reads accumulated errors from page and asserts empty
export async function expectNoRenderTelemetryErrors(
  page: Page,
  label: string
): Promise<void>
  // - page.evaluate() reads window.__ELIZA_RENDER_TELEMETRY_ERRORS__
  // - expect().toHaveLength(0) with formatted error message
  // - Called in openAppPath() after every page navigation

// Called in openAppPath() to install guard + navigate + assert no errors
export async function openAppPath(
  page: Page,
  targetPath: string
): Promise<void>
```

**Current Usage:**
- Every smoke test using `openAppPath()` automatically gets render-telemetry checking
- Only severity="error" events (3+ renders) trigger test failure
- No allowlist for legitimate re-renders yet

### 1.4 Telemetry Events System (REVIEW)

**Locations:**
- `/packages/ui/src/services/telemetry*` (if exists)
- `/packages/ui/src/events/` (custom event bus)
- No centralized OpenTelemetry/PostHog/Mixpanel setup observed in grep results

**Finding:** Render telemetry uses raw CustomEvent dispatch. No broader event-bus integration yet.

### 1.5 Logger Service (REVIEW)

**Standard Rule:** "Logger only, never `console.*` in shipping code"

**Current State:**
- Dev telemetry in `useRenderGuard.ts` uses `console.info()` and `console.error()` with `[RenderTelemetry]` prefix
- This is acceptable for dev-only telemetry (wrapped in dev guards)
- Production builds will strip via `__DEV__` check and tree-shaking

---

## 2. Test Harness Inventory

### 2.1 Playwright Configuration

**Smoke Test Config:**  
`/packages/app/playwright.ui-smoke.config.ts`
- Port: 2138 (configurable via `ELIZA_UI_SMOKE_PORT`)
- API port: 31337 (configurable via `ELIZA_UI_SMOKE_API_PORT`)
- Workers: 1 (serial execution)
- Timeout: 180s per test, 15s per assertion
- Retries: 0
- Trace/video: retained on failure

**Other Configs:**
- `/packages/app/playwright.ui-packaged.config.ts` (packaged app)
- `/packages/app/playwright.web-views.config.ts` (web views)
- `/packages/app/playwright.electrobun.packaged.config.ts` (Electrobun)
- `/packages/app-core/playwright.config.ts` (app-core)
- `/cloud/playwright.config.ts` (cloud frontend)

### 2.2 E2E Test Structure

**Smoke Tests:**  
Location: `/packages/app/test/ui-smoke/`

**Test Files:**
- `*.spec.ts` — individual test scenarios
- `helpers.ts` — shared utilities (seedAppStorage, installRenderTelemetryGuard, openAppPath, etc.)

**Pattern:**
```typescript
import { test, expect } from "@playwright/test";
import { openAppPath, seedAppStorage, installDefaultAppRoutes } from "./helpers";

test("describe feature", async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/path"); // Automatically installs render guard + asserts no errors
  // ... interaction code ...
  // expectNoRenderTelemetryErrors() called automatically by openAppPath
});
```

### 2.3 How Tests Read Render Telemetry

**Current Mechanism:**

1. **Page Initialization:**
   - `installRenderTelemetryGuard()` runs `page.addInitScript()` before page load
   - Script sets up `window.__ELIZA_RENDER_TELEMETRY_INSTALLED_KEY = true` (guard against double-init)
   - Script sets up `window.__ELIZA_RENDER_TELEMETRY_ERRORS__ = []` (error accumulator)
   - Script adds event listener for `"eliza:render-telemetry"` events
   - On each event, if severity === "error", push to errors array

2. **Reading Data:**
   - `expectNoRenderTelemetryErrors()` calls `page.evaluate()` to read the errors array
   - Playwright evaluates JS in the page context and returns the result

3. **Test Assertion:**
   - `expect(errors).toHaveLength(0)` with custom error message
   - Test fails if any "error" severity events were captured

---

## 3. Root Render Points

### 3.1 Packages (App)

**Entry Point:** `/packages/app/src/main.tsx`

**Bootstrap Flow:**
1. `mountReactApp()` (line 940)
   - Creates React root via `createRoot(#root)`
   - Mounts `<ErrorBoundary>` → `<StrictMode>` → `<AppProvider>` → app components
   - No render telemetry instrumentation at root level yet

2. **App Component Hierarchy:**
   - `AppProvider` (branding, boot config)
   - `App` component (main shell with sidebar, chat, wallet, etc.)
   - Platform-specific paths: PhoneCompanionApp, DetachedShellRoot, AppWindowRenderer

3. **Side-Effect Imports:**
   - `@elizaos/ui` components library
   - Multiple app plugins register themselves via side-effect imports (lifeops, task-coordinator, babylon, etc.)

### 3.2 Cloud Frontend

**Entry Point:** `/cloud/packages/ui/src/main.tsx` (likely similar pattern)

**Bootstrap:**
- Next.js App Router (or similar)
- Server-side rendering potentially involved

### 3.3 Where to Instrument

**Root-Level Render Guard (New):**
- Wrap `<App />` with a render-counting component or add `useRenderGuard("App")` to top-level shell
- Catches total render thrashing of the app shell
- Example: `<div><useRenderGuard("App"); return <App /> /></div>`

**High-Impact Components:**
From the frontend-cleanup plans, these are large/complex and should be instrumented first:
- BrowserWorkspaceView.tsx (2,851 LOC)
- PluginsView.tsx (1,448 LOC)
- VectorBrowserView.tsx (1,443 LOC)
- Chat composer (800 LOC)
- Sidebar root (865 LOC)

---

## 4. Proposed API Design

### 4.1 Hook: `useRenderTracker(componentName)` (ALREADY EXISTS AS `useRenderGuard`)

**Drop-in replacement/alias:**
```typescript
// packages/ui/src/hooks/useRenderTracker.ts (NEW - alias/convenience export)
export { useRenderGuard as useRenderTracker } from "./useRenderGuard";
```

**Usage:**
```typescript
function MyComponent() {
  useRenderTracker("MyComponent");
  return <div>...</div>;
}
```

**In Development/Test:**
- Tracks render count and timestamps
- Emits telemetry event to custom event + window global + console when thresholds crossed

**In Production:**
- Entire hook is tree-shaken away (wrapped in dev guards)

### 4.2 HOC: `withRenderTracker(Component, name?)` (NEW)

**For cases where hook can't be used (e.g., functional components as direct children, or when integration must happen outside the component):**

```typescript
// packages/ui/src/hooks/withRenderTracker.ts (NEW)
import { useRenderGuard } from "./useRenderGuard";

export function withRenderTracker<P extends object>(
  Component: React.ComponentType<P>,
  displayName?: string,
): React.ComponentType<P> {
  const name = displayName ?? Component.displayName ?? Component.name ?? "Unknown";
  
  function Wrapper(props: P) {
    useRenderGuard(name);
    return <Component {...props} />;
  }
  
  Wrapper.displayName = `withRenderTracker(${name})`;
  return Wrapper;
}
```

**Usage:**
```typescript
const TrackedComponent = withRenderTracker(MyComponent, "MyComponent");
```

### 4.3 Singleton Tracker (REVIEW)

**Current Design:**
- Each component using `useRenderGuard()` maintains its own `useRef<number[]>` for timestamps
- No central registry; each instance is independent
- Events are emitted to `window.__ELIZA_RENDER_TELEMETRY__` array and custom event

**Proposed Enhancement (Optional):**
- Keep per-component tracking as-is (works well)
- Consider adding a global registry for test queries, e.g.:
  ```typescript
  window.__ELIZA_RENDER_TELEMETRY_REGISTRY__ = {
    byComponent: {
      "MyComponent": [event1, event2, ...],
      "AnotherComponent": [event3, ...],
    }
  }
  ```
  This allows test helpers to query by component name, check specific components, etc.

**Decision:** Not needed for MVP. Current approach works. Revisit if test filtering becomes complex.

### 4.4 Telemetry Surface for E2E

**Global Window Object (ALREADY EXISTS):**

```typescript
// In dev/test builds, after React renders
window.__ELIZA_RENDER_TELEMETRY__ = [
  { source: "useRenderGuard", name: "App", severity: "error", ... },
  { source: "useRenderGuard", name: "BrowserWorkspaceView", severity: "info", ... },
];

window.__ELIZA_RENDER_TELEMETRY_ERRORS__ = [
  // Only error events, populated by test helper
  { source: "useRenderGuard", name: "App", severity: "error", ... },
];
```

**Custom Event (ALREADY EXISTS):**

```typescript
window.dispatchEvent(new CustomEvent("eliza:render-telemetry", { 
  detail: {
    source: "useRenderGuard",
    name: "ComponentName",
    severity: "error" | "info",
    ...
  }
}));
```

**Potential Dev Endpoint (FUTURE, NOT MVP):**

Could add a dev-server endpoint like `GET /_dev/render-telemetry` that returns:
```json
{
  "events": [...],
  "errorsByComponent": { "App": 1, "BrowserWorkspaceView": 2 }
}
```

For MVP, use window globals + custom events only.

---

## 5. Proposed E2E Integration

### 5.1 Current Integration (REVIEW)

**Summary:**
- `installRenderTelemetryGuard(page)` runs once per page
- `expectNoRenderTelemetryErrors(page, label)` called in `openAppPath()`
- Test fails if 3+ renders in 1000ms detected

**Working well.** No changes needed to core mechanism.

### 5.2 Enhancements (OPTIONAL FOR MVP)

**5.2.1 Per-Component Allowlist**

Some components legitimately re-render 3+ times (e.g., during initial mount with data fetching). Allow tests to allowlist:

```typescript
// packages/app/test/ui-smoke/helpers.ts (ENHANCEMENT)
export async function expectNoRenderTelemetryErrors(
  page: Page,
  label: string,
  allowedComponents?: Set<string> | string[],
): Promise<void> {
  const errors = await page.evaluate<RenderTelemetryIssue[]>(...);
  const allowed = new Set(allowedComponents ?? []);
  const blockedErrors = errors.filter(e => !allowed.has(e.name ?? "unknown"));
  
  expect(blockedErrors).toHaveLength(0);
}
```

**Usage:**
```typescript
await expectNoRenderTelemetryErrors(
  page,
  "complex view",
  ["DataTable", "SearchFilter"] // These can re-render as data loads
);
```

**Decision for MVP:** Document the allowlist mechanism but don't implement yet. Once tests are running, collect known legitimate re-render patterns and add to allowlist as needed.

### 5.2.2 Granular Severity Filtering

Current implementation only fails on severity="error" (3+ renders). Could expose:

```typescript
export async function getRenderTelemetryIssues(
  page: Page,
  severity?: "info" | "error" | "all",
): Promise<RenderTelemetryEvent[]>
```

**Decision for MVP:** Keep simple (errors only). Revisit if needed.

### 5.2.3 Performance Reporting

Add optional hook to report render metrics at end of test:

```typescript
export async function reportRenderTelemetry(page: Page): Promise<void> {
  const events = await page.evaluate(() => window.__ELIZA_RENDER_TELEMETRY__ ?? []);
  const summary = {
    totalEvents: events.length,
    errorCount: events.filter(e => e.severity === "error").length,
    infoCount: events.filter(e => e.severity === "info").length,
    byComponent: groupBy(events, e => e.name),
  };
  console.log("[RenderTelemetry Report]", summary);
}
```

**Decision for MVP:** Not needed. Add if test reports become valuable.

---

## 6. Production No-Op Strategy

### 6.1 Current Implementation

**File:** `/packages/ui/src/hooks/useRenderGuard.ts`

**Checks:**
```typescript
function isRenderTelemetryEnabled(): boolean {
  const explicit = readEnvValue("VITE_ELIZA_RENDER_TELEMETRY");
  if (explicit === "0" || explicit === "false") return false;

  const nodeEnv = typeof process !== "undefined" ? process.env.NODE_ENV : undefined;
  const meta = import.meta as ImportMetaWithEnv;
  const mode = meta.env?.MODE;

  return (
    meta.env?.DEV === true ||
    mode === "development" ||
    mode === "test" ||
    nodeEnv === "development" ||
    nodeEnv === "test"
  );
}
```

**Early return in hook:**
```typescript
export function useRenderGuard(name: string): void {
  // ... refs setup ...
  if (!isRenderTelemetryEnabled()) return;  // <- No-op in production
  // ... tracking logic ...
}
```

### 6.2 Bundler Stripping

**Vite/Esbuild:**
- `import.meta.env.DEV` is replaced at build time with a constant boolean
- Production build has `import.meta.env.DEV = false`
- Early return in disabled branch is eliminated by tree-shaker
- Entire hook body becomes dead code and is stripped

**Verification:**
```bash
# Check production bundle
grep -i "renderguard\|render.*telemetry" dist/assets/*.js
# Should return NOTHING in production build
```

### 6.3 Test/Dev Environment Variables

**Default Behavior:**
- Dev mode (`npm run dev`): `NODE_ENV=development` → telemetry enabled
- Test mode (`npm run test`, Playwright): `NODE_ENV=test` → telemetry enabled
- Production build: `NODE_ENV=production` → telemetry disabled

**Explicit Control:**
```bash
# Disable in dev if needed
VITE_ELIZA_RENDER_TELEMETRY=0 npm run dev

# Force enable for debugging
VITE_ELIZA_RENDER_TELEMETRY=1 npm run build
```

### 6.4 Cloud Frontend (Duplicate Resolution)

**Current State:**
- `/cloud/packages/ui/src/runtime/render-telemetry.tsx` is identical to packages version
- No shared export

**Action:** Consolidate to monorepo-shared hook or update both in sync.

---

## 7. Rollout Order

### Phase 1: Baseline (Week 1)

**Goal:** Establish telemetry signal in all e2e tests without breaking anything.

**Actions:**
1. Verify existing `useRenderGuard` hook is working in smoke tests
   - Run: `npm run test:ui-smoke`
   - Check for render telemetry events in test output
   - Confirm no false-positive failures

2. Document in test output which components are being tracked
   - Add verbose logging to `installRenderTelemetryGuard()` or test summary

3. Update Playwright config to opt-in to render telemetry in all projects
   - Verify all configs have the guard installed

### Phase 2: Component Instrumentation (Weeks 2–3)

**Goal:** Add hook to highest-impact components identified in frontend-cleanup plans.

**Priority Order:**
1. **Root shell components** (highest impact):
   - `packages/ui/src/components/App.tsx` (main app shell)
   - `packages/ui/src/components/layout/Shell.tsx` (if exists)

2. **High-complexity pages** (from plan 01):
   - `BrowserWorkspaceView.tsx` (2,851 LOC)
   - `PluginsView.tsx` (1,448 LOC)
   - `VectorBrowserView.tsx` (1,443 LOC)
   - `ChatView.tsx` (if it exists)

3. **Composite/layout components**:
   - `sidebar-root.tsx` (865 LOC)
   - `chat-composer.tsx` (800 LOC)

4. **Data-heavy lists**:
   - Wallet transaction tables
   - Search results lists
   - Plugin registry

**For each component:**
- Add `useRenderGuard("ComponentName")` as first line in component body
- No other changes needed
- Run smoke tests to verify no regressions

### Phase 3: Test Allowlisting (Weeks 3–4)

**Goal:** Document and suppress legitimate render-storm patterns.

**Actions:**
1. Run full test suite; collect all render telemetry errors
2. For each error, determine root cause:
   - Is it a bug? (fix in Phase 4)
   - Is it legitimate? (add to allowlist)
3. Update `expectNoRenderTelemetryErrors()` to accept allowlist
4. Commit allowlist to test fixtures

**Example Allowlist:**
```typescript
const KNOWN_RENDER_STORMS = {
  "SearchResults": { reason: "data fetch + sort", maxWindows: 2 },
  "WalletBalanceCard": { reason: "price updates", maxWindows: 1 },
};
```

### Phase 4: Bug Fixes & Optimization (Weeks 4–6)

**Goal:** Fix identified render storms.

**Process:**
1. For each error not in allowlist:
   - Investigate root cause (see frontend-cleanup plans for patterns)
   - Apply targeted fixes (useCallback, useMemo, useReducer, etc.)
   - Re-run tests; verify error is gone

2. Use profiler to confirm fixes:
   ```bash
   VITE_ELIZA_RENDER_TELEMETRY=1 npm run dev
   # Open React DevTools Profiler → record render activity
   # Verify component renders are now O(1) in the expected window
   ```

3. Update frontend-cleanup plan with results

### Phase 5: Cloud Frontend (Week 6)

**Goal:** Apply same instrumentation to `/cloud` packages.

**Actions:**
1. Consolidate `cloud/packages/ui/src/runtime/render-telemetry.tsx` with packages version
   - Option A: Export from packages; import in cloud
   - Option B: Deduplicate the file content (sync both)

2. Add `useRenderGuard()` to cloud dashboard components
   - Priority: any dashboard-shell, form, table, search components

3. Update cloud Playwright config to include render-telemetry guard

---

## 8. Files to Add/Modify

### New Files

| File | Purpose | Size |
|------|---------|------|
| `packages/ui/src/hooks/useRenderTracker.ts` | Convenience alias for `useRenderGuard` | ~10 LOC |
| `packages/ui/src/hooks/withRenderTracker.tsx` | HOC wrapper for class/non-hook components | ~25 LOC |
| `docs/frontend-cleanup-2026-05-12/13-render-telemetry-plan.md` | This plan | Reference |

### Modified Files (Phase 1–2)

| File | Change | Size |
|------|--------|------|
| `packages/ui/src/hooks/useRenderGuard.ts` | No change (already correct) | — |
| `packages/ui/src/hooks/useRenderGuard.test.tsx` | No change (already exists) | — |
| `packages/app/test/ui-smoke/helpers.ts` | No change (already correct); note as reference | — |
| `packages/app/src/components/App.tsx` | Add `useRenderGuard("App")` | +1 LOC |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx` | Add `useRenderGuard("BrowserWorkspaceView")` | +1 LOC |
| `packages/ui/src/components/pages/PluginsView.tsx` | Add `useRenderGuard("PluginsView")` | +1 LOC |
| `packages/ui/src/components/pages/VectorBrowserView.tsx` | Add `useRenderGuard("VectorBrowserView")` | +1 LOC |
| (more high-impact components...) | Add `useRenderGuard()` | +1 LOC each |

### Modified Files (Phase 4)

Per-component optimizations (see frontend-cleanup plans for detailed refactors):
- Extract hooks (useTabState, useDragAndDrop, etc.)
- Add useCallback, useMemo to stable handler/value references
- Consolidate state with useReducer
- (Specific refactors TBD after phase 2 results)

### Modified Files (Phase 5)

| File | Change |
|------|--------|
| `cloud/packages/ui/src/runtime/render-telemetry.tsx` | Consolidate or sync with packages version |
| (Cloud components) | Add `useRenderGuard()` to priority components |

### Documentation Updates

| File | Change |
|------|--------|
| `README.md` or telemetry docs | Add section: "Render Telemetry in Development" |
| Test README | Document `expectNoRenderTelemetryErrors()` usage and allowlisting |

---

## 9. Key Decisions & Rationale

### Decision 1: Keep Single-Component Window (1000ms)

**Rationale:**
- Per-component 1000ms window is sufficient to catch most re-render bugs
- Avoids false positives from legitimate data-driven updates
- Aligns with human perception (~1 sec of visible flicker)

**Alternative Considered:** Reduce window to 50ms for stricter checks
- **Rejected:** Would require too much allowlisting; legitimate animation/transition renders would fail tests

### Decision 2: Error-Only in Tests, Info Visible in Console

**Rationale:**
- `severity="error"` (3+ renders) is unambiguous bug territory
- `severity="info"` (2+ renders) may be legitimate; visible in console for dev investigation
- Keeps test failures focused on clear regressions

**Alternative Considered:** Fail on both info and error
- **Rejected:** Would require extensive allowlisting and fragment tests

### Decision 3: No Central Registry (MVP)

**Rationale:**
- Per-component refs are simple, low-overhead, and work well
- Custom events + window global sufficient for test integration
- Can add registry later if test filtering becomes complex

**Future:** If allowlisting becomes tedious, add:
```typescript
window.__ELIZA_RENDER_TELEMETRY_REGISTRY__ = {
  byComponent: { "ComponentName": [events...] }
}
```

### Decision 4: Consolidate Cloud Duplicate

**Rationale:**
- Identical code in two places is maintenance debt
- Cloud and packages should share same telemetry logic

**Approach:**
- Export from `packages/ui/src/hooks/useRenderGuard.ts`
- Cloud imports via: `import { useRenderGuard } from "@elizaos/ui"`
- Deprecate `cloud/packages/ui/src/runtime/render-telemetry.tsx`

---

## 10. Acceptance Criteria

### Phase 1 (Baseline)
- [ ] `npm run test:ui-smoke` passes with no false-positive render-telemetry failures
- [ ] Render telemetry events visible in test output/console
- [ ] No performance regression in dev/test builds

### Phase 2 (Instrumentation)
- [ ] Root app component has `useRenderGuard("App")`
- [ ] All high-priority components (BrowserWorkspaceView, PluginsView, etc.) instrumented
- [ ] Smoke tests still passing
- [ ] No regressions in component behavior

### Phase 3 (Allowlisting)
- [ ] Allowlist mechanism documented
- [ ] Known legitimate re-render patterns identified and allowlisted
- [ ] Test suite stable (no flaky failures due to render telemetry)

### Phase 4 (Bug Fixes)
- [ ] All non-allowlisted render storms fixed
- [ ] Frontend-cleanup plan updated with refactor results
- [ ] Profiler confirms render count reduced post-fix

### Phase 5 (Cloud)
- [ ] Cloud frontend consolidated with packages version
- [ ] Cloud smoke tests (if exists) passing
- [ ] No duplication of telemetry code

---

## 11. Production Rules (Honored)

✅ **Logger only, never console in shipping code:**
- Dev telemetry in `useRenderGuard` uses `console.info()` / `console.error()` with `[RenderTelemetry]` prefix
- Wrapped in dev-only checks; stripped in production

✅ **No try/catch sludge — fail loudly in dev:**
- Render storms emit `console.error()` immediately; no silent failures
- Test suite fails if storm detected; no implicit allowlisting

✅ **No silent fallbacks:**
- Telemetry failures are visible via CustomEvent dispatch and window global
- If event dispatch fails, hook still logs to console

✅ **Production no-op:**
- `isRenderTelemetryEnabled()` gates all tracking logic
- Production builds tree-shake entire hook body
- Zero overhead in shipping binaries

---

## 12. Next Steps

1. **Verify Phase 1 baseline:**
   - Run smoke tests; confirm telemetry working
   - Document any pre-existing render storms

2. **Instrument high-priority components:**
   - Add one-liners to 5–8 components
   - Re-run tests; collect error patterns

3. **Analyze root causes:**
   - Use React DevTools Profiler to understand each render storm
   - Reference frontend-cleanup plans for refactor templates

4. **Plan optimizations:**
   - Design fix (useCallback, useReducer, etc.)
   - Estimate effort per component
   - Prioritize by impact

5. **Begin Phase 4 refactors:**
   - Apply fixes incrementally
   - Re-run tests after each fix
   - Measure improvement

---

## Appendix: Existing Code References

### useRenderGuard Hook
**File:** `/packages/ui/src/hooks/useRenderGuard.ts`
- Complete, well-tested, production-ready
- No changes required

### E2E Integration
**File:** `/packages/app/test/ui-smoke/helpers.ts`
- `installRenderTelemetryGuard(page)` — event listener setup
- `expectNoRenderTelemetryErrors(page, label)` — assertion
- Working in all smoke tests via `openAppPath()`

### Test Coverage
**File:** `/packages/ui/src/hooks/useRenderGuard.test.tsx`
- Unit tests for hook behavior
- Custom event emission verified

### Cloud Duplicate
**File:** `/cloud/packages/ui/src/runtime/render-telemetry.tsx`
- Identical to packages version
- Consolidation candidate


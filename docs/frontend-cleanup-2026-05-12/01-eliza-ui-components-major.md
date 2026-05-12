# Frontend Cleanup Plan: Eliza UI Components (pages/, composites/, ui/)

**Date:** 2026-05-12  
**Scope:** 171 files across three component subdirectories  
**Total LOC analyzed:** ~40,000 LOC  

---

## Executive Summary

The Eliza UI component library is mature but exhibits patterns consistent with rapid iteration and feature expansion. Three high-impact categories are identified:

1. **Massive page-level components** (2,851–1,195 LOC) with dense state machines and tightly coupled business logic
2. **State proliferation** across all tiers (965 useState/useEffect instances; 295 useMemo/useCallback; minimal memoization)
3. **Composite/page boundary confusion** (pages don't import composites; composites are minimal stubs; reusable behaviors duplicated across pages)

This plan prioritizes actionable refactors that yield immediate maintainability gains without destabilizing deployed features.

---

## High-Priority Deep-Dives

### 1. BrowserWorkspaceView.tsx (2,851 LOC)
**Location:** `/packages/ui/src/components/pages/BrowserWorkspaceView.tsx`

**Assessment:**
- Single component managing browser tabs, wallet state, bridge lifecycle, and native OOPIF synchronization
- **18 useState declarations** managing: workspace state, tab selection, UI flags, wallet bridge state, mobile runtime mode, collapsed sections, sidebar state
- **13 useEffect hooks** for polling, event subscription cleanup, browser bridge setup, and mobile mode detection
- No memoization; all handlers re-created on every render
- 2,851 lines; difficult to reason about state transitions
- Heavy reliance on browser APIs (Capacitor, Electrobun webview tags); good isolation opportunity

**Specific Issues:**
- Lines 434–473: 10 consecutive useState declarations without reducer consolidation
- Lines 597–1764: 13 sequential useEffect hooks with overlapping dependencies
- Lines 1540–1764: useEffect chains that update state as side-effect (e.g., selectedTabId → sync dimensions → toggle hidden); potential race conditions
- Tab state machine (partition/selected/hidden/passthrough) has no formal state type; flags scattered across separate useState calls
- Wallet bridge (`useBrowserWorkspaceWalletBridge`) adds 2+ more hooks; not extracted to a custom hook

**Recommended Actions:**
1. Extract tab state machine into a `useTabState` hook (combineReducer or custom context)
   - Single source of truth for tab selection, partition, hidden state, passthrough flags
   - Eliminates 4–5 useState calls
2. Extract wallet bridge setup into custom hook `useBrowserWalletBridge` that encapsulates all 13 bridge-related state updates
3. Consolidate polling and subscription effects using `useIntervalWhenDocumentVisible` (already imported) for all poll effects
4. Move browser-tag-specific sync logic (syncDimensions, toggleHidden) into a separate hook `useBrowserTabSync`
5. Introduce error boundary around webview mounts to isolate Electrobun failures
6. Add a state machine type (e.g., TypeScript discriminated union) to document tab lifecycle

**Estimated Effort:** 6–8 hours  
**Risk:** Medium (webview interaction logic is fragile; tests required before merge)

---

### 2. PluginsView.tsx (1,448 LOC)
**Location:** `/packages/ui/src/components/pages/PluginsView.tsx`

**Assessment:**
- Multi-mode plugin manager (install, configure, test connections, drag-to-reorder)
- **11 useState hooks** managing: install queue, update queue, test results, configs, drag state, plugin order, release streams
- **3 useEffect hooks** for load on mount, WebSocket event subscription, localStorage persistence
- Heavy use of Map/Set data structures without normalization
- Strings used as mode flags (mode: "all" | "social" | "connectors" | "all-social") with conditional rendering everywhere
- Handlers re-created on every render (3 inline arrow functions in onClick props)

**Specific Issues:**
- Lines 203–217: Drag-and-drop state split across 3 separate useState (draggingId, dragOverId, dragRef)
- Lines 85–105: Plugin metadata split across 5 separate state variables (configs, testResults, installingPlugins, updatingPlugins, uninstallingPlugins, releaseStreams)
- Lines 222–228: Mode logic repeated 4+ times (isConnectorShellMode, isSocialMode, isSidebarEditorShellMode, isConnectorLikeMode)
- localStorage access on every render for plugin order (line 209)
- No error handling for WebSocket event subscription (line 237)

**Recommended Actions:**
1. Consolidate plugin metadata into a single Map<pluginId, PluginState> where PluginState = { status, config, testResult, releaseStream }
   - Reduces 5 useState to 1
2. Extract mode resolution into a custom hook or config object
   - Create a usePluginListMode(mode) hook that returns { isConnectorMode, isSocialMode, statusFilter, ... }
3. Consolidate drag state into a `useDragAndDrop(onReorder)` hook
   - Handles all reordering logic, localStorage persistence, state cleanup
4. Extract WebSocket event binding into useEffect with proper error handling and early return
5. Wrap translateFn calls in useMemo to avoid recreation

**Estimated Effort:** 4–5 hours  
**Risk:** Low (plugin list is heavily tested; snapshot tests exist)

---

### 3. VectorBrowserView.tsx (1,443 LOC)
**Location:** `/packages/ui/src/components/pages/VectorBrowserView.tsx`

**Assessment:**
- Vector similarity search UI with result filtering, embedding inspection, and batch operations
- Dense state for search params, results, expanded rows, filters
- Heavy array manipulation in render (sorting, filtering, mapping)
- No memoization of derived data; entire result list re-renders on any parent update

**Specific Issues:**
- Search state (query, filters, sortBy, pageSize) not grouped; ideal for useReducer
- Result rows expanded state stored as Set<id>; re-create on every render
- Sorting/filtering applied inline in JSX; should be memoized

**Recommended Actions:**
1. Use useReducer for search state (query, filters, sortBy, pagination)
2. Memoize filtered/sorted results using useMemo
3. Extract result row component with memo()
4. Consolidate expanded state into reducer

**Estimated Effort:** 3–4 hours  
**Risk:** Low

---

### 4. sidebar-root.tsx (865 LOC in composites/)
**Location:** `/packages/ui/src/components/composites/sidebar/sidebar-root.tsx`

**Assessment:**
- Compound sidebar component with 11+ sub-components (header, body, footer, content, rail, panel, etc.)
- Single 865-line file; difficult to maintain layout logic
- CVA variants are correct but many redundant className definitions
- No clear extraction points; each piece is tightly coupled via context

**Recommended Actions:**
1. Split into smaller files:
   - `sidebar-root.tsx` — SidebarProvider and main layout
   - `sidebar-layout.tsx` — Desktop/mobile/game-modal layout logic (85 LOC)
   - Keep sub-component imports but move variants to per-file modules
2. Extract repeated className patterns into CSS modules or CSS-in-JS utilities
3. Simplify CVA compound variants (several variants are redundant)

**Estimated Effort:** 2–3 hours  
**Risk:** Low (mostly cosmetic refactor)

---

### 5. chat-composer.tsx (800 LOC in composites/)
**Location:** `/packages/ui/src/components/composites/chat/chat-composer.tsx`

**Assessment:**
- Textarea autosizing, voice capture, attachment strip, message composition
- Good function extraction (measureInlineTextarea, getTextareaLineHeight) but complex state management
- 4 useState hooks for textarea measurement, voice state, recording, attachments
- useLayoutEffect for textarea auto-height; good pattern but can be optimized

**Specific Issues:**
- Voice state props (captureMode, isListening, isSpeaking) repeated across component tree
- No context provider; props thread through composites/chat/chat-composer-shell
- Attachment handling duplicated with chat-attachment-strip

**Recommended Actions:**
1. Create ChatComposerContext to thread voice state and attachment callbacks
2. Extract CreateTaskPopover state management into separate hook
3. Memoize textarea measurement logic
4. Extract voice button into separate component with context consumer

**Estimated Effort:** 2–3 hours  
**Risk:** Medium (voice state is critical; careful testing required)

---

## Cross-Cutting Findings

### Pattern 1: useState Proliferation Without Reducer (965 instances)
Across all pages, useState is used individually for related state that should be grouped:
- **Symptom:** setters called in sequence; interdependent state updates; hard to reason about consistency
- **Example:** BrowserWorkspaceView tabs (selectedTabId, locationInput, locationDirty, loading, loadError, snapshotError all updated together on tab switch)
- **Fix:** Replace clusters of 3+ related setState calls with useReducer
  - Estimate: 20–30 useReducers introduced across pages/ and composites/
  - One-time effort: ~8 hours
  - Payoff: immediate clarity; easier to debug; fewer state consistency bugs

### Pattern 2: Inline Arrow Functions in Props (234 onClick={...} instances)
Every click handler is a fresh function on every render. No memoization.
- **Symptom:** Unnecessary re-renders in memoized children; poor performance on large lists
- **Example:** PluginsView, DocumentsView, RelationshipsView
- **Fix:** useCallback all event handlers; pair with memo() on list items
  - Estimate: 10–15 hours across all files
  - Payoff: 15–30% faster list renders on larger data sets

### Pattern 3: No Memoization of Composites (1 memo() instance found in pages/)
ChatModalView is the only page-level component using memo(). Composites rarely memoized.
- **Symptom:** Entire component trees re-render when parent state changes (e.g., sidebar collapse)
- **Fix:** Wrap composites with memo() and useCallback handlers; add propTypes or Zod schemas
  - Estimate: 15–20 hours
  - Payoff: Noticeable performance improvement on complex views (Relationships, Vector Browser)

### Pattern 4: pages/ Does Not Import composites/
A critical architectural issue: **zero imports from composites/ into pages/**.
- **Why:** Composites folder exists as a UI library, but pages/ re-implements similar components
- **Evidence:** chat-composer duplicated in chat-composer-shell; sidebar reimplemented in multiple pages; form layouts repeated
- **Impact:** Code duplication; inconsistent component APIs; difficult to refactor shared behavior
- **Fix:**
  1. Move ChatComposer, ChatTranscript, ChatSidebar into composites if not already
  2. Extract shared form patterns into composites/form-field (already exists but underused)
  3. Create composites/layout/ for PagePanel variants and shared section layouts
  4. Document which composites are page-level vs UI primitive vs layout
  5. Establish import boundary: pages/ can import composites/ and ui/; composites/ can only import ui/

### Pattern 5: No Shared Error Handling Patterns (116 try-catch blocks)
Every API call wrapped in try-catch individually.
- **Symptom:** Inconsistent error handling; missed error cases; verbose code
- **Fix:** Create a useApiCall hook that handles errors, loading, retry
  - Template: `const { data, loading, error, retry } = useApiCall(apiFn, deps)`
  - Estimate: 3–4 hours to create hook; 10–12 hours to retrofit across pages
  - Payoff: Consistent UX; fewer bugs; less boilerplate

### Pattern 6: Localization Strings (t(...)) Computed Inline (100+ instances)
Every view computes translated labels inline; no constants.
- **Symptom:** Hard to audit strings; duplicates across files; complex t() calls in JSX
- **Fix:** Extract i18n resources to top of component or separate i18n file
  - Estimate: 5–8 hours

### Pattern 7: Inconsistent State Library Usage
Mix of useState, useContext, useReducer, no Redux/Zustand.
- **Assessment:** useApp() is centralized state (good), but local page state is scattered
- **Fix:** Document when to use useApp vs useState vs useReducer
  - Create a state management guide in CLAUDE.md

---

## Low-Impact Inventory

### Pages/ (74 files)
**Healthy Components (<400 LOC):**
- HomePlaceholderView.tsx (small stub)
- HeartbeatForm.tsx (1,012 LOC but well-structured form)
- TaskEditor.tsx (well-modularized)
- MemoryDetailPanel.tsx (focused piece of MemoryViewerView)
- PluginCard.tsx (reusable card; 300+ LOC but single-purpose)

**Utility Files (well-maintained):**
- plugin-list-utils.ts (906 LOC, proper exports)
- heartbeat-utils.ts (475 LOC, clean)
- cloud-dashboard-utils.ts (425 LOC, clean)
- page-scoped-conversations.ts (382 LOC, clean)
- browser-workspace-wallet.ts (367 LOC, good separation of concerns)

**Test Files:**
- browser-workspace-wallet.test.ts (260 LOC, comprehensive)
- browser-workspace-wallet-injection.test.ts (280 LOC, comprehensive)

**Action:** No immediate changes needed for low-impact files. They are well-scoped and focused.

### Composites/ (56 files)
**Well-Structured Modules:**
- chat/ (19 files) — cohesive chat UI library; minimal cross-dependency
- sidebar/ (13 files) — compound sidebar; some consolidation needed but reasonable structure
- page-panel/ (9 files) — layout primitives; solid, reusable
- search/ (3 files) — search components; minimal, focused
- form-field/ (2 files) — form primitives; underused but good foundation
- trajectories/ (7 files) — trajectory visualization; specialized, reasonable scope
- skills/ (2 files) — skill sidebar; minimal

**Assessment:** Composites/ is healthier than pages/. Structure is reasonable; main issue is underuse from pages/.

### UI/ (41 files)
**Primitives (well-maintained):**
- button.tsx (66 LOC, clean)
- input.tsx (55 LOC, clean)
- card.tsx (101 LOC, clean)
- dialog.tsx (133 LOC, clean)
- All other primitives <100 LOC, good separation

**Composite UI Elements (moderate complexity):**
- confirm-dialog.tsx (241 LOC, well-scoped)
- dropdown-menu.tsx (198 LOC, good wrapper)
- admin-dialog.tsx (176 LOC, specialized)
- settings-controls.tsx (165 LOC, well-structured)
- select.tsx (161 LOC, good Radix wrapper)
- status-badge.tsx (133 LOC, focused)

**Assessment:** UI/ is healthy. No major refactors needed. Good foundation for building composites.

---

## Recommended Order of Operations

### Phase 1: Foundation (Weeks 1–2)
**Goal:** Establish patterns and tooling for all subsequent refactors.

1. **Create custom hooks library** (4–6 hours)
   - `useApiCall(fn, deps)` — standardized error/loading/retry pattern
   - `useLocalStorage(key, initialValue)` — persistent state with SSR safety
   - `useDerivedState(compute, deps)` — useMemo without manual deps tracking
   - Location: `/packages/ui/src/hooks/`
   - Export from `/packages/ui/src/index.ts`

2. **Document component layer boundaries** (2–3 hours)
   - Update CLAUDE.md with import rules: pages/ can use composites/ and ui/; composites/ can only use ui/; etc.
   - Create checklist for PR reviews
   - Add TypeScript path aliases if not present

3. **Add render telemetry** (2–3 hours)
   - Wrap high-impact components with a renderMetrics hook that logs when they re-render
   - Use for data-driven optimization decisions
   - Location: `/packages/ui/src/debug/render-metrics.ts`

### Phase 2: Consolidation (Weeks 2–3)
**Goal:** Reduce state complexity in 5 highest-impact files.

1. **BrowserWorkspaceView** (6–8 hours)
   - Extract tab state machine into useTabState hook
   - Extract wallet bridge into useBrowserWalletBridge hook
   - Extract tab sync into useBrowserTabSync hook
   - Add tests for new hooks

2. **PluginsView** (4–5 hours)
   - Consolidate plugin state using Map<id, PluginState>
   - Extract mode resolution into usePluginListMode hook
   - Extract drag-and-drop into useDragAndDrop hook
   - Add tests

3. **VectorBrowserView** (3–4 hours)
   - Convert search state to useReducer
   - Memoize filtered/sorted results
   - Extract result row component with memo()

4. **chat-composer.tsx** (2–3 hours)
   - Create ChatComposerContext for voice state
   - Extract voice button to separate component
   - Test voice state threading

5. **sidebar-root.tsx** (2–3 hours)
   - Split into smaller files
   - Extract CVA variants into separate modules

### Phase 3: Performance Optimization (Weeks 3–4)
**Goal:** Add memoization and callback optimization across pages/ and composites/.

1. **Memoize page-level composites** (8–10 hours)
   - Wrap all composite exports with memo()
   - Convert handlers to useCallback
   - Pair with propTypes or Zod schemas
   - Focus on high-render components: PluginsView, DocumentsView, RelationshipsView

2. **Optimize list rendering** (4–6 hours)
   - Extract list row components with memo()
   - useCallback all row handlers
   - Add virtualization to large lists (DocumentsView, VectorBrowserView)

3. **Audit and optimize modal renders** (2–3 hours)
   - ChatModalView and PluginGameModal should use memo()
   - Reduce modal payload

### Phase 4: Integration and Testing (Weeks 4–5)
**Goal:** Validate all changes in integration; establish regression test suite.

1. **Integration testing** (6–8 hours)
   - Test BrowserWorkspaceView tab switching, wallet interactions, mobile mode
   - Test PluginsView install, update, config flows
   - Test chat composition and voice flows
   - End-to-end tests for each major page

2. **Performance benchmarking** (2–3 hours)
   - Measure before/after render counts
   - Compare bundle size
   - Profile memory usage

3. **Documentation** (2–3 hours)
   - Update CLAUDE.md with new patterns
   - Add examples of custom hooks
   - Document state machine patterns

---

## Concrete File-by-File Action Items

### pages/ (Priority Edits)

| File | LOC | Issue | Action | Effort |
|------|-----|-------|--------|--------|
| BrowserWorkspaceView.tsx | 2,851 | 18 useState, 13 useEffect, no reducer | Extract hooks; add state machine type | 6–8h |
| PluginsView.tsx | 1,448 | 11 useState, 5 Map/Set state, mode flags | Consolidate state; extract mode hook; extract drag hook | 4–5h |
| VectorBrowserView.tsx | 1,443 | Dense search state, inline sorting/filtering | useReducer for search; memoize results; extract row component | 3–4h |
| ElizaOsAppsView.tsx | 1,330 | 8 useState, tight coupling with API | useReducer for app state; extract useApiCall | 3–4h |
| DocumentsView.tsx | 1,283 | 7 useState, heavy list rendering, inline handlers | useCallback handlers; extract row component with memo(); extract search state | 4–5h |
| ChatView.tsx | 1,258 | 10 useState, voice state threading, complex hooks | Extract voice state to context; consolidate composer state | 3–4h |
| RelationshipsGraphPanel.tsx | 1,232 | 6 useState, graph rendering, heavy effects | memoize graph; consolidate selection state | 2–3h |
| AppsView.tsx | 1,195 | 5 useState, moderate coupling | useReducer for view state | 2–3h |
| HeartbeatForm.tsx | 1,012 | Well-structured but large form | Extract form sections; memoize sections | 2–3h |
| PageScopedChatPane.tsx | 999 | 8 useState, message state, scroll state | Consolidate message state; extract scroll hooks | 2–3h |
| All other pages | <900 LOC | Low impact; well-scoped or utility files | No changes needed | — |

### composites/ (Priority Edits)

| File | LOC | Issue | Action | Effort |
|------|-----|-------|--------|--------|
| sidebar-root.tsx | 865 | Single 865-line file with 11 sub-components | Split into smaller files; extract variants | 2–3h |
| chat-composer.tsx | 800 | Voice state threading; complex textarea handling | Create ChatComposerContext; extract voice button | 2–3h |
| chat-message.tsx | 542 | Good structure but no memo; inline handlers | Wrap with memo(); useCallback handlers; test render optimization | 1–2h |
| permission-card.tsx | 486 | Well-structured, moderate size | Memoize conditionally | 1h |
| sidebar-content.tsx | 397 | Sidebar items rendered inline | Extract item component with memo() | 1–2h |
| sidebar-auto-rail.tsx | 394 | Responsive sidebar rail | Memoize sections | 1h |
| All other composites | <350 LOC | Good structure; minor optimization needed | Wrap with memo() where appropriate | 5–8h total |

### ui/ (Minimal Changes)

| File | LOC | Issue | Action | Effort |
|------|-----|-------|--------|--------|
| All files | 30–241 LOC | Healthy; no major issues | Minor: add propTypes/Zod to complex components; no structural changes | 2–3h |

---

## Cross-Module Consolidation Opportunities

### 1. Duplicate Form Patterns
**Files involved:** pages/PluginConfigForm, pages/HeartbeatForm, pages/config-page-sections, composites/form-field/form-field

**Action:**
- Audit form structure and validation patterns
- Consolidate into composites/form-field/
- Create FormSection, FormGrid, FormField compound component
- Estimated effort: 4–6 hours

### 2. Dialog/Modal Consolidation
**Files involved:** pages with modals, composites/chat, ui/confirm-dialog, ui/dialog, ui/admin-dialog

**Action:**
- Document modal hierarchy
- Create composites/modal/ with Modal, ConfirmModal, FormModal templates
- Estimated effort: 3–4 hours

### 3. List/Table Patterns
**Files involved:** pages/DocumentsView, pages/VectorBrowserView, pages/RelationshipsView, pages/HeartbeatsView

**Action:**
- Extract shared list patterns into composites/list/
- Create ListHeader, ListRow, ListFilter, ListPagination components
- Estimated effort: 5–6 hours

### 4. Search/Filter Patterns
**Files involved:** pages/VectorBrowserView, pages/DocumentsView, pages/PluginsView, pages/RelationshipsView, composites/search/

**Action:**
- Consolidate search/filter logic into composites/search/
- Create useSearchWithFilters hook
- Estimated effort: 3–4 hours

---

## Testing Strategy

### Unit Tests (Hooks)
- Test custom hooks created in Phase 1 (useApiCall, useLocalStorage, etc.)
- Test state machines in extracted hooks (useTabState, useDragAndDrop, etc.)
- Coverage goal: >90% for new hooks

### Integration Tests
- Test BrowserWorkspaceView tab switching, wallet interactions
- Test PluginsView install/update flows with mock WebSocket
- Test ChatView voice capture, message editing, attachment upload
- Test page-level modal flows

### Regression Tests
- Snapshot tests for all memoized components
- Performance tests for large lists (500+ items)
- Visual regression tests for sidebar, chat, plugin list

### Performance Tests
- Measure render time before/after memoization
- Profile memory usage for large datasets
- Bundle size impact analysis

---

## Risk Mitigation

### High-Risk Areas
1. **BrowserWorkspaceView wallet interactions** — Webview OOPIF bridge is fragile; test extensively
2. **PluginsView WebSocket subscription** — Error handling gaps; add proper teardown tests
3. **ChatView voice state threading** — Audio playback timing is sensitive; test on real device
4. **sidebar-root.tsx** — Used across entire app; any breakage is visible immediately

### Mitigation:
- Create branch strategy: one branch per high-risk file
- Pair programming on wallet and voice state refactors
- Regression testing checklist before merge
- Staged rollout (feature flags if available)

---

## Success Metrics

After completion of all phases, expect:

| Metric | Target | Method |
|--------|--------|--------|
| **State complexity reduction** | 30–40% fewer useState calls | Count before/after |
| **Memoization coverage** | >80% of composites memoized | Code review checklist |
| **Bundle size** | ±0% (no growth) | webpack-bundle-analyzer |
| **Render performance** | 20–30% fewer re-renders in large views | React DevTools profiler |
| **Test coverage** | >85% for pages/, >90% for composites/ | Jest coverage report |
| **Type safety** | All useCallback/useMemo deps typed | TypeScript strict mode |

---

## Files Created During This Analysis

- This file: `/docs/frontend-cleanup-2026-05-12/01-eliza-ui-components-major.md`

---

## Next Steps

1. **Review this plan** with the team. Identify disagreements on priority or scope.
2. **Create GitHub issues** for each phase with specific acceptance criteria.
3. **Set up monitoring** for bundle size and render performance before starting refactors.
4. **Begin Phase 1** (custom hooks library) immediately; unblock all other phases.


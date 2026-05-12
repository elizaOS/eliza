# Frontend Cleanup Plan: Eliza UI Components
**Date:** 2026-05-12  
**Scope:** `/packages/ui/src/components/{settings,shell,apps,chat}`  
**Total Files:** ~111 (41 settings, 23 shell, 26 apps, 21 chat)  
**Total LOC:** 35,197 lines

---

## Overview

This analysis identifies refactoring opportunities across four high-impact component directories. The codebase exhibits three primary patterns: (1) oversized components with 10+ hooks managing multiple concerns, (2) duplicated state management logic across similar panels, and (3) missing memoization causing potential re-render cascades in message and game rendering.

**Key findings:**
- **2 mega-components** require decomposition (RuntimeGate: 2,370 LOC; GameView: 2,175 LOC)
- **5 large settings panels** (800-1,200 LOC each) exhibit hook complexity and tight coupling
- **Message rendering path** (MessageContent: 1,330 LOC) re-renders entire content on prop changes
- **Settings directory** has 12 hook utilities that could consolidate or lift state
- **Test coverage:** Only 6 test files across ~111 components—under 6%

---

## Critical High-Priority Files

### 1. **RuntimeGate.tsx** (2,370 LOC)
**Location:** `/packages/ui/src/components/shell/RuntimeGate.tsx`

**Issues:**
- **Hook count:** 30+ hooks (useState, useEffect, useCallback, useMemo, useRef)
- **State explosion:** Manages 12+ independent useState declarations for different runtime modes (cloud, local, remote)
- **Tangled concerns:** Auth logic, provisioning polling, gateway discovery, agent creation, error handling in single component
- **Performance:** Multiple useEffect blocks with overlapping dependencies; potential missed cleanup
- **Styling:** 44 inline style={{}} blocks scattered throughout render

**Specific Hook Problems:**
- `pollTimerRef` set in multiple useEffect blocks without centralized cleanup
- `cloudStage` and `localStage` state machines implemented via separate useState instead of useReducer
- `finishAsCloud`, `finishAsRemote`, `finishAsLocal` callbacks defined inline without useCallback memoization
- Effect managing `APP_RESUME_EVENT` listener (line ~700) can orphan listeners on unmount

**Recommended Fixes (Priority: CRITICAL):**
1. **Extract state machine to useReducer** (cloud/local/remote choice + substages)
   - Consolidate `cloudStage` + `error` + `provisionStatus` → single reducer action
   - Move 30 lines of stage-transition logic out of callbacks
   
2. **Split into 3 focused sub-components:**
   - `<RuntimeChooser />` — tile selection + layout (currently ~200 LOC of JSX)
   - `<CloudRuntimeFlow />` — login → agent → provisioning (currently ~800 LOC)
   - `<LocalRuntimeFlow />` — provider selection → save (currently ~300 LOC)
   - `<RemoteRuntimeFlow />` — URL input + validation (currently ~200 LOC)

3. **Hoist polling logic** to a custom hook `useCloudProvisioningPoll(agentId)` with automatic cleanup

4. **Replace inline onSelect/onClick** with memoized useCallback handlers

5. **Extract gateway discovery polling** to `useGatewayDiscovery()` hook

---

### 2. **MessageContent.tsx** (1,330 LOC)
**Location:** `/packages/ui/src/components/chat/MessageContent.tsx`

**Issues:**
- **Hook count:** 8+ hooks (useState, useEffect, useMemo, useRef, useCallback)
- **Segment parsing:** Parses message text on every render looking for choice regions, config blocks, ui-spec markers
- **No memoization:** Entire component lacks React.memo; re-renders on any parent state change
- **Child pass-through:** Renders many children (ChoiceWidget, ConfigRenderer, UiRenderer) without memoization, triggering their full re-renders
- **Permission card logic:** Tightly coupled permission parsing + rendering (lines ~800–1200)
- **Copy-paste risk:** Segment types defined inline; similar logic repeated for choice parsing

**Specific Hook Problems:**
- `segmentCache` or similar not present; `findChoiceRegions()` called every render
- `parsePermissionRequestFromText()` called synchronously during render without memoization
- `useEffect` blocks for permission registry setup (lines ~300–400) could batch

**Recommended Fixes (Priority: CRITICAL):**
1. **Memoize parseMessageSegments()** — extract to standalone function, wrap in useMemo
   ```ts
   const segments = useMemo(
     () => parseMessageSegments(message.content),
     [message.content]
   );
   ```

2. **Extract segment renderers to memoized sub-components:**
   - `<TextSegment memo />` — simple text
   - `<ChoiceSegment memo />` — wraps ChoiceWidget
   - `<ConfigSegment memo />` — wraps ConfigRenderer
   - `<UiSpecSegment memo />` — wraps UiRenderer
   - `<PermissionSegment memo />` — permission card

3. **Lift permission logic** into custom hook `usePermissionRequest(message)` returning parsed request + callbacks

4. **Wrap component in React.memo** with shallow comparison or custom comparator

5. **Move `sanitizePatchValue()` helper** to utils; currently defined in this file but could be shared

---

### 3. **GameView.tsx** (2,175 LOC)
**Location:** `/packages/ui/src/components/apps/GameView.tsx`

**Issues:**
- **Hook count:** 61+ hooks across entire component
- **Polling reflex:** Multiple setInterval-based polls for app run state, session state, window pin state
- **State fragmentation:** 10+ useState declarations for overlay pins, logs, session state, connection status
- **Re-render cascade:** Session state updates trigger re-render of entire iframe embed + logs panel
- **Error handling:** 12+ console.warn calls scattered; no centralized error boundary
- **Styling:** 2 inline style={{}} blocks; heavy reliance on dynamic classNames

**Specific Hook Problems:**
- `useIntervalWhenDocumentVisible()` called multiple times without cleanup guarantee
- `useTimeout()` for session refresh but no cancel on unmount visible at line ~830
- Multiple state updates (pin, logs, session) in separate effects could batch
- Event listeners registered in useEffect without corresponding cleanup functions

**Recommended Fixes (Priority: HIGH):**
1. **Extract polling logic to custom hooks:**
   - `useAppRunPolling(appId)` → returns runState, isLoading, error
   - `useAppSessionPolling(sessionId)` → returns sessionState, isLoading
   - `useWindowPinState(appId)` → returns pinned, setPinned
   
2. **Create reducer for compound state:**
   ```ts
   type GameViewState = {
     sessionState: AppSessionState | null;
     runState: AppRunSummary | null;
     pinned: Set<string>;
     logEntries: LogEntry[];
     connectionError: string | null;
   };
   ```

3. **Extract GameViewOverlay** further if not already:
   - It's 227 LOC; check if it duplicates logic from parent

4. **Batch state updates:** Replace 3 separate useEffect → session/run/pin with single effect orchestrator

5. **Wrap session-dependent children in Error Boundary**

---

### 4. **VaultInventoryPanel.tsx** (908 LOC)
**Location:** `/packages/ui/src/components/settings/vault-tabs/VaultInventoryPanel.tsx`

**Issues:**
- **Hook count:** 12+ hooks (useState for each CRUD operation)
- **Nested modals:** Category picker + key editor + profile manager all layered
- **Reveal timer:** Auto-hide revealed secrets after 10s—manual setTimeout management
- **No error recovery:** Failed requests set error state but don't retry
- **Tight API coupling:** Directly calls client endpoints; no abstraction layer

**Specific Hook Problems:**
- `revealedKeys` state persists revealed values; spec says they should never persist past 10s
- Multiple useCallback definitions without dependency arrays
- useRef not used for interval/timeout IDs; manual clearTimeout calls could leak

**Recommended Fixes (Priority: HIGH):**
1. **Extract reveal timer to custom hook:**
   ```ts
   const useSecretReveal = (ttlMs: number) => {
     const [revealedKey, setRevealed] = useState<string | null>(null);
     // auto-hide after ttlMs
     return { revealedKey, reveal, hide };
   };
   ```

2. **Lift category operations to reducer:**
   - ADD_KEY, UPDATE_KEY, DELETE_KEY actions
   - Consolidate 6+ useState into single state machine

3. **Extract vault API layer:**
   - Create `useVaultOperations()` hook wrapping client calls
   - Returns { add(), update(), delete(), listProfiles(), switchProfile() }

4. **Split into child components:**
   - `<VaultCategoryGroup />` — renders one category's keys
   - `<VaultKeyCard />` — single key + actions
   - `<SecretProfileManager />` — profile CRUD for one key

---

### 5. **DesktopWorkspaceSection.tsx** (1,177 LOC)
**Location:** `/packages/ui/src/components/settings/DesktopWorkspaceSection.tsx`

**Issues:**
- **Hook count:** 15+ hooks (useState for UI state, fetch state, form state)
- **Mixed concerns:** Desktop dev console tail, workspace management, storage quota, permissions all in one component
- **Polling pattern:** Manual setInterval for console log tail without cleanup
- **Type coercion:** Line 326 uses `as unknown` for JSON response; no runtime validation

**Specific Hook Problems:**
- `consoleLogs` state updated via setInterval; no visible clearInterval cleanup
- Multiple form states (workspace name, settings) not consolidated into single form state
- useEffect managing resize observer for console output without AbortController

**Recommended Fixes (Priority: MEDIUM):**
1. **Split into focused sections:**
   - `<WorkspaceManagement />` — name, workspace picker
   - `<DesktopConsoleTail />` — isolated console log viewer
   - `<StorageQuota />` — storage stats + cleanup UI
   - `<PermissionsPane />` — permission toggles

2. **Extract console tail to custom hook:**
   ```ts
   const useDesktopConsoleTail = (enabled: boolean) => {
     const [logs, setLogs] = useState<LogLine[]>([]);
     // manages polling + cleanup
     return logs;
   };
   ```

3. **Add form state consolidation** via useReducer for workspace settings

---

### 6. **VoiceConfigView.tsx** (1,000 LOC)
**Location:** `/packages/ui/src/components/settings/VoiceConfigView.tsx`

**Issues:**
- **Hook count:** 10+ hooks
- **Model selection complexity:** Manages voice model selection with multi-provider support
- **No memoization:** Children re-render when parent state updates
- **Form complexity:** Mix of controlled + uncontrolled inputs

**Specific Hook Problems:**
- `selectedModel` state in useState; should derived from parent voice config context if available
- useEffect for form initialization could use useImperativeHandle if controlled by parent

**Recommended Fixes (Priority: MEDIUM):**
1. Extract voice provider selector to isolated component
2. Wrap model grid in React.memo to prevent cascade re-renders
3. Consider if parent can provide initial model state via context

---

## Cross-Cutting Findings

### A. Settings Directory Duplication (settings/)

**Pattern Match:** 3 similar vault tab components + permission controls + settings sections

Files with similar structure:
- `vault-tabs/OverviewTab.tsx` (859 LOC)
- `vault-tabs/RoutingTab.tsx` (506 LOC)
- `vault-tabs/LoginsTab.tsx` (465 LOC)
- `vault-tabs/SecretsTab.tsx` (38 LOC) ← reuse opportunity
- `permission-controls.tsx` (817 LOC)

**Issue:** Each tab independently manages tabbed content switching, list item expansion, modal dialogs.

**Solution:**
1. Create shared `<VaultTabLayout>` component handling common structure
2. Extract expandable item logic to `<ExpandableListItem>` component
3. Move permission badge rendering to shared `<PermissionBadge>` component
4. Create `useVaultTabState()` hook for pagination, sorting, filtering

---

### B. Chat Message Rendering Path

**Concern:** Every message addition/update causes full MessageContent re-render, which parses text, renders all segments.

**Files involved:**
- `chat/MessageContent.tsx` (1,330 LOC) — main renderer
- `chat/widgets/ChoiceWidget.tsx` (101 LOC) — not memoized
- `chat/widgets/agent-orchestrator.tsx` (549 LOC) — not memoized
- `chat/widgets/browser-status.tsx` (162 LOC) — not memoized
- `chat/widgets/todo.tsx` (210 LOC) — not memoized
- `chat/widgets/music-player.tsx` (224 LOC) — not memoized

**Solution:**
1. Wrap all 5 widget components in React.memo
2. Memoize segment parsing in parent
3. Create a message cache layer to avoid re-parsing identical content

---

### C. Apps Directory: Catalog vs Registry Confusion

**Files involved:**
- `catalog-loader.ts` (72 LOC) — loads full registry
- `apps-cache.ts` (55 LOC) — in-memory cache
- `load-apps-catalog.ts` (84 LOC) — alternative loader?
- `useRegistryCatalog.ts` (79 LOC) — React hook wrapper
- `AppsCatalogGrid.tsx` (555 LOC) — grid renderer

**Issue:** Multiple catalog/registry patterns; unclear which is authoritative source.

**Solution:**
1. Consolidate `catalog-loader.ts` + `load-apps-catalog.ts` into single `appsCatalogApi.ts`
2. Rename `useRegistryCatalog` → `useAppsCatalog` for clarity
3. Create single `APPS_CACHE` strategy with TTL invalidation

---

### D. Shell Component Layer Thickness

**Files:**
- `RuntimeGate.tsx` (2,370 LOC)
- `BugReportModal.tsx` (771 LOC)
- `Header.tsx` (718 LOC)
- `ShellHeaderControls.tsx` (370 LOC)
- `StartupShell.tsx` (343 LOC)
- `ComputerUseApprovalOverlay.tsx` (341 LOC)
- `CommandPalette.tsx` (327 LOC)

**Observation:** 6 components >300 LOC managing chrome, overlays, and startup flow. Consolidation opportunity.

**Solution:**
1. Move overlay layer registration to unified `<ShellOverlays>` (currently 45 LOC—expand it)
2. Extract banner/alert components (ConnectionLostOverlay, RestartBanner, etc.) to shared `<BannerStack>`
3. Consolidate Header + ShellHeaderControls into single smart Header component

---

## Low-Impact Inventory

**Quick Wins (Sub-100 LOC, minimal dependencies):**

| File | LOC | Issue | Fix |
|------|-----|-------|-----|
| `ProviderCard.tsx` | 106 | Static presentation; could be UI primitive | Move to @elizaos/ui package |
| `CloudInstancePanel.tsx` | 122 | Simple form wrapper | Inline into parent or extract control primitives |
| `LoadedPacksList.tsx` | 76 | List renderer only | Could use generic list component |
| `RunningAppsRow.tsx` | 131 | Flex layout only | Candidate for CSS Grid wrapper |
| `appearance-primitives.tsx` | 37 | Theme toggle helpers | Consolidate into shared ThemeToggle |
| `SecretsTab.tsx` | 38 | Minimal implementation | Complete or remove if no longer used |
| `WalletRpcSection.tsx` | 11 | Possible stub | Verify necessity; may be in-progress |
| `DnaLoader.tsx` | 90 | Loading animation | Move to ui primitives; check for duplication with LoadingScreen |
| `ConnectionFailedBanner.tsx` | 81 | Simple banner | Extract to reusable banner component |
| `RestartBanner.tsx` | 79 | Simple banner | Extract to reusable banner component |
| `SystemWarningBanner.tsx` | 70 | Simple banner | Consolidate with other banners |
| `LoadingScreen.tsx` | 136 | Fullscreen loader | Check duplication with DnaLoader |

---

## Hook Anti-Patterns Detected

### Pattern 1: Missing useCallback on Callback Props (Critical)
**Files affected:**
- `RuntimeGate.tsx`: finishAsCloud, finishAsLocal, finishAsRemote not memoized
- `GameView.tsx`: handlePinApp, handleCloseApp handlers recreated every render
- `VaultInventoryPanel.tsx`: onDelete, onEdit, onReveal callbacks

**Fix:** Wrap all callback props in useCallback with explicit dependency arrays

### Pattern 2: useEffect Setting State from Props (Common)
**Pattern:**
```tsx
const [value, setValue] = useState(props.initialValue);
useEffect(() => {
  setValue(props.newValue);
}, [props.newValue]);
```

**Files:**
- `ProviderSwitcher.tsx` (lines ~50–70)
- `VoiceConfigView.tsx` (initialization effect)

**Fix:** Use prop directly if read-only, or lift state to parent if synchronization needed

### Pattern 3: useMemo on Cheap Computations
**Example:** 
- `RuntimeGate.tsx` line ~500: `const runtimeChoices = useMemo(() => resolveRuntimeChoices(...), [...])`
- `resolveRuntimeChoices` is a simple 5-line function; memoization overhead > computation cost

**Fix:** Only useMemo for expensive computations (parsing, sorting, filtering large lists); remove for simple object creation

### Pattern 4: Missing Error Boundaries (12+ try-catch blocks)
**Concentration:**
- `shell/BugReportModal.tsx`: 6 console.warn in error handlers
- `settings/permission-controls.tsx`: 5 console.error, no user feedback
- `apps/GameView.tsx`: 4 console.warn for state updates
- `apps/load-apps-catalog.ts`: 3 warns for fetch failures

**Fix:** Wrap high-risk boundaries (ChatMessage, GameView) in Error Boundary; consolidate error UI

---

## Recommended Refactoring Order

### Phase 1: Foundation (Week 1–2)
1. Create shared `<BannerStack>` component (consolidates banners)
2. Extract `useVaultTabState()` hook (shared by vault tabs)
3. Create message segment cache layer + memoize parsers
4. Wrap all widget components (chat/widgets/*) in React.memo

### Phase 2: High-Impact Decoupling (Week 2–3)
1. **RuntimeGate.tsx** → split into 3 sub-components + useReducer
2. **MessageContent.tsx** → extract segment renderers + memoize children
3. **GameView.tsx** → extract polling hooks + use reducer for state

### Phase 3: Settings Consolidation (Week 3–4)
1. **VaultInventoryPanel.tsx** → use custom hooks, split into child components
2. **DesktopWorkspaceSection.tsx** → split into 4 focused sections
3. **VoiceConfigView.tsx** → extract provider selector, memoize children

### Phase 4: Apps & Catalog Cleanup (Week 4)
1. Consolidate catalog loaders
2. Wrap app renderers in memo
3. Clarify registry vs catalog pattern

### Phase 5: UI Primitives Migration (Ongoing)
1. Move `ProviderCard`, `DnaLoader`, `LoadingScreen` → @elizaos/ui
2. Create banner component library
3. Create expandable list item primitive

---

## Metrics & Monitoring

### Before Refactoring
- **Total LOC:** 35,197
- **Files >800 LOC:** 7
- **Hook instances:** 825+
- **Test coverage:** ~6% (6 test files)
- **Type casting:** 5+ `as any` / `as unknown`

### Target Metrics (Post-Refactoring)
- **Max component LOC:** 500 (split mega-components)
- **Hook instances per component:** 5–8 max (vs. current 30–61)
- **Test coverage:** 25%+ (add 30+ new tests)
- **Zero type casting** (fix `as any` patterns)

### Success Criteria
1. No component >500 LOC without clear module separation
2. All callback props wrapped in useCallback
3. All widget components memoized
4. Message render path uses segment memoization
5. All polling cleanup guaranteed (useRef + clearInterval visible)

---

## File-by-File Checklist

### Settings Directory (41 files)

**Critical (>800 LOC):**
- [ ] `VaultInventoryPanel.tsx` (908) — extract to hooks + children
- [ ] `VoiceConfigView.tsx` (1000) — extract provider selector
- [ ] `DesktopWorkspaceSection.tsx` (1177) — split into 4 sections
- [ ] `OverviewTab.tsx` (859) — use shared VaultTabLayout
- [ ] `SecuritySettingsSection.tsx` (858) — check for duplication
- [ ] `permission-controls.tsx` (817) — extract permission badge renderer

**High (400–800 LOC):**
- [ ] `SubscriptionStatus.tsx` (773) — check memoization
- [ ] `PolicyControlsView.tsx` (770) — simplify state management
- [ ] `SecretsManagerSection.tsx` (650) — consolidate CRUD logic
- [ ] `AppsManagementSection.tsx` (684) — use shared list component
- [ ] `PermissionsSection.tsx` (552) — check for duplication with permission-controls
- [ ] `RoutingTab.tsx` (506) — use shared VaultTabLayout
- [ ] `IdentitySettingsSection.tsx` (489) — check form complexity

**Medium (200–400 LOC):**
- [ ] `ApiKeyConfig.tsx` (399) — validate form handling
- [ ] `AdvancedSection.tsx` (351) — split if >3 concerns
- [ ] `WalletKeysSection.tsx` (355) — verify active usage
- [ ] `AppPermissionsSection.tsx` (333) — check for type casting
- [ ] `ProviderPanels.tsx` (321) — extract sub-panels
- [ ] `ProviderSwitcher.tsx` (263) — watch for useEffect state-setting
- [ ] `RuntimeSettingsSection.tsx` (287) — check fallback pattern
- [ ] `useProviderEntries.ts` (273) — verify hook necessity
- [ ] `settings-sections.ts` (272) — audit exports
- [ ] `useCloudModelConfig.ts` (267) — consolidate with useProviderSelection
- [ ] `CapabilitiesSection.tsx` (222) — check for duplication
- [ ] `ConnectorsSection.tsx` (241) — list component opportunity
- [ ] `LoginsTab.tsx` (465) — use shared VaultTabLayout
- [ ] `useProviderSelection.ts` (364) — verify if consolidates with useProviderEntries

**Low (<200 LOC):**
- [ ] Remaining 17 files: inline or move to primitives as per table above

### Shell Directory (23 files)

**Critical:**
- [ ] `RuntimeGate.tsx` (2370) — SPLIT into 3 sub-components
- [ ] `BugReportModal.tsx` (771) — check error handling

**High:**
- [ ] `Header.tsx` (718) — merge with ShellHeaderControls
- [ ] `ShellHeaderControls.tsx` (370) — merge with Header
- [ ] `StartupShell.tsx` (343) — split startup flow if >3 stages

**Medium:**
- [ ] `ComputerUseApprovalOverlay.tsx` (341) — generic overlay wrapper?
- [ ] `CommandPalette.tsx` (327) — check for memoization

**Low:**
- [ ] `PairingView.tsx`, `LoadingScreen.tsx`, `DnaLoader.tsx`, etc. — move to UI primitives

### Apps Directory (26 files)

**Critical:**
- [ ] `GameView.tsx` (2175) — extract polling hooks + reduce state

**High:**
- [ ] `AppsCatalogGrid.tsx` (555) — wrap items in memo
- [ ] `helpers.ts` (559) — audit utility functions for reusability

**Medium:**
- [ ] `app-identity.tsx` (363) — move to UI primitives
- [ ] `AppsSidebar.tsx` (311) — check memoization
- [ ] `GameViewOverlay.tsx` (227) — check for logic duplication
- [ ] `surfaces/GameOperatorShell.tsx` (252) — verify necessity

**Low:**
- [ ] Consolidate `catalog-loader.ts` + `load-apps-catalog.ts`
- [ ] Move trivial components to primitives

### Chat Directory (21 files)

**Critical:**
- [ ] `MessageContent.tsx` (1330) — memoize parsing + extract renderers

**High:**
- [ ] `widgets/agent-orchestrator.tsx` (549) — wrap in memo
- [ ] `widgets/music-player.tsx` (224) — wrap in memo
- [ ] `widgets/todo.tsx` (210) — wrap in memo
- [ ] `widgets/browser-status.tsx` (162) — wrap in memo

**Medium:**
- [ ] `ConnectorAccountPicker.tsx` (221) — check form complexity
- [ ] `AppsSection.tsx` (369) — optimize app loading

**Low:**
- [ ] `ChoiceWidget.tsx` (101) — wrap in memo if not already
- [ ] `AccountRequiredCard.tsx` (177) — simple card, move to primitives
- [ ] Others: audit test coverage

---

## Type Safety Improvements

**Files with unsafe casts (as any / as unknown):**
1. `/packages/ui/src/components/settings/DesktopWorkspaceSection.tsx:326` — `as unknown`
2. `/packages/ui/src/components/settings/AppPermissionsSection.tsx:59,60,75` — `as unknown[]`
3. `/packages/ui/src/components/apps/launch-history.ts:51` — `as unknown`

**Action:** Validate response types at runtime using Zod or equivalent; replace casts with proper type guards.

---

## Testing Strategy

### Add Tests for:
1. **MessageContent parsing** — verify segment extraction doesn't regress
2. **RuntimeGate state machine** — all runtime choice flows
3. **VaultInventoryPanel CRUD** — key add/delete/reveal
4. **GameView polling cleanup** — ensure timers clear on unmount
5. **Custom hooks** — all new hooks (useVaultTabState, useCloudProvisioningPoll, etc.)

### Target Coverage:
- 100% critical paths (MessageContent, RuntimeGate, GameView)
- 70%+ medium-risk components (Vault, Settings panels)
- 30%+ low-risk presentational components

---

## Implementation Notes

1. **Preserve API compatibility** — refactoring should not change component props or parent integration
2. **Feature branch per component** — split mega-components in isolated PRs
3. **Incremental memoization** — wrap in React.memo in separate pass after splitting
4. **Performance baseline** — capture render counts before/after memoization (React Profiler)
5. **Localization check** — ensure i18n keys preserved during extraction

---

## Conclusion

This codebase exhibits signs of organic growth without periodic refactoring. The mega-components (RuntimeGate, MessageContent, GameView) are the highest-leverage targets, each offering 20–30% reduction in hook complexity and potential elimination of re-render cascades. The settings directory consolidation is lower-risk and provides easy wins through shared patterns. A phased 4-week approach with clear milestones and test gates will de-risk the work while maintaining feature velocity.


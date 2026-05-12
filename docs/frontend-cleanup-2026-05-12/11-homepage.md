# Homepage Frontend Cleanup Plan

**Date:** 2026-05-12  
**Scope:** Two homepages across `/apps/homepage` and `/eliza/packages/homepage`  
**Total Files:** 79 TypeScript/TSX files across both locations

---

## Executive Summary

This monorepo contains **two separate homepages with significant duplication and divergent responsibilities**:

1. **`/apps/homepage`** (Milady dashboard): A full dashboard/docs portal—661 LOC App.tsx, 743 LOC AgentProvider, heavy state management, 49 files
2. **`/eliza/packages/homepage`** (Eliza marketing): A lightweight marketing/auth flow site—three 1.7k–1.4k LOC pages, heavy animation/WebGL, 39 files

The sites serve different purposes but are poorly delineated. The cleanup requires:
- Clear separation of concerns (dashboard vs. marketing)
- Elimination of unused assets in apps/homepage
- Consolidation of UI primitives (Button, auth context, API client)
- Removal of over-engineered animations in the Eliza site
- Elimination of hardcoded marketing copy and stale state management

---

## Directory Structure

### `/apps/homepage` — Dashboard, docs, agent management
```
/apps/homepage/src
├── App.tsx                      (661 LOC) — Dashboard entry; heavy hooks, enum lists
├── ErrorBoundary.tsx            (46 LOC)
├── router.tsx                   (39 LOC)
├── main.tsx                     (28 LOC)
├── components/
│   ├── Nav.tsx                  (164 LOC) — Navigation; 1× inline style
│   ├── dashboard/
│   │   ├── BrandHero.tsx        (154 LOC)
│   │   ├── ConnectionModal.tsx  (160 LOC) — 1× inline style, try-catch
│   │   ├── InstanceCard.tsx     (334 LOC) — Card component; delete confirmation
│   │   ├── InstanceGrid.tsx     (276 LOC) — Grid layout; 1× inline style
│   │   ├── ProvisionAgentModal.tsx (334 LOC) — Form; useRef, polling, 1× inline style
│   │   ├── QuickOpsStrip.tsx    (125 LOC)
│   │   └── useCloudLogin.ts     (136 LOC) — Custom hook; OAuth
│   ├── docs/
│   │   ├── CallOut.tsx          (38 LOC)
│   │   ├── Diagram.tsx          (112 LOC) — Mermaid diagrams; try-catch
│   │   ├── DocsLanding.tsx      (77 LOC) — Card grid; Suspense fallback
│   │   ├── DocsLayout.tsx       (94 LOC)
│   │   ├── DocsPage.tsx         (134 LOC) — MDX renderer; Suspense fallback
│   │   ├── DocsSidebar.tsx      (139 LOC) — Recursive nav; filtering
│   │   ├── DocsTOC.tsx          (74 LOC)
│   │   ├── Screenshot.tsx       (44 LOC)
│   │   ├── Steps.tsx            (23 LOC)
│   │   ├── TierLanding.tsx      (100 LOC)
│   │   └── mdx-components.tsx   (48 LOC) — MDX registry
│   ├── guides/
│   │   └── GuidesLanding.tsx    (327 LOC) — Card grid; heavy copy
│   ├── layout/
│   │   ├── DashboardShell.tsx   (113 LOC) — Layout wrapper
│   │   ├── SessionTile.tsx      (55 LOC)
│   │   └── Sidebar.tsx          (244 LOC) — Sidebar nav; filtering
│   ├── ui/
│   │   ├── FilterChips.tsx      (52 LOC) — Filter component
│   │   └── StatusDot.tsx        (46 LOC) — Status indicator
├── docs/
│   ├── registry.ts              (683 LOC) — Docs registry; 100+ entries
│   ├── mdx.d.ts                 (14 LOC)
│   └── content/                 (MDX files, not scanned)
├── generated/
│   └── release-data.ts          (64 LOC) — Generated; version info
├── lib/
│   ├── AgentProvider.tsx        (743 LOC) — Context + provider; heavy hooks, semaphore
│   ├── auth.ts                  (106 LOC) — Token management; try-catch
│   ├── billing-types.ts         (38 LOC) — Type defs
│   ├── cloud-api.ts             (937 LOC) — API client; heavy types, try-catch
│   ├── connections.ts           (42 LOC) — Connection management; console.warn
│   ├── format.ts                (119 LOC) — Date/time formatters; try-catch
│   ├── open-web-ui.ts           (271 LOC) — Web UI launcher; console.error, try-catch
│   ├── runtime-config.ts        (229 LOC) — Config reader; try-catch, console in dev
│   ├── useAuth.ts               (85 LOC) — Hook; token/user
│   ├── useCloudOpenFlow.ts      (391 LOC) — Complex flow hook; try-catch
│   ├── asset-url.ts             (30 LOC)
│   └── spa-fallback.ts          (27 LOC) — Route fallback; try-catch
├── __tests__/
│   ├── InstanceCard.test.tsx    (60 LOC)
│   ├── open-web-ui.test.ts      (155 LOC)
│   ├── runtime-config.test.ts   (55 LOC)
│   ├── setup.ts                 (49 LOC)
│   └── smoke.test.tsx           (38 LOC)
└── public/
    ├── animations/idle.glb
    ├── vrms/
    │   ├── previews/             (8 PNG previews)
    │   └── shaw.vrm
    ├── black-asset-1,2,3.png     (UNUSED?)
    ├── color-asset-1,2,3.png     (UNUSED?)
    ├── favicon files
    └── logo.png
```

### `/eliza/packages/homepage` — Marketing, auth, leaderboard, 3D
```
/eliza/packages/homepage/src
├── App.tsx                      (38 LOC) — Simple route wrapper
├── main.tsx                     (15 LOC)
├── index.css                    (Tailwind)
├── components/
│   ├── BlobButton.tsx           (112 LOC) — Animated button; @react-spring, 27× inline styles
│   ├── ChatUI/
│   │   └── renderChatToCanvas.ts (1337 LOC) — Canvas chat renderer; console.warn
│   ├── ModelViewers/
│   │   └── ModelB.tsx           (880 LOC) — 3D model viewer; @react-spring/three, @react-three/fiber, @react-three/drei, 60+ module-level state vars
│   ├── QRCode.tsx               (278 LOC) — QR code generator
│   ├── ShaderBackground/
│   │   ├── ShaderBackground.tsx (91 LOC)
│   │   └── gradientWaveMaterial.ts (146 LOC) — THREE.js shader
│   ├── VideoCall.tsx            (131 LOC) — Video preview; @react-spring
│   ├── brand/
│   │   └── eliza-logo.tsx       (7 LOC)
│   ├── landing/
│   │   ├── footer.tsx           (244 LOC) — Footer; 27× inline styles
│   │   ├── hero-chat-input.tsx  (21 LOC)
│   │   ├── landing-background.tsx (31 LOC)
│   │   ├── landing-header.tsx   (87 LOC) — Header with animations
│   │   ├── landing-page.tsx     (27 LOC)
│   │   └── index.ts             (5 LOC)
│   ├── login/
│   │   ├── country-flag.tsx     (37 LOC)
│   │   └── phone-number-input.tsx (178 LOC) — Form input; try-catch
│   ├── providers/
│   │   └── query-provider.tsx   (11 LOC)
│   └── ui/
│       ├── button.tsx           (57 LOC) — Button primitive
│       ├── dropdown-menu.tsx    (70 LOC) — Dropdown menu
│       └── input.tsx            (21 LOC)
├── generated/
│   └── release-data.ts          (82 LOC) — Generated
├── lib/
│   ├── api/
│   │   ├── client.ts            (123 LOC) — Fetch wrapper
│   │   ├── index.ts             (4 LOC)
│   │   ├── query-keys.ts        (12 LOC)
│   │   └── use-elizacloud-mutation.ts (42 LOC)
│   ├── context/
│   │   └── auth-context.tsx     (609 LOC) — Auth provider; heavy state, try-catch
│   ├── hooks/
│   │   └── use-typing-placeholder.ts (57 LOC)
│   ├── contact.ts               (11 LOC)
│   ├── query-client.ts          (19 LOC)
│   ├── spring-types.ts          (4 LOC)
│   ├── utils.ts                 (6 LOC)
├── pages/
│   ├── connected.tsx            (668 LOC) — Connected page; form, icons, try-catch
│   ├── get-started.tsx          (1482 LOC) — Get started flow; heavy state, OAuth logic, try-catch
│   ├── leaderboard.tsx          (1726 LOC) — Leaderboard with 3D; heavy @react-spring, useSprings, drag, 27+ inline styles, console.log
│   ├── login.tsx                (29 LOC) — Login page
│   └── marketing.tsx            (419 LOC) — Marketing page; fallback download buttons
├── types/
│   └── speech-recognition.d.ts  (45 LOC)
├── vite-env.d.ts                (13 LOC)
└── public/
    ├── models/iphone.glb        (3D model)
    ├── elizawallpaper.jpeg      (Used in ChatUI canvas)
    ├── tbg.jpg                  (Telegram background)
    ├── *.png                     (Assets, app/profile images)
    ├── install.ps1, install.sh  (Scripts)
    └── _redirects, _headers      (Netlify config)
```

---

## Findings

### 1. Two Distinct Homepages (Architectural Split)

| Aspect | `/apps/homepage` | `/eliza/packages/homepage` |
|--------|------------------|---------------------------|
| **Purpose** | Dashboard + docs for Milady agents | Marketing + auth flow for Eliza |
| **Package Name** | `@miladyai/homepage` | `eliza-app` |
| **App Complexity** | 661 LOC (App.tsx), 743 LOC provider | 38 LOC (App.tsx), routing only |
| **Primary Feature** | Agent dashboard, MDX docs | 3D marketing, WebGL, phone onboarding |
| **State Mgmt** | Context (AgentProvider), custom hooks | Context (AuthProvider), React Query |
| **Animation** | Minimal | Heavy: @react-spring, Three.js, canvas |
| **Deployment** | milady.ai/* | elizacloud.ai/* (implied) |

**Verdict:** These are two fundamentally different applications. No duplication beyond shared UI patterns (Button, form inputs).

### 2. Unused / Over-Engineered in `apps/homepage`

#### **2a. Unused Assets (Public Directory)**
- **`black-asset-1.png`, `black-asset-2.png`, `black-asset-3.png`** — No grep hits in src code
- **`color-asset-1.png`, `color-asset-2.png`, `color-asset-3.png`** — No grep hits in src code
- **`vrms/previews/milady-*.png` (8 files)** — No usage in src code (the `vrms` feature appears to be dead)
- **`vrms/shaw.vrm`** — Avatar model, likely unused; check if `avatarIndex` in AgentProvider is actually used

**Recommendation:** Delete or audit these before shipping. Check git history for when they were added and if any feature was planned but never shipped.

#### **2b. Over-engineered Polling / State Management**
- **`AgentProvider.tsx` (743 LOC):** 
  - Creates a semaphore (`createSemaphore`) to limit concurrent health probes (6 max)
  - Maintains refs for polling timers in multiple effects
  - Manages agent filtering state locally (no server sync for filters)
  - **Cleanup:** Extract semaphore to utility module, simplify polling state to useReducer
- **`useCloudOpenFlow.ts` (391 LOC):**
  - Complex state machine for cloud login flow (multiple steps, notices, errors)
  - Could be simplified with a state machine library (xstate)
  - **Cleanup:** Extract state transitions to explicit enum or reducer

#### **2c. Console Statements (Should be Removed for Prod)**
- `ErrorBoundary.tsx:23` → `console.error()` OK (error handler)
- `connections.ts:18` → `console.warn()` on missing token storage — should be silent or telemetry
- `open-web-ui.ts:211, 246` → `console.error()` on fallback/pairing — remove, use silent fallback

#### **2d. Try-Catch Blocks Without Proper Error Handling**
Files with try-catch but minimal error recovery:
- `cloud-api.ts` — fetch errors logged but not propagated clearly
- `runtime-config.ts` — env var parsing fallback is silent
- `useCloudOpenFlow.ts` — catch blocks set error state but no retry
- `open-web-ui.ts` — errors swallowed in fallback path

**Recommendation:** Standardize error handling—either throw, log + silent fallback, or emit telemetry event.

### 3. Unused / Over-Engineered in `eliza/packages/homepage`

#### **3a. Inline Styles (27 in leaderboard.tsx alone)**
- **`leaderboard.tsx`** — 27 `style={{}}` inline, mixed with Tailwind
- **`get-started.tsx`** — 1 inline style
- **`footer.tsx`** — 27 inline styles
- **`landing-background.tsx`** — 1 inline style
- **`hero-chat-input.tsx`** — 1 inline style
- **`ShaderBackground.tsx`** — Uses shader for background; heavy setup for a gradient effect
- **`BlobButton.tsx`** — 27 inline styles + @react-spring animations

**Recommendation:** 
- Move all inline styles to Tailwind classes (use `--custom` CSS variables for dynamic values)
- For animations, use Framer Motion (already imported) instead of @react-spring
- `ShaderBackground.tsx` is over-engineered; use CSS `background: linear-gradient` + maybe a single WebGL canvas if parallax is required

#### **3b. Massive Page Components (1700+ LOC)**
- **`leaderboard.tsx` (1726 LOC):**
  - 100+ country mappings (static, should be external)
  - Heavy @react-spring animations (springs, trails, animated SVG)
  - Drag gesture integration
  - Should be: Leaderboard.tsx (500 LOC) + CountrySelector.tsx (200 LOC) + Animations.tsx (300 LOC)

- **`get-started.tsx` (1482 LOC):**
  - Telegram, Discord, iMessage, WhatsApp flows (5 parallel flows)
  - Heavy state machine (13 steps/modes)
  - Should be split: GetStarted.tsx (router) + TelegramFlow.tsx + DiscordFlow.tsx + PhoneInput.tsx

- **`ModelB.tsx` (880 LOC):**
  - 60+ module-level state variables (!) — `let triggerSpin`, `let botResponseIndex`, etc.
  - @react-three/fiber + @react-spring/three setup
  - Coordinate calculations for click detection on 3D model
  - Should use a class or at least useRef + useContext for cleanup

#### **3c. Canvas Rendering (renderChatToCanvas.ts, 1337 LOC)**
- Entire chat UI rendered to canvas for screenshot/export
- Constants like `SCALE = 4`, `W = 390 * SCALE`, `H = 844 * SCALE` (iPhone frame)
- Message lists hardcoded in module
- Heavy measurement calculations
- **Verdict:** Functional but massive for a feature used only in leaderboard. Consider: Is this still needed? If yes, move to separate package.

#### **3d. Over-Engineering: Module-Level State in ModelB.tsx**
```tsx
let triggerSpin: ((direction: 1 | -1) => void) | null = null;
let triggerRestartMessages: (() => void) | null = null;
// ... 50+ more globals
```

This is a red flag. Global mutable state makes the component unreliable in concurrent renders. Should use:
- forwardRef + useImperativeHandle (already attempted but incomplete)
- Or refactor to a state machine + React context

#### **3e. Unused Copy / Stale Endpoints**
- **`marketing.tsx`**: Hardcoded fallback download buttons for GitHub releases
  - Lines 29-83 define `FALLBACK_MAC_BUTTONS`, `FALLBACK_WINDOWS_BUTTONS`, etc.
  - These are fallbacks if release-data.ts generation fails
  - **Question:** Is release-data.ts actually being generated? If yes, remove fallbacks.

### 4. Shared UI Patterns (Minor Duplication)

#### **Button Components**
- **`apps/homepage`** → uses `@elizaos/ui` Button (external)
- **`eliza/packages/homepage`** → defines own `components/ui/button.tsx` (57 LOC)

**Verdict:** Acceptable separation; Eliza site is standalone. No action needed.

#### **Auth Context**
- **`apps/homepage`** → useAuth hook + token management in `lib/auth.ts`
- **`eliza/packages/homepage`** → full AuthContext + TelegramAuthData + OAuth flows in `lib/context/auth-context.tsx`

**Verdict:** Different auth models (cloud token vs. Telegram/Discord OAuth). No consolidation needed.

#### **Form Inputs**
- **`apps/homepage`** → Text inputs use HTML + styling
- **`eliza/packages/homepage`** → `components/ui/input.tsx`, `PhoneNumberInput.tsx`

**Verdict:** Minimal overlap. Eliza site has country selector logic; no duplication.

### 5. Documentation Registry (Apps/Homepage Specific)

**`docs/registry.ts` (683 LOC):**
- Central registry of 100+ doc pages (lazy-loaded MDX)
- Routes: `/docs`, `/docs/:tier`, `/docs/:tier/:slug`
- Tiers: beginner, intermediate, advanced, developer

**Assessment:**
- Structure is clean (no stale entries found)
- Lazy loading is good for performance
- No maintenance issues detected

**Recommendation:** Keep as-is; well-organized.

### 6. Test Coverage

#### **apps/homepage**
- 5 test files totaling 352 LOC
- Covers: InstanceCard, open-web-ui, runtime-config, smoke test
- **Gap:** No tests for AgentProvider, cloud-api, useCloudOpenFlow

#### **eliza/packages/homepage**
- No test files
- **Gap:** No tests for auth flow, 3D components, canvas rendering

### 7. Code Smells Summary

| Category | Count | Severity | Files |
|----------|-------|----------|-------|
| Console statements | 6 | Low | ErrorBoundary, connections, open-web-ui, leaderboard, renderChatToCanvas, auth-context |
| Try-catch blocks | 18 | Medium | cloud-api, runtime-config, format, open-web-ui, useCloudOpenFlow, auth, diagram, etc. |
| Inline `style={{}}` | 35 | Low | leaderboard (27), footer (27), others |
| Module-level state | 60+ | High | ModelB.tsx (globals for animation triggers) |
| Over-sized files | 5 | Medium | leaderboard (1726), get-started (1482), renderChatToCanvas (1337), AgentProvider (743), cloud-api (937) |
| Unused assets | 8+ | Low | black/color assets, VRM previews |
| No type coercions | 0 | — | (Good! No `as any`) |

---

## Detailed Cleanup Checklist

### Phase 1: Remove Dead Code & Assets (Low Risk)

**apps/homepage:**
- [ ] Delete `/public/black-asset-*.png` (3 files)
- [ ] Delete `/public/color-asset-*.png` (3 files)
- [ ] Audit `/public/vrms/previews/` — if not used, delete (8 PNG files)
- [ ] Audit `/public/vrms/shaw.vrm` — check if `avatarIndex` feature exists
  - If unused, delete; if used, document in README
- [ ] Remove `console.warn` in `lib/connections.ts:18` (silent fallback is OK)
- [ ] Remove `console.error` in `lib/open-web-ui.ts:211, 246` (use telemetry instead if needed)

**eliza/packages/homepage:**
- [ ] Verify `pages/marketing.tsx` download fallbacks are still needed
  - If release-data.ts is always generated, remove fallbacks (lines 29-83)

**Effort:** ~2 hours (mostly audit + deletion)  
**Risk:** Low (non-code assets; console statements in fallback paths)

### Phase 2: Refactor Large Components (Medium Risk)

**apps/homepage:**

**`AgentProvider.tsx` (743 LOC):**
- [ ] Extract `createSemaphore` to `lib/semaphore.ts`
- [ ] Simplify polling logic: replace nested effects with useReducer for polling state
- [ ] Reduce provider surface: move `filteredAgents` logic to caller (App.tsx already filters)
- **Target:** 600 LOC → 450 LOC

**`useCloudOpenFlow.ts` (391 LOC):**
- [ ] Define state enum: `type Step = "welcome" | "loading" | "success" | "error"`
- [ ] Extract notice display logic to separate component
- [ ] Use useReducer instead of 4 useState calls
- **Target:** 391 LOC → 250 LOC

**`open-web-ui.ts` (271 LOC):**
- [ ] Extract URL rewriting logic to `lib/url-rewrite.ts`
- [ ] Standardize error handling: either throw or silent fallback (not mixed)
- **Target:** 271 LOC → 180 LOC

**`cloud-api.ts` (937 LOC):**
- [ ] Extract type definitions to `lib/cloud-api-types.ts` (–300 LOC)
- [ ] Extract API methods to separate client class: `CloudApiClient` (already exists, but inline)
- [ ] Consolidate error handling: single `handleApiError` function
- **Target:** 937 LOC → 650 LOC (types in separate file)

**Effort:** ~20 hours (refactoring + testing)  
**Risk:** Medium (changes to core providers; needs regression testing)

**eliza/packages/homepage:**

**`leaderboard.tsx` (1726 LOC):**
- [ ] Extract country data to `lib/countries.ts`
- [ ] Extract animations to `components/LeaderboardAnimations.tsx`
- [ ] Create `components/CountrySelector.tsx` for country filtering
- [ ] Create `components/LeaderboardGrid.tsx` for table layout
- **Target:** 1726 LOC → 500 LOC (main) + 200 LOC (sub-components)

**`get-started.tsx` (1482 LOC):**
- [ ] Create state machine: `lib/onboarding-state.ts`
- [ ] Extract flows: `components/TelegramFlow.tsx`, `components/DiscordFlow.tsx`, etc.
- [ ] Extract phone input to `components/PhoneInputFlow.tsx`
- **Target:** 1482 LOC → 400 LOC (main) + 300 LOC (sub-components)

**`ModelB.tsx` (880 LOC):**
- [ ] **Critical:** Replace module-level state with useRef + useReducer
- [ ] Extract 3D setup logic to `lib/three-setup.ts`
- [ ] Create `components/ChatBubbleRenderer.tsx` for message UI
- [ ] Use Context or ref forwarding to communicate with child components
- **Target:** 880 LOC → 550 LOC (main) + 200 LOC (utils)

**`renderChatToCanvas.ts` (1337 LOC):**
- [ ] Extract message data to `lib/chat-messages.ts`
- [ ] Extract drawing functions to `lib/canvas-draw.ts` (–400 LOC)
- [ ] Create `lib/canvas-measurements.ts` for size calculations
- **Target:** 1337 LOC → 600 LOC (main) + 300 LOC (helpers)

**Effort:** ~30 hours (refactoring + testing animations)  
**Risk:** Medium–High (animations are fragile; needs careful testing)

### Phase 3: Consolidate Styling (Low Risk)

**eliza/packages/homepage:**
- [ ] `leaderboard.tsx`: Convert 27 `style={{}}` to Tailwind classes
  - Use CSS variables for dynamic values (e.g., `style={{ width: `${width}px` }}` → `className="w-[--w]" style={{ '--w': `${width}px` }}`)
- [ ] `footer.tsx`: Convert 27 inline styles to Tailwind
- [ ] `BlobButton.tsx`: Use Framer Motion instead of @react-spring for simpler animations
- [ ] `ShaderBackground.tsx`: Evaluate if WebGL is needed—if just a gradient, use CSS

**Effort:** ~8 hours  
**Risk:** Low (visual regression; needs design review)

### Phase 4: Error Handling Standardization (Medium Risk)

**Both homepages:**
- [ ] Define error handling policy:
  - **Policy A:** Always throw + let component handle
  - **Policy B:** Return `{ success: false, error: string }` (functional style)
  - **Policy C:** Silent fallback + emit telemetry event
- [ ] Apply consistently across:
  - `cloud-api.ts` (fetch errors)
  - `auth-context.tsx` (OAuth errors)
  - `phone-number-input.tsx` (validation)
  - `open-web-ui.ts` (pairing fallback)
- [ ] Add optional error logger/telemetry hook

**Effort:** ~6 hours  
**Risk:** Medium (behavior change; needs end-to-end testing)

### Phase 5: Test Coverage (Medium Effort)

**apps/homepage:**
- [ ] Add tests for `AgentProvider.tsx` (provider behavior, polling)
- [ ] Add tests for `useCloudOpenFlow.ts` (state transitions)
- [ ] Add tests for error cases in `cloud-api.ts`

**eliza/packages/homepage:**
- [ ] Add tests for `auth-context.tsx` (login flows)
- [ ] Add snapshot tests for major pages (marketing, get-started)
- [ ] Add integration tests for OAuth flows

**Effort:** ~16 hours  
**Risk:** Low (tests don't change behavior; helps prevent regressions)

---

## Summary of Changes

### High Priority (Ship in Sprint 1)

1. **Remove dead assets** (2h)
   - Delete unused PNGs and VRM files from `apps/homepage/public`
   - Verify marketing fallback buttons in eliza package

2. **Fix console statements** (1h)
   - Remove debug logs from production code
   - Keep error logging in error boundaries + add telemetry

3. **Extract types from cloud-api.ts** (4h)
   - Move 300 LOC of types to separate file
   - Improves readability and reusability

### Medium Priority (Sprint 2)

4. **Refactor large components** (30h)
   - Split leaderboard, get-started, ModelB into smaller pieces
   - Extract utilities and data modules
   - This enables testing + easier refactoring in future

5. **Consolidate inline styles** (8h)
   - Convert to Tailwind + CSS variables
   - Improves performance (fewer style calculations) and maintainability

6. **Standardize error handling** (6h)
   - Choose single pattern and apply consistently
   - Reduces bugs + makes testing easier

### Low Priority (Nice-to-Have)

7. **Expand test coverage** (16h)
   - Focus on critical paths (auth, agent health)
   - Regression tests for animations

8. **Performance review**
   - Lazy-load heavy components (leaderboard, 3D)
   - Audit bundle sizes after refactoring

---

## Files to Monitor

| File | LOC | Status | Next Action |
|------|-----|--------|------------|
| `/apps/homepage/src/App.tsx` | 661 | Stable | Extract large objects to consts |
| `/apps/homepage/src/lib/AgentProvider.tsx` | 743 | Refactor | Extract semaphore + polling |
| `/apps/homepage/src/lib/cloud-api.ts` | 937 | Refactor | Extract types to separate file |
| `/eliza/packages/homepage/src/pages/leaderboard.tsx` | 1726 | Refactor | Split into 3–4 components |
| `/eliza/packages/homepage/src/pages/get-started.tsx` | 1482 | Refactor | Create state machine + split flows |
| `/eliza/packages/homepage/src/components/ModelViewers/ModelB.tsx` | 880 | Refactor | Replace module state with useRef |
| `/eliza/packages/homepage/src/components/ChatUI/renderChatToCanvas.ts` | 1337 | Refactor | Extract draw functions |

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|-----------|
| Delete VRM/asset files | Low | Grep codebase first; check git history |
| Refactor AgentProvider | Medium | Add tests before refactoring; use Feature Flags for rollout |
| Split leaderboard component | Medium | Snapshot tests + visual regression tests |
| Replace ModelB state | High | Extensive testing; consider rewrite in Framer Motion |
| Standardize error handling | Medium | Audit all error paths; add telemetry for monitoring |

---

## Success Criteria

- [ ] No unused assets in public directories
- [ ] No components > 800 LOC (max 4–5 components per file)
- [ ] All try-catch blocks have documented error handling strategy
- [ ] Console statements removed from production paths
- [ ] 100% test coverage for AgentProvider, auth flows, and error cases
- [ ] Inline `style={{}}` eliminated in favor of Tailwind
- [ ] Bundle size unchanged or reduced (measure pre- and post-)


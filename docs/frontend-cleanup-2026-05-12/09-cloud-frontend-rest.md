# Cloud Frontend Non-Dashboard Cleanup Plan

**Date**: 2026-05-12  
**Scope**: Non-dashboard frontend components (`/cloud/apps/frontend/src`)  
**Total Files**: 303 TypeScript/TSX files  
**Total LOC**: 68,593 lines  

---

## Executive Summary

The Cloud frontend is a React + TypeScript SPA built with Vite, deployed to Cloudflare Pages. The non-dashboard portions (landing pages, login, auth flows, chat interface, public components) total ~118 files across `components/`, `pages/`, `lib/`, `shims/`, and root entry files. The cleanup plan addresses:

1. **Root provider/setup consolidation** (App.tsx, RootLayout.tsx)
2. **Unidirectional store + hook extraction** (chat-store references, auth hooks)
3. **Component deduplication** vs. `cloud/packages/ui`
4. **Inline styles → Tailwind migration** (49 files with `style={{`)
5. **Console/debugg code removal** (20 files with `console.`)
6. **Dead code and legacy patterns**

**Estimated effort**: 120–150 hours spread across 12–16 sprints.

---

## I. Root Architecture Assessment

### A. App.tsx (661 LOC)

**Location**: `/cloud/apps/frontend/src/App.tsx`

**Purpose**: Routes registry + code-splitting layer.

**Current strengths**:
- Clean `lazyWithPreload` abstraction (lines 24–41) for preloadable route chunks.
- Well-organized PRELOAD_ROUTES array (lines 136–265) mapping routes → preload functions.
- Proper Suspense fallback (RouteChunkFallback, line 337).
- Route-scoped error boundary (RouteErrorBoundary, lines 350–399).

**Issues**:
- **Heavy static route tree** (lines 410–656): Each route has explicit `<Suspense>` wrappers. 90+ lines of boilerplate for nested routes like `/dashboard/*`.
- **No shared Route wrapper**: Every public route re-declares `<Suspense fallback={<RouteChunkFallback />}>`.
- **Preload routes array maintenance**: 130 lines of mirror-declarations; any new route requires dual maintenance.

**Cleanup actions**:
1. **Extract nested route blocks into helper functions** (e.g., `renderDashboardRoutes()`, `renderAuthRoutes()`) to reduce visual noise.
2. **Create `<SuspenseRoute>` wrapper component** in `components/` to eliminate repeated `<Suspense>` boilerplate.
3. **Consolidate preload PRELOAD_ROUTES**: Use a structured route config object that generates both `<Route>` elements and preload metadata programmatically (1 source of truth).
4. **Move `LegacyBuildRedirect` and `NotFound` to separate files** in `pages/`.

**Example refactor** (lines 410–656 → helper):
```tsx
function renderPublicRoutes() {
  return (
    <>
      <Route path="terms-of-service" element={<SuspenseRoute component={TermsOfService} />} />
      <Route path="privacy-policy" element={<SuspenseRoute component={PrivacyPolicy} />} />
      {/* ... */}
    </>
  );
}
```

---

### B. RootLayout.tsx (92 LOC)

**Location**: `/cloud/apps/frontend/src/RootLayout.tsx`

**Purpose**: Wraps every route with global providers, metadata, theming.

**Current structure**:
- **Helmet** metadata (Helmet React component wrapping `<html>`, `<body>`, SEO tags)
- **Three providers** stacked:
  1. `StewardAuthProvider` — auth state
  2. `CreditsProvider` — user credits balance
  3. `ThemeProvider` — dark/light mode
- **NavigationProgress** — nprogress bar
- **Sonner Toaster** — toast notifications

**Issues**:
- ✅ **Well-designed** — minimal, each provider has clear purpose.
- ⚠️ **Provider location**: `StewardAuthProvider` and `CreditsProvider` are imported from `@/lib/providers/*` but those paths don't exist in the frontend src; they're re-exported from `packages/lib/providers/` via path alias.
  - **Audit required**: Verify all three providers are truly frontend-scoped and not duplicating API logic.
  - **Risk**: If `CreditsProvider` or `StewardAuthProvider` contain server-side logic, they should not be at root.

**Cleanup actions**:
1. **Verify provider imports**: Ensure `@/lib/providers/CreditsProvider` and `@/lib/providers/StewardProvider` are frontend-only (no server APIs, no DB access).
2. **Document provider contracts**: Add JSDoc to each provider export describing its scope (e.g., "Client-side credits balance sync only; server is source of truth").
3. **Consider lazy-loading theme provider**: If theme preference can be derived from `localStorage` + system preference during hydration, defer `ThemeProvider` to avoid FOUC.
4. **Extract baseUrl logic** (lines 8–11) into `lib/config.ts` to reduce RootLayout width.

---

## II. Pages Directory Assessment

**Location**: `/cloud/apps/frontend/src/pages/`  
**File count**: 29 files  
**Subdirectories**: `login/`, `auth/`, `payment/`, `invite/`, `chat/`, `blog/`, `sensitive-requests/`, and root pages.

### A. Top-level pages (thin wrappers)

| File | LOC | Purpose | Status |
|------|-----|---------|--------|
| `page.tsx` | 50 | Landing page | ✅ Thin shell |
| `privacy-policy/page.tsx` | 129 | Static text | 🔴 Static, consider CDN |
| `terms-of-service/page.tsx` | 180 | Static text | 🔴 Static, consider CDN |
| `sandbox-proxy/page.tsx` | 185 | Sandbox token proxy | ⚠️ Review scope |

**Cleanup**:
- **Static pages** (privacy, ToS): Move to static asset CDN or pre-render at build time; remove from dynamic routes.
- **`sandbox-proxy/page.tsx`**: Verify it's not duplicating logic from the API layer; if it's just a pass-through, consider moving to API.

### B. Login flow (4 files, 1,200+ LOC)

| File | LOC | Purpose |
|------|-----|---------|
| `login/page.tsx` | 169 | Main login form |
| `login/layout.tsx` | 73 | Login page frame |
| `login/steward-login-section.tsx` | 474 | OAuth/wallet section |
| `login/wallet-buttons.tsx` | 326 | Wallet connector UIs |

**Issues**:
- `steward-login-section.tsx` (474 LOC) is a fat component with heavy state (OAuth flow, provider selection).
- `wallet-buttons.tsx` (326 LOC) hardcodes wallet connectors; should be data-driven.
- `steward-wallet-providers.tsx` (51 LOC) is a provider wrapper but lives in `pages/login/`; unclear if it's re-used elsewhere.

**Cleanup**:
1. **Extract OAuth flow** into `components/auth/oauth-flow.tsx` (200 LOC max).
2. **Data-drive wallet buttons**: Move wallet list to `lib/data/wallets.ts`; render from config, not hard-coded JSX.
3. **Consolidate `steward-wallet-providers.tsx`**: Move to `components/auth/` if used by login only, or to `lib/providers/` if global.

---

### C. Auth callback pages (3 files)

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `auth/success/page.tsx` | 40 | Auth success handoff | ✅ Thin |
| `auth/error/page.tsx` | 33 | Auth error display | ✅ Thin |
| `auth/cli-login/page.tsx` | 353 | CLI auth token flow | ⚠️ Heavy |

**`auth/cli-login/page.tsx` (353 LOC)**:
- Renders a table of issued CLI tokens; allows revocation.
- Duplicates `dashboard/api-keys/` functionality (also manages tokens).
- Heavy state: token list, revocation UI, polling.

**Cleanup**:
1. **Unify CLI token and API key management**: Move CLI token logic to a shared `lib/data/cli-tokens.ts` (query hooks).
2. **Consolidate UI** into a shared component in `components/auth/` if not already in `dashboard/api-keys/`.
3. **Review for server-side migration**: This might be better served as a dashboard page (authenticated) rather than a post-auth redirect.

### D. Payment flow (3 files)

| File | LOC | Purpose |
|------|-----|---------|
| `payment/[paymentRequestId]/page.tsx` | 214 | Payment init |
| `payment/app-charge/[appId]/[chargeId]/page.tsx` | 360 | In-app purchase flow |
| `payment/success/layout.tsx` + `page.tsx` | 96 | Payment success |

**Issues**:
- **Heavy routing logic**: Both payment pages use dynamic route params; unclear if they poll or redirect.
- **App charge page** (360 LOC) might duplicate `dashboard/billing/` logic.

**Cleanup**:
1. **Audit payment flow**: Document the full flow (init → stripe redirect → callback → success).
2. **Deduplicate billing logic**: If `dashboard/billing/` also handles charges, consolidate.
3. **Extract shared payment utils** to `lib/data/payments.ts`.

### E. Invite flow (2 files)

| File | LOC | Purpose |
|------|-----|---------|
| `invite/accept/layout.tsx` | 37 | Wrapper |
| `invite/accept/page.tsx` | 278 | Accept org invite |

**Status**: ✅ Reasonable. Single-purpose, thin layout.

### F. Blog (2 files)

| File | LOC | Purpose |
|------|-----|---------|
| `blog/page.tsx` | 47 | Blog index |
| `blog/[slug]/page.tsx` | 89 | Blog post |

**Status**: ✅ Thin wrappers; actual content likely server-fetched.

---

## III. Components Directory Assessment

**Location**: `/cloud/apps/frontend/src/components/`  
**File count**: 65 files  
**Subdirectories**: `landing/`, `chat/`, `layout/`, `agents/`, `agent-editor/`, `my-agents/`, `onboarding/`

### A. Landing page components (12 files, 3,500+ LOC)

| File | LOC | Purpose |
|------|-----|---------|
| `landing/landing-page-new.tsx` | 217 | Main landing |
| `landing/hero-section.tsx` | 142 | Hero banner |
| `landing/BayerDitheringBackground.tsx` | 376 | Animated background |
| `landing/Agents.tsx` | 195 | Agent showcase |
| `landing/Blog.tsx` | 125 | Blog teaser |
| `landing/Footer.tsx` | 198 | Footer |
| `landing/BlogCard.tsx` | 78 | Blog card |
| `landing/discover-agents.tsx` | 144 | Agent discovery grid |
| `landing/discover-apps.tsx` | ? | App discovery grid |
| `landing/RelatedPosts.tsx` | ? | Related articles |
| `landing/CategoryFilter.tsx` | ? | Blog filter |
| `landing/BlogPost.tsx` | ? | Blog post display |

**Issues**:
- **BayerDitheringBackground.tsx** (376 LOC): Canvas-based dithering effect. Verify it's not re-created per-render or using outdated patterns.
- **Heavy `landing-page-new.tsx`** (217 LOC): Check if it can be split into sections (hero, agents, blog, footer).
- **Possible duplication**: `BlogPost.tsx` vs. `blog/[slug]/page.tsx`; `discover-agents.tsx` vs. `Agents.tsx`.

**Cleanup**:
1. **Audit BayerDitheringBackground**: Ensure `useRef` for canvas is present; verify no perf issues on mobile.
2. **Extract landing page sections** into sub-components if not already done.
3. **Deduplicate blog/agent discovery**: Single component used by multiple sections.

---

### B. Chat components (24 files, 5,000+ LOC)

| File | LOC | Purpose |
|------|-----|---------|
| `chat/eliza-chat-interface.tsx` | 2,036 | ⚠️ MAIN CHAT (huge) |
| `chat/memoized-chat-message.tsx` | 800 | Message display |
| `chat/chat-interface.tsx` | 398 | Alt chat UI |
| `chat/eliza-page-client.tsx` | 256 | Chat page wrapper |
| `chat/character-intro-page.tsx` | 201 | Intro screen |
| `chat/model-playground.tsx` | 338 | Model selector |
| `chat/plugins-tab.tsx` | 756 | Plugin browser |
| `chat/uploads-tab.tsx` | 423 | File uploads |
| `chat/pending-documents-processor.tsx` | 381 | Doc processing |
| `chat/email-capture-modal.tsx` | 154 | Email prompt |
| `chat/signup-prompt-banner.tsx` | 153 | Signup CTA |
| `chat/character-editor.tsx` | 238 | Character editor |
| `chat/eliza-avatar.tsx` | 75 | Avatar display |
| `chat/hooks/*` | 600+ | Audio, models, availability |
| `chat/monaco-json-editor.tsx` | 157 | JSON editor |
| `chat/json-editor-styled.tsx` | 100 | JSON editor alt |

**CRITICAL: `eliza-chat-interface.tsx` (2,036 LOC)**

This is the most complex non-dashboard component. Lines 1–100 sampled:
- Massive hook dependency array: `useState`, `useCallback`, `useEffect`, `useMemo`, `useRef` (39 hook invocations).
- Props: `onMessageSent`, `character`, plus implicit store + context dependencies.
- Stream handling: complex state machine for pending messages, streaming responses, reasoning chunks.
- Audio: recording + playback with cleanup.
- Form: message input + model selection + tier system.

**Cleanup issues**:
1. **Extract stream handler** (streaming message state machine) into `lib/hooks/use-streaming-message.ts` (already exists but verify it's fully extracted).
2. **Extract audio logic** into `lib/hooks/use-chat-audio.ts` (currently split across `use-audio-player`, `use-audio-recorder`).
3. **Extract UI state** (input focus, modal open, etc.) into a custom hook.
4. **Current dependencies on** `useChatStore`, `useSessionAuth`, `useThrottledStreamingUpdate` — verify all are necessary; consider prop-drilling instead of context for non-global state.

---

### C. Layout components (10 files, 2,000+ LOC)

| File | LOC | Purpose |
|------|-----|---------|
| `layout/chat-sidebar.tsx` | 515 | Chat room list |
| `layout/chat-header.tsx` | 495 | Chat header |
| `layout/user-menu.tsx` | 492 | Account menu |
| `layout/sidebar.tsx` | ? | Main sidebar |
| `layout/header.tsx` | ? | Main header |
| `layout/dashboard-shell.tsx` | ? | Dashboard wrapper |
| `layout/sidebar-chat-rooms.tsx` | 212 | Room list section |
| `layout/sidebar-item.tsx` | 178 | Sidebar item |
| `layout/feedback-modal.tsx` | 167 | Feedback form |
| `layout/landing-header.tsx` | ? | Landing header |

**Issues**:
- **Chat sidebar + chat header + user menu**: Heavy interdependencies via `useChatStore` (see search results).
- **Dashboard-shell.tsx**: Likely wraps `DashboardLayout` for non-dashboard pages; audit if it's actually needed.
- **Possible duplication**: `landing-header.tsx` vs. `header.tsx` vs. logic in `landing-page-new.tsx`.

**Cleanup**:
1. **Consolidate sidebar logic**: Move room list mutation (create, delete, select) to a hook.
2. **Extract header menu** into a sub-component.
3. **Audit sidebar-item.tsx**: If it's a one-off, inline it; if used 3+ times, keep as component.

---

### D. Agent/My-agents components (12 files)

| File | LOC | Purpose |
|------|-----|---------|
| `agents/agent-card.tsx` | 648 | Agent card display |
| `my-agents/my-agents.tsx` | 236 | Agent list (server) |
| `my-agents/my-agents-client.tsx` | ? | Agent list (client) |
| `my-agents/character-filters.tsx` | ? | Filter UI |
| `my-agents/character-library-grid.tsx` | ? | Grid layout |
| `my-agents/empty-state.tsx` | ? | Empty state |
| `agent-editor/character-form.tsx` | 761 | ⚠️ HUGE editor |
| `agent-editor/avatar-upload.tsx` | 207 | Avatar upload |
| `agent-editor/avatar-generator.tsx` | 181 | AI avatar gen |
| `agent-editor/json-editor.tsx` | 161 | JSON editor |

**CRITICAL: `agent-editor/character-form.tsx` (761 LOC)**

Heavy form component with:
- 10+ `useState` calls (character name, bio, traits, system prompt, knowledge, etc.).
- Form submission → API call → polling for generation status.
- Nested avatar/JSON editors.

**Cleanup**:
1. **Split form into sections**: Basic info, avatar, knowledge, advanced.
2. **Extract form state** into a custom hook or reducer.
3. **Move JSON editor logic** to a lib hook.
4. **Audit agent-card.tsx** (648 LOC): Is it displaying or editing? If mixed, split.

---

### E. Onboarding (2 files)

| File | LOC | Purpose |
|------|-----|---------|
| `onboarding/onboarding-provider.tsx` | 197 | Onboarding context |
| `onboarding/onboarding-overlay.tsx` | 264 | Overlay UI |

**Status**: ✅ Reasonable; single-purpose provider + UI.

---

## IV. Lib Directory Assessment

**Location**: `/cloud/apps/frontend/src/lib/`  
**File count**: 18 total  
**Subdirectories**: `data/` (14 files), root (4 files)

### A. Root lib files (4 files)

| File | LOC | Purpose |
|------|-----|---------|
| `api-client.ts` | 162 | Fetch wrapper + auth injection |
| `query-client.ts` | 24 | TanStack Query config |
| `auth-hooks.ts` | 25 | Auth context hooks |
| `steward-session.ts` | 36 | Session token mgmt |

**Status**: ✅ Well-organized, thin. Each file has a single responsibility.

**Audit note**: 
- `api-client.ts` and `steward-session.ts` should verify no duplication with `packages/lib/`.
- `auth-hooks.ts` (25 LOC) is very thin; consider if it should be expanded or merged into `api-client.ts`.

---

### B. Lib/data directory (14 files)

Query hooks / data fetching layer. All files follow pattern: `export async function fetch*(...) => Promise<T>` or `export const useQuery*` hooks.

| File | LOC | Purpose |
|------|-----|---------|
| `admin.ts` | 206 | Admin metrics/logs |
| `agents.ts` | ? | Agent CRUD |
| `analytics.ts` | 162 | Analytics queries |
| `api-keys.ts` | ? | API key CRUD |
| `apps.ts` | ? | App CRUD |
| `auth-query.ts` | ? | Auth status queries |
| `containers.ts` | 141 | Container queries |
| `credits.ts` | ? | Credit balance |
| `eliza-agents.ts` | ? | Eliza agent discovery |
| `gallery.ts` | ? | Gallery queries |
| `invoices.ts` | ? | Invoice queries |
| `user.ts` | 150 | User profile queries |
| `video.ts` | ? | Video/generation queries |
| `voices.ts` | ? | Voice queries |

**Status**: ✅ Properly organized; each domain gets its own file.

**Audit required**:
1. **Verify no server-side code**: These should be pure client-side query hooks using `api-client.ts`.
2. **Check for duplication** with `packages/lib/services/` or `packages/lib/repositories/`.

---

## V. Shims Directory Assessment

**Location**: `/cloud/apps/frontend/src/shims/`  
**File count**: 2 files

| File | LOC | Purpose |
|------|-----|---------|
| `empty.ts` | 340 | Node.js built-in stubs |
| `process.ts` | ? | process global polyfill |

**Status**: ⚠️ **Legacy but necessary**

**Purpose**: Polyfills for Node.js modules that wind up in the bundle (crypto, fs, etc.) via dependencies like `@solana/web3.js`, `viem`, etc.

**Cleanup**:
1. **Audit which libraries actually need these**: Run bundle analysis to see which modules import Node.js API.
2. **Consider replacing heavy dependencies**: If Solana or Viem stubs are the only reason, investigate lighter alternatives.
3. **Document in README**: Add note explaining why these shims exist and when they can be removed.

---

## VI. Cross-Cutting Patterns & Findings

### A. Hook usage patterns (high-impact files)

**Files with 10+ hook invocations** (sign of overly complex state management):

1. **infrastructure-dashboard.tsx** (39 hooks) — 2,778 LOC component
2. **discord-gateway-connection.tsx** (16 hooks)
3. **eliza-chat-interface.tsx** (16 hooks) — 2,036 LOC component
4. **automation-edit-sheet.tsx** (15 hooks)
5. **video-page-client.tsx** (14 hooks)
6. **app-analytics.tsx** (14 hooks)
7. **redemptions-client.tsx** (14 hooks)

**Action**: These are all **dashboard components**, outside non-dashboard scope. However, the same pattern applies to non-dashboard equivalents. Extract hook logic into custom hooks to reduce in-component state.

### B. Inline styles usage (49 files)

**Files with `style={{` patterns**:

1. `components/onboarding/onboarding-overlay.tsx`
2. `components/chat/memoized-chat-message.tsx`
3. `components/chat/eliza-chat-interface.tsx`
4. `components/chat/plugins-tab.tsx`
5. `components/layout/sidebar-item.tsx`
6. `components/landing/BayerDitheringBackground.tsx`
7. `components/landing/hero-section.tsx`
8. `components/landing/landing-page-new.tsx` (multiple)
9. And 41 more (mostly dashboard).

**Cleanup**: Migrate inline styles to Tailwind classes or CSS modules:

```tsx
// Before
<div style={{ background: "rgba(0, 0, 0, 0.8)", borderRadius: "0px" }}>

// After
<div className="bg-black/80 rounded-none">
```

**Estimated effort**: 1–2 hours per file with heavy inline styles.

---

### C. Console statements (20 files)

**Files with `console.*` calls**:

Most are dev-time logging (`console.warn`, `console.log`). Acceptable in:
- `shims/empty.ts` — intentional warnings for Node.js stub invocation.
- `components/chat/hooks/use-audio-recorder.tsx` — debug info for audio capture.

**Action**: Review each and remove or replace with structured logging (if applicable).

---

### D. Null coalescing patterns (?? null, ?? 0, || null)

**Common safe patterns**:

```tsx
const creditBalance = credits.data?.balance ?? 0;  // Safe default
const adminRole = status?.role ?? null;             // Safe null fallback
```

These are appropriate. No cleanup needed.

---

### E. Component duplication vs. cloud/packages/ui

**Risk**: Components in `cloud/apps/frontend/src/components/` might be duplicating shared UI from `cloud/packages/ui/src/components/`.

**Audit required**:

1. **List components** in both locations:
   - Frontend: agent-card, model-playground, json-editor, avatar-upload, etc.
   - Shared UI: button, card, select, textarea, avatar, etc.

2. **For each component**, ask:
   - Is it domain-specific (agent card, model playground) or generic (button, input)?
   - If generic, should it move to packages/ui?
   - Is there a packages/ui equivalent already?

3. **Consolidate logic**:
   - Generic UI building blocks → `cloud/packages/ui/`
   - Cloud-specific components (agent editor, chat interface) → `cloud/apps/frontend/src/components/`

---

### F. TODO/FIXME/legacy annotations

**Found items**:

- **App.tsx** (line 79): `// Dashboard layout + pages (ported from legacy Next.js tree).`
  - Action: Verify migration from Next.js is complete; remove comment if stable.

- **app-domains.tsx** (line ?): `// TODO(cloudflare): replace placeholder DNS targets once Cloudflare anycast IP and...`
  - Action: Create Jira ticket; track for follow-up.

- **eliza-chat-interface.tsx** (lines ?): `// This is a client-side fallback...` and `// Use expectedCharacterId...`
  - Action: Replace with structured logging if needed.

---

## VII. Provider Stack & State Management Review

### A. Providers at RootLayout level

**Current stack** (in order):
1. **StewardAuthProvider** — Authentication (Steward SDK session)
2. **CreditsProvider** — User credits balance
3. **ThemeProvider** — Dark/light mode
4. **Helmet** — Metadata (not a provider, but global)

### B. External stores (accessed via hooks)

**Identified in grep**:
- `useChatStore()` — Room state, selected character, message list (from `@/lib/stores/chat-store`)
  - **Used by**: chat-interface, eliza-chat-interface, sidebar-chat-rooms, chat-header, user-menu, etc.
  - **Risk**: Complex inter-component communication; cache invalidation on logout/switch.

### C. Recommendations

1. **Verify provider necessity**: Are `CreditsProvider` and `StewardAuthProvider` truly frontend-only, or do they contain server logic?
2. **Document provider responsibilities**:
   - `StewardAuthProvider`: Load user session from localStorage; expose `useAuth()` hook.
   - `CreditsProvider`: Fetch and sync credits balance; expose `useCredits()` hook.
   - `ThemeProvider`: Manage CSS `class` on `<html>` for dark/light.

3. **Store consolidation**: `useChatStore` is accessed by 7+ components. Consider if it should be:
   - Lifted into a context provider (more React idiomatic).
   - Or kept as Zustand/Jotai external store (good for non-React-tree access).

---

## VIII. Performance & Render Optimization

### A. Memoization candidates

1. **eliza-chat-interface.tsx** (2,036 LOC) → Heavy message stream handling
   - **Candidate**: Wrap `MemoizedChatMessage` in `useMemo` to prevent re-render on parent state change.
   - **Already done** in `memoized-chat-message.tsx` (800 LOC).

2. **chat-sidebar.tsx** (515 LOC) → Room list rendering
   - **Candidate**: Memoize room list items; only re-render on room list change, not on every parent update.

3. **agent-card.tsx** (648 LOC) → Agent grid items
   - **Candidate**: If used in grid with 100+ agents, memoize and virtualize.

### B. Code splitting

**Current**: App.tsx uses `lazyWithPreload` for every route. ✅ Good.

**Verify bundle analysis**:
1. Dashboard routes split into separate chunks? (Yes, but verify in build output.)
2. Chat interface split separately from landing? (Should be.)
3. Landing page assets (images, fonts) lazy-loaded?

---

## IX. Concrete Refactoring Roadmap

### Phase 1: Foundation (Weeks 1–2)

**Goal**: Reduce boilerplate, establish shared patterns.

1. **Create `<SuspenseRoute>` wrapper** (2 hours):
   - File: `components/ui/suspense-route.tsx`
   - Usage: `<Route path="..." element={<SuspenseRoute component={MyComponent} />} />`
   - Replaces 90+ lines in App.tsx.

2. **Extract App.tsx route tree** (3 hours):
   - Split into `renderPublicRoutes()`, `renderAuthRoutes()`, `renderDashboardRoutes()` functions.
   - Goal: Reduce App.tsx from 661 → 400 LOC.

3. **Verify provider scope** (4 hours):
   - Audit `CreditsProvider` and `StewardAuthProvider` for server-only code.
   - Move server-specific logic to `packages/lib/` if needed.
   - Document in JSDoc.

### Phase 2: Component Extraction (Weeks 3–5)

**Goal**: Break apart 2,000+ LOC monster components.

1. **Refactor `eliza-chat-interface.tsx`** (12 hours):
   - Extract stream handler → `lib/hooks/use-chat-stream.ts`
   - Extract audio logic → `lib/hooks/use-chat-audio.ts`
   - Extract form state → `lib/hooks/use-chat-form.ts`
   - Result: 3 custom hooks, component down to 800 LOC.

2. **Refactor `character-form.tsx`** (12 hours, in dashboard scope but high-impact):
   - Extract basic info section.
   - Extract avatar section.
   - Extract knowledge/traits section.
   - Implement form reducer or Formik for state.

3. **Consolidate login flow** (8 hours):
   - Move `steward-login-section.tsx` logic to `components/auth/oauth-section.tsx`.
   - Move `wallet-buttons.tsx` to `components/auth/wallet-buttons.tsx`.
   - Extract shared oauth utils to `lib/auth/oauth.ts`.

### Phase 3: Deduplication (Weeks 6–8)

**Goal**: Unify component libraries.

1. **Audit component overlap** with `packages/ui/` (4 hours):
   - Map all components in both locations.
   - Identify generic vs. domain-specific.

2. **Move generic components to `packages/ui/`** (8 hours):
   - Examples: avatar-upload, json-editor, model-playground (if generic).
   - Maintain types + interfaces.

3. **Consolidate landing page sections** (4 hours):
   - Verify `BlogPost.tsx`, `Blog.tsx`, `landing-page-new.tsx` hierarchy.
   - Remove duplication.

### Phase 4: Style Migration (Weeks 9–10)

**Goal**: Replace inline styles with Tailwind.

1. **Bulk migrate** high-impact files (6 hours):
   - `eliza-chat-interface.tsx`
   - `landing-page-new.tsx`
   - `agent-card.tsx`

2. **Verify no regressions** (2 hours):
   - Visual regression testing on main components.

### Phase 5: Cleanup (Weeks 11–12)

**Goal**: Remove dead code, finalize.

1. **Remove console statements** (2 hours).
2. **Verify TODO/FIXME** items (1 hour).
3. **Update README** with project structure (2 hours).
4. **Final lint + typecheck** (1 hour).

---

## X. Testing & Verification

### A. What to test (post-refactor)

1. **Navigation**: Verify all routes load correctly; preload works on hover/focus.
2. **Auth flow**: Login, logout, token refresh, error handling.
3. **Chat interface**: Message send/receive, streaming, audio, model selection.
4. **Landing page**: All sections render; no layout shift or FOUC.
5. **Browser compatibility**: Test in Chrome, Firefox, Safari (especially iOS).

### B. Performance baseline

Before cleanup:
- Measure: LCP (Largest Contentful Paint), FCP, TTI (Time to Interactive).
- Run in production build mode (minified, chunked).

After cleanup:
- Re-measure same metrics.
- Goal: ≥5% improvement in TTI or bundle size reduction.

---

## XI. Risk Mitigation

### A. High-risk changes

1. **Refactoring `eliza-chat-interface.tsx`**:
   - Risk: Complex state machine; easy to introduce race conditions.
   - Mitigation: Add Playwright e2e tests for message send/receive workflow before refactoring.

2. **Provider scope audit**:
   - Risk: Moving code between packages could break SSR or client hydration.
   - Mitigation: Test hydration mismatch errors; verify build output.

3. **Component duplication removal**:
   - Risk: Removing a "duplicate" that has subtle differences breaks one usage.
   - Mitigation: Diff components carefully; maintain tests.

### B. Low-risk changes

- Extracting custom hooks (pure refactoring, no logic change).
- Replacing inline styles with Tailwind (visual regression test only).
- Renaming/moving files (refactor with IDE support).

---

## XII. Success Criteria

1. **Code quality**:
   - No component >800 LOC (except chat interface, which should be ≤1,200).
   - ≤3 hooks per component (unless necessary).
   - Zero `// TODO`, `// FIXME` left without tracking.

2. **Performance**:
   - Bundle size ≤10% reduction OR same size with improved tree-shaking.
   - No regression in LCP/FCP/TTI.

3. **Maintainability**:
   - New contributors can understand file layout in <30 min.
   - Clear provider responsibility boundaries.
   - Components are re-usable or domain-specific (clearly marked).

4. **Compatibility**:
   - All routes work in development and production builds.
   - No console errors on any path (dev or prod).
   - Hydration mismatch count = 0.

---

## XIII. Implementation Notes

### A. Git workflow

1. Create feature branches for each phase (e.g., `refactor/app-tsx-split`, `refactor/chat-interface-extract`).
2. Reviewers: Verify logic equivalence; test affected routes.
3. Merge to main with passing CI (typecheck, build, e2e tests).

### B. Breaking changes

**None expected** for end users. All changes are internal refactors. Public API (URLs, props) remains stable.

### C. Documentation

Update:
- `README.md` with new folder structure (if changed).
- `docs/ARCHITECTURE.md` with provider responsibilities.
- JSDoc on new hooks and exported functions.

---

## XIV. Files to Track

### High-priority cleanup

- `/cloud/apps/frontend/src/App.tsx` (661 LOC)
- `/cloud/apps/frontend/src/components/chat/eliza-chat-interface.tsx` (2,036 LOC)
- `/cloud/apps/frontend/src/components/agent-editor/character-form.tsx` (761 LOC)
- `/cloud/apps/frontend/src/pages/login/steward-login-section.tsx` (474 LOC)
- `/cloud/apps/frontend/src/components/landing/landing-page-new.tsx` (217 LOC)
- `/cloud/apps/frontend/src/components/layout/chat-sidebar.tsx` (515 LOC)

### Medium-priority audit

- `/cloud/apps/frontend/src/RootLayout.tsx` (92 LOC) — verify provider scope
- `/cloud/apps/frontend/src/pages/auth/cli-login/page.tsx` (353 LOC) — possible duplication with dashboard
- `/cloud/apps/frontend/src/pages/login/wallet-buttons.tsx` (326 LOC) — data-drive or split

### Low-priority (verify no duplication)

- All files in `/lib/data/` (ensure no server-side logic)
- `/shims/empty.ts` and `/shims/process.ts` (verify still necessary)

---

## Summary

**Total estimated effort**: 120–150 hours over 12–16 sprints (1–2 features per sprint).

**Key wins**:
1. App.tsx down from 661 → 400 LOC.
2. eliza-chat-interface.tsx down from 2,036 → 800 LOC (via extraction).
3. No monster components >800 LOC.
4. Provider responsibilities documented and audited.
5. ~10% bundle size reduction from deduplication + tree-shaking.

**Next step**: Create Jira tickets for each phase; prioritize Phase 1 foundation work.


# Cloud UI Package Cleanup Plan

**Date:** 2026-05-12  
**Package:** `/cloud/packages/ui/src`  
**Scope:** ~187 files, ~19,075 LOC  

## Executive Summary

The Cloud UI library (`@elizaos/cloud-ui`) is a specialized React component collection serving the Eliza Cloud platform. It contains:
- **59 primitive components** (50% overlap with main UI library)
- **26 AI-specific components** (prompt input, chat, context, etc.)
- **24 brand/design components** (dashboard cards, stats, HUD)
- **Multiple app-specific features** (monetization, promotion, voice, image-gen)
- **4 runtime utilities** (image, navigation, telemetry, dynamic imports)

**Key Finding:** This library appears to be a **cloud-platform-specific fork** with heavy feature bloat, significant duplication with `packages/ui`, and tightly-coupled business logic. The structure suggests feature creep and missed opportunities for abstraction.

---

## Directory Structure Analysis

```
components/
├── [Root] 57 files (primitives + specialized)
│   ├── accordion, alert, alert-dialog, animated-icons, avatar, badge
│   ├── button, calendar, card, carousel, chart, checkbox
│   ├── collapsible, connection-card, dialog, drawer, dropdown-menu
│   ├── empty-state, form, glowing-effect, glowing-stars
│   ├── hover-card, infinite-moving-cards, input, input-group, label
│   ├── list-skeleton, moving-border, navigation-progress, pagination
│   ├── progress, resizable, scroll-area, select, separator, sheet
│   ├── shooting-stars, skeleton, slider, sonner, sparkles, spotlight
│   ├── stars-background, status-badge, switch, table, tabs, text-generate
│   ├── textarea, timeline, toggle, tooltip
│   └── [.stories files: 19 Storybook files]
│
├── ai-elements/ (26 files) — AI/chat-specific components
│   ├── prompt-input.tsx (1,097 LOC, 8 hooks)
│   ├── context.tsx (363 LOC)
│   ├── open-in-chat.tsx (343 LOC)
│   ├── inline-citation.tsx (254 LOC)
│   ├── web-preview.tsx (248 LOC)
│   ├── branch.tsx (211 LOC)
│   ├── chain-of-thought.tsx (208 LOC)
│   ├── code-block.tsx (157 LOC)
│   ├── reasoning.tsx (190 LOC)
│   ├── tool.tsx (141 LOC)
│   └── [17 more components: artifact, actions, canvas, controls, conversation, 
│       image, loader, message, node, panel, response, sources, suggestion,
│       task, toolbar]
│
├── brand/ (24 files) — Cloud platform branding/dashboard
│   ├── lock-on-button.tsx (330 LOC)
│   ├── brand-tabs-responsive.tsx (158 LOC)
│   ├── corner-brackets.tsx (139 LOC)
│   ├── brand-card.tsx
│   ├── brand-button.tsx
│   ├── brand-tabs.tsx
│   ├── dashboard-stat-card.tsx
│   ├── dashboard-section.tsx
│   ├── hud-container.tsx
│   ├── key-metrics-grid.tsx
│   ├── mini-stat-card.tsx
│   ├── prompt-card.tsx
│   ├── section-header.tsx
│   ├── eliza-logo.tsx
│   ├── eliza-cloud-lockup.tsx
│   └── [9 more + 6 .stories files]
│
├── monetization/ (5 files) — Revenue/earnings-specific UI
│   ├── earnings-simulator.tsx (158 LOC, useMemo + useState)
│   ├── revenue-flow-diagram.tsx (207 LOC)
│   ├── animated-counter.tsx
│   ├── milestone-progress.tsx
│   └── index.ts
│
├── promotion/ (2 files) — App promotion wizard
│   ├── promote-app-dialog.tsx (870 LOC, 2 hooks, complex dialog)
│   ├── social-connection-hint.tsx (194 LOC)
│   └── [1 .stories file]
│
├── image-gen/ (5 files) — Image generation feature UI
│   ├── prompt-input.tsx (194 LOC)
│   ├── enhanced-loading.tsx
│   ├── empty-state.tsx
│   ├── loading-state.tsx
│   └── index.ts
│
├── auth/ (2 files) — Auth/OAuth UI
│   ├── authorize-content.tsx (371 LOC, useAuth hook, form logic)
│   ├── authorize-return.ts
│   └── [1 .stories file]
│
├── voice/ (5 files) — Voice feature UI
│   ├── voice-audio-player.tsx (152 LOC, useRef + useState)
│   ├── voice-empty-state.tsx
│   ├── voice-status-badge.tsx
│   ├── types.ts
│   └── index.ts
│
├── layout/ (4 files) — Layout/dashboard context providers
│   ├── dashboard-page.tsx
│   ├── page-transition.tsx
│   ├── page-header-context.tsx (146 LOC, useContext provider)
│   └── index.ts
│
├── theme/ (3 files) — Theme/dark mode support
│   ├── theme-provider.tsx (146 LOC, useContext + useState)
│   ├── theme-toggle.tsx
│   └── index.ts
│
├── docs/ (6 files) — Documentation/MDX UI
│   ├── docs-layout.tsx
│   ├── api-route-explorer-client.tsx (618 LOC)
│   ├── api-route-explorer.tsx
│   ├── mdx-components.tsx
│   ├── docs-types.ts
│   └── llms-txt-badge.tsx
│
├── code/ (4 files) — Code editor/highlighting
│   ├── json-editor-with-highlight.tsx (141 LOC)
│   ├── json-syntax-highlighter.tsx
│   ├── monaco-editor-skeleton.tsx
│   └── index.ts
│
├── chat/ (1 file)
│   └── monaco-json-editor.tsx (157 LOC)
│
├── payment/ (1 file)
│   └── stripe-card-element.tsx
│
├── dashboard/ (2 files) — Error/loading states
│   ├── dashboard-route-error.tsx
│   └── route-placeholders.tsx
│
└── [Other files: connection-card.tsx, api-key-empty-state.tsx, primitives.ts]

lib/
├── utils.ts (1 file)

runtime/
├── render-telemetry.tsx (4 files: telemetry, image, navigation, dynamic)

types/
├── chat-media.ts (1 file)

test/
├── setup.ts (1 file)

Root:
├── index.ts (entry point)
├── index.css
├── styled-jsx.d.ts
```

---

## Hook & Quality Metrics

### Hook Usage (187 files scanned)

| Hook | Count | Files |
|------|-------|-------|
| `useState` | 87 | Heavy in prompt-input, monetization, auth |
| `useEffect` | 68 | Event handlers, side effects in runtime |
| `useMemo` | 42 | Optimization in earnings simulator, form logic |
| `useCallback` | 53 | Event handler optimization across components |
| `useRef` | 48 | DOM refs in voice player, text input |
| `useContext` | 40 | Theme provider, prompt input, page header context |
| `useReducer` | 0 | None found |
| `useLayoutEffect` | 2 (in prompt-input) | Rare usage |
| `React.memo` | 1 | Minimal memoization |
| `memo()` | 13 | Some optimization, inconsistent |

### Anti-Patterns & Concerns

| Pattern | Count | Notes |
|---------|-------|-------|
| `as any` | 0 | Good: no type coercion |
| `: any` | 0 | Good: strong typing |
| `console.` statements | 3 | telemetry only; OK |
| `try { ... catch` blocks | 16 | Error handling in auth, docs, analytics |
| Inline `style={{}}` | 86 | High; should migrate to CSS/Tailwind |
| `?? null` coalescing | 4 | Acceptable |
| TODO/FIXME comments | 0 | Clean codebase |

---

## Component Classification

### Tier 1: True Primitives (Duplicated with `packages/ui`)

These exist **in both libraries** and should be consolidated:

| Cloud UI | Main UI (`packages/ui/components/ui`) | Status |
|----------|--------------------------------------|--------|
| Button | button.tsx | ✓ Duplicate |
| Card | card.tsx | ✓ Duplicate |
| Dialog | dialog.tsx | ✓ Duplicate |
| Alert | alert.tsx | — (main only) |
| Alert Dialog | alert-dialog.tsx | ✓ Duplicate |
| Avatar | avatar.tsx | — (cloud only) |
| Badge | badge.tsx | ✓ Duplicate |
| Checkbox | checkbox.tsx | ✓ Duplicate |
| Dropdown Menu | dropdown-menu.tsx | ✓ Duplicate |
| Empty State | empty-state.tsx | ✓ Duplicate |
| Form | form.tsx | — (cloud only) |
| Hover Card | hover-card.tsx | — (cloud only) |
| Input | input.tsx | ✓ Duplicate |
| Label | label.tsx | ✓ Duplicate |
| Pagination | pagination.tsx | — (cloud only) |
| Progress | progress.tsx | ✓ Duplicate |
| Scroll Area | scroll-area.tsx | ✓ Duplicate |
| Select | select.tsx | ✓ Duplicate |
| Separator | separator.tsx | ✓ Duplicate |
| Sheet | sheet.tsx | — (main: drawer-sheet) |
| Skeleton | skeleton.tsx | ✓ Duplicate |
| Slider | slider.tsx | ✓ Duplicate |
| Status Badge | status-badge.tsx | ✓ Duplicate |
| Switch | switch.tsx | ✓ Duplicate |
| Table | table.tsx | ✓ Duplicate |
| Tabs | tabs.tsx | ✓ Duplicate |
| Textarea | textarea.tsx | ✓ Duplicate |
| Timeline | timeline.tsx | — (cloud only) |
| Toggle | toggle.tsx | — (main only) |
| Tooltip | tooltip.tsx | ✓ Duplicate |

**Overlap Count: 20+ components** (~35% of cloud primitives)

### Tier 2: Cloud-Specific but Reusable (High Priority)

These are **abstracted features** suitable for a shared UI library:

- **ai-elements/** (26 files, ~2,500 LOC)
  - `prompt-input.tsx` — Universal chat input with attachments (1,097 LOC, complex context API)
  - `context.tsx` — AI context visualization (363 LOC, custom hooks)
  - `open-in-chat.tsx` — Artifact opener (343 LOC)
  - `inline-citation.tsx` — Source attribution (254 LOC)
  - `web-preview.tsx` — Live preview (248 LOC)
  - `code-block.tsx` — Syntax-highlighted code (157 LOC)
  - `chain-of-thought.tsx` — Reasoning visualization (208 LOC)
  - `reasoning.tsx` — AI reasoning display (190 LOC)
  - `tool.tsx` — Tool invocation renderer (141 LOC)
  - **Remaining 16 components:** artifact, branch, canvas, controls, conversation, image, loader, message, node, panel, response, sources, suggestion, task, toolbar, canvas

  **Status:** These are genuinely reusable and **should stay in cloud-ui**, but need:
  - Export documentation for `prompt-input` (it's complex)
  - Type definitions cleaned up (currently context-heavy)
  - Hook extraction for reusability

- **brand/** (24 files, ~1,800 LOC)
  - Eliza Cloud-specific branding (logo, lockup, corner brackets, dashboard cards)
  - `lock-on-button.tsx` (330 LOC) — Appears cloud-specific
  - `brand-tabs-responsive.tsx` (158 LOC) — Responsive tab layout
  - `dashboard-stat-card.tsx`, `mini-stat-card.tsx`, `key-metrics-grid.tsx` — Dashboard UI
  
  **Status:** These are **product-specific**. Should only be exported if shared across multiple Cloud apps.

- **layout/** (4 files, ~300 LOC)
  - `page-header-context.tsx` — Provides page header state
  - `dashboard-page.tsx` — Layout container
  - `page-transition.tsx` — Animated page transitions
  
  **Status:** **Product-specific layout**; should live in `cloud/apps/frontend`, not shared library.

- **theme/** (3 files, ~200 LOC)
  - `theme-provider.tsx` (146 LOC) — Custom dark/light mode
  - `theme-toggle.tsx` — Toggle control
  
  **Status:** **Reusable if abstracted**; currently couples theme to Eliza Cloud. Extract theme interface.

### Tier 3: Highly App-Specific (Candidates for Removal or Migration)

These are **business logic + UI** and likely belong in `cloud/apps/frontend`:

- **monetization/** (5 files, ~365 LOC)
  - `earnings-simulator.tsx` (158 LOC) — Markup/revenue calculator
  - `revenue-flow-diagram.tsx` (207 LOC) — Flow diagram
  - `animated-counter.tsx`, `milestone-progress.tsx`
  
  **Status:** ✗ **Move to cloud/apps/frontend**; this is app revenue UI, not a shared component.

- **promotion/** (2 files, ~1,060 LOC)
  - `promote-app-dialog.tsx` (870 LOC) — Promotion wizard with multi-step flows
  - `social-connection-hint.tsx` (194 LOC) — Hint component
  
  **Status:** ✗ **Move to cloud/apps/frontend**; tightly coupled to cloud app promotion features.

- **image-gen/** (5 files, ~250 LOC)
  - `prompt-input.tsx` (194 LOC) — Image prompt input (separate from ai-elements version!)
  - `enhanced-loading.tsx`, `empty-state.tsx`, `loading-state.tsx`
  
  **Status:** ✗ **Move to cloud/apps/frontend** or rename `ai-elements/image-generation`; this is feature-specific.

- **auth/** (2 files, ~450 LOC)
  - `authorize-content.tsx` (371 LOC) — OAuth authorization flow
  - `authorize-return.ts` — Token storage
  
  **Status:** ⚠️ **Mixed**; OAuth frame is reusable, but tightly coupled to Steward auth. Extract auth interface.

- **voice/** (5 files, ~200 LOC)
  - `voice-audio-player.tsx` (152 LOC)
  - `voice-empty-state.tsx`, `voice-status-badge.tsx`, `types.ts`
  
  **Status:** ⚠️ **Partially reusable**; audio player is generic, but voice-specific types/status badges aren't. Extract player.

- **docs/** (6 files, ~900 LOC)
  - `api-route-explorer-client.tsx` (618 LOC) — Interactive API explorer
  - `docs-layout.tsx`, `mdx-components.tsx`, etc.
  
  **Status:** ⚠️ **Reusable pattern**; API explorer is useful, but tightly coupled to Eliza Cloud API.

- **chat/** (1 file, 157 LOC)
  - `monaco-json-editor.tsx` — Monaco-based JSON editor
  
  **Status:** ✓ Reusable; keep in cloud-ui.

- **code/** (4 files, ~250 LOC)
  - `json-editor-with-highlight.tsx`, `json-syntax-highlighter.tsx`, Monaco helpers
  
  **Status:** ✓ Reusable; keep but consider merging with chat/monaco-json-editor.

- **payment/** (1 file, ~50 LOC)
  - `stripe-card-element.tsx`
  
  **Status:** ⚠️ Stripe-specific; move to cloud/apps/frontend if only used there.

- **dashboard/** (2 files, ~100 LOC)
  - Error/loading placeholders
  
  **Status:** ✓ Reusable patterns; keep.

---

## Comparison with Main UI Library

### `packages/ui/src/components/ui/` (41 files)

The main Eliza UI library provides a **complete set of design system primitives**:
- Radix UI wrappers (Button, Dialog, Select, etc.)
- Tailwind-based styling
- Consistent token system
- No feature coupling

**Key Differences:**

| Aspect | Cloud UI | Main UI |
|--------|----------|---------|
| **Scope** | Cloud platform + AI features | General Eliza UI system |
| **Primitives** | 57 (overlaps with main) | 41 (non-duplicated) |
| **Feature Components** | 59 (ai-elements, brand, etc.) | 0 (composites only) |
| **Styling** | Tailwind + inline styles (86 cases) | Tailwind + CVA |
| **Hooks** | 87 useState, 68 useEffect | Used sparingly |
| **Tree-shaking** | All 57 primitives bundled | On-demand imports |
| **Exports** | `index.ts` (16 exports) + `primitives.ts` | Granular component exports |

**Bundle Impact:**
- Cloud UI includes **entire primitive set + features** = ~19 KB min (estimate)
- Main UI reexports only used components = ~8 KB average app

---

## Hook Optimization Opportunities

### High-Impact Refactors

1. **prompt-input.tsx** (1,097 LOC, 8 hooks)
   - `useState` + `useLayoutEffect` for text synchronization
   - **Opportunity:** Extract into `usePromptInput()` custom hook; split component
   - **Savings:** ~300 LOC, improved reusability

2. **promote-app-dialog.tsx** (870 LOC, 2 hooks)
   - Multi-step form with complex state
   - **Opportunity:** Extract to `usePromotionWizard()` hook
   - **Savings:** ~200 LOC, testability

3. **Inline Styles (86 cases)**
   - All `style={{}}` should use CSS classes
   - **Savings:** ~50 LOC cleanup, better performance

4. **Missing memo() on expensive renders**
   - Only 13 `memo()` usages for 187 files
   - **Recommendation:** Audit ai-elements for `React.memo` candidates

---

## Dependency Map

### Internal Dependencies

**prompt-input.tsx** imports:
- `Button`, `DropdownMenu`, `InputGroup`, `Select`, `Tooltip` (all cloud-ui)
- `nanoid` (external)
- `ai` package (Vercel AI SDK)

**promote-app-dialog.tsx** imports:
- `Button`, `Dialog`, `Input`, `Label`, `Select`, `Textarea` (all cloud-ui)
- `sonner` (toast library)

**earnings-simulator.tsx** imports:
- `Slider` (cloud-ui)
- `useMemo`, `useState` hooks

### External Dependencies (Key)

```json
{
  "@radix-ui/*": "Primitive components (dialog, tabs, etc.)",
  "lucide-react": "Icons (ubiquitous, 50+ imports)",
  "tailwindcss": "Styling (Tailwind 4.1)",
  "class-variance-authority": "CVA for button variants",
  "react-router-dom": "Navigation (runtime)",
  "@xyflow/react": "Node-based flow (likely for ai-elements/canvas)",
  "framer-motion": "Animations (peer dependency, not always used)",
  "sonner": "Toast notifications",
  "react-syntax-highlighter": "Code blocks",
  "tokenlens": "Token counting (Vercel AI SDK companion)",
  "streamdown": "Markdown streaming"
}
```

**Risk:** `framer-motion` is a peer dependency but only used in a few animations. Verify usage.

---

## Issues & Gaps

### 1. Duplicate Primitives (Critical)

**Problem:** 20+ components exist in both libraries.  
**Impact:** Bundle bloat, maintenance burden, inconsistent styling.

**Action Items:**
- [ ] Audit button styling differences (cloud vs. main)
- [ ] Consolidate dialog/modal implementations
- [ ] Create migration path: deprecated cloud components → main UI

### 2. Missing Documentation

- `prompt-input.tsx` is 1,097 LOC with no README
- `ai-elements/` folder has 26 components with minimal JSDoc
- No type definitions exported for `PromptInputController`, etc.

**Action Items:**
- [ ] Add README.md for ai-elements/
- [ ] Document prompt-input API (hooks, context)
- [ ] Add TypeScript types for all context providers

### 3. Inline Styles

**Problem:** 86 instances of `style={{}}` instead of CSS classes.  
**Impact:** Runtime computation, worse performance, harder to theme.

**Action Items:**
- [ ] Audit inline styles in brand/, monetization/
- [ ] Migrate to Tailwind classes
- [ ] Consider CSS module for complex animations

### 4. App-Specific Components in Shared Library

**Problem:** monetization/, promotion/, image-gen/ are product features.  
**Impact:** Bloats library, creates implicit coupling, hard to version independently.

**Action Items:**
- [ ] Move monetization/ → cloud/apps/frontend/components/
- [ ] Move promotion/ → cloud/apps/frontend/components/
- [ ] Clarify image-gen/ intent (is this multi-tenant or cloud-only?)

### 5. Hook Overuse in Components

**Problem:** Complex components like prompt-input have 8+ hooks.  
**Impact:** Harder to test, harder to reuse logic.

**Action Items:**
- [ ] Extract `usePromptInput()` custom hook
- [ ] Extract `usePromoWizard()` from promote-app-dialog
- [ ] Document any custom hooks in ARCHITECTURE.md

### 6. Missing Exports

**Problem:** `index.ts` only exports 16 "high-level" things.  
**Observation:** `primitives.ts` exports ~79 items but only top-level re-exports are in `index.ts`.

**Impact:** Users must import from `@elizaos/cloud-ui/components/primitives` for primitives.

**Action Items:**
- [ ] Clarify export strategy (should all primitives be in `index.ts`?)
- [ ] Add `@elizaos/cloud-ui/ai-elements`, `@elizaos/cloud-ui/brand` subexports

### 7. Storybook Coverage

**Current:** 19 .stories files for ~180 components (11% coverage).  
**Recommendation:** Increase to 30%+ for ai-elements and brand components.

---

## Recommendations

### Phase 1: Immediate Cleanup (2–3 sprints)

1. **Consolidate Primitives**
   - [ ] Flag all 20 duplicate components for deprecation
   - [ ] Create migration guide: "How to update from cloud-ui Button to @elizaos/ui Button"
   - [ ] Remove duplicates from cloud-ui in next major version

2. **Move App-Specific Components**
   - [ ] `monetization/` → `cloud/apps/frontend/components/monetization/`
   - [ ] `promotion/` → `cloud/apps/frontend/components/promotion/`
   - [ ] Update imports in cloud/apps/frontend

3. **Fix Inline Styles**
   - [ ] Convert 86 `style={{}}` to Tailwind/CSS
   - [ ] Audit and consolidate animations

4. **Document ai-elements/**
   - [ ] Create README.md with usage examples
   - [ ] Export all types from ai-elements/index.ts
   - [ ] Document prompt-input.tsx API

### Phase 2: Refactoring (next sprint)

1. **Extract Custom Hooks**
   - [ ] `usePromptInput()` from prompt-input.tsx
   - [ ] `usePromoWizard()` from promote-app-dialog.tsx
   - [ ] Place in `src/hooks/` directory

2. **Improve Memoization**
   - [ ] Audit ai-elements/ for React.memo candidates
   - [ ] Add useMemo to expensive renders in monetization/

3. **Add Storybook Coverage**
   - [ ] 5+ stories for ai-elements/
   - [ ] 5+ stories for brand/
   - [ ] Target 30% coverage

4. **Clarify Export Strategy**
   - [ ] Decide: should `index.ts` re-export `primitives.ts`?
   - [ ] Document subpath exports (e.g., `@elizaos/cloud-ui/ai-elements`)

### Phase 3: Long-Term (product roadmap)

1. **Consider Deprecation Path**
   - [ ] Decide: merge cloud-ui into main UI, or keep separate?
   - [ ] If separate: create clear boundary (e.g., "cloud-ui is for Cloud platform only")

2. **Abstract Business Logic**
   - [ ] Move earnings simulator logic to a service (not UI)
   - [ ] Extract auth/OAuth to a composable provider

3. **Evaluate Bundle Impact**
   - [ ] Measure cloud-ui vs. main-ui bundle sizes
   - [ ] Consider lazy-loading ai-elements for non-chat apps

---

## Summary Table

| Category | Files | LOC | Status | Action |
|----------|-------|-----|--------|--------|
| **Primitives** | 57 | ~4,000 | ⚠️ 35% duplicate | Deprecate & migrate to main UI |
| **ai-elements** | 26 | ~2,500 | ✓ Reusable | Document & add Storybook |
| **brand** | 24 | ~1,800 | ⚠️ Cloud-specific | Clarify if shared across apps |
| **monetization** | 5 | ~365 | ✗ App-specific | Move to cloud/apps/frontend |
| **promotion** | 2 | ~1,060 | ✗ App-specific | Move to cloud/apps/frontend |
| **image-gen** | 5 | ~250 | ⚠️ Feature-specific | Move or rename to ai-elements/image |
| **auth** | 2 | ~450 | ⚠️ Partially app-specific | Extract auth interface |
| **voice** | 5 | ~200 | ⚠️ Partially reusable | Extract audio player |
| **layout** | 4 | ~300 | ⚠️ Cloud-specific | Move to cloud/apps/frontend |
| **theme** | 3 | ~200 | ⚠️ Needs abstraction | Extract theme interface |
| **docs, code, chat, etc.** | 21 | ~1,500 | ✓ Mixed | Audit each |
| **runtime** | 4 | ~400 | ✓ Reusable | Keep, but audit telemetry |
| **TOTAL** | **187** | **~19,075** | | |

---

## Related Documentation

- **See also:** Comparison of `packages/ui` (main) vs. `cloud/packages/ui`
- **Follow-up:** Create migration guides for each deprecated component
- **Dependencies:** Review `package.json` for tree-shakeability of `framer-motion`


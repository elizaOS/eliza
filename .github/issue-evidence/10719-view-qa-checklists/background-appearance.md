# Background & Appearance — QA Checklist

Scope: BackgroundView (`/background`), the shared `BackgroundSettingsControls` (swatches / custom color / upload / cloud-generate / undo), the unified `AppBackground` renderer (shader vs image), the `background:apply` chat bridge, versioned undo history, the Background settings subview, and the Appearance settings section (theme presets + language). Component source under `packages/ui/src/components/pages/BackgroundView.tsx`, `packages/ui/src/components/settings/BackgroundSettings*`, `AppearanceSettingsSection.tsx`, `packages/ui/src/backgrounds/*`, `packages/ui/src/state/{useDisplayPreferences,persistence,ui-preferences}.ts`, action at `plugins/plugin-app-control/src/actions/background.ts`.

Legend: `[covered: <path>]` = a committed test exercises it; `[GAP]` = no committed test found.

---

## BackgroundView (`/background`)

### Entry / Nav
- [ ] Reaching via TAB_PATHS route `background` → `/background` renders `BackgroundSettingsControls` centered, no visible heading (sr-only "Background"). [GAP — no route/nav test; only `BackgroundView.test.tsx` renders the component directly]
- [ ] Fresh reload on `/background` boots straight into the view with the persisted background already painted behind it (no flash-to-default). [GAP]
- [ ] Deep-link/tab-tap from launcher → `/background` and back-button returns to prior tab with background unchanged. [GAP]
- [ ] Chat "show me the background settings" / view-switch intent lands on `/background` (ShellViewAgentSurface viewId="background"). [GAP]
- [ ] The live wallpaper shows THROUGH the transparent view while controls float on top (view root is transparent). [GAP — asserted for Settings, not `/background`]

### Primary interactions
- [ ] Click each of the 10 preset swatches (orange/amber/rose/red/green/olive/stone/graphite/black/light) → `setBackgroundConfig({mode:"shader", color:<hex>})` with the exact preset hex, and the wallpaper recolors live. [covered (green only): `BackgroundView.test.tsx` "selecting a swatch sets a shader config"; e2e `run-background-e2e.mjs` swatch-green — GAP for the other 9 presets]
- [ ] Selected swatch shows the `Check` mark and `aria-pressed=true`; only the active shader color is marked (image mode marks none). [GAP]
- [ ] Custom-color Pipette button opens the hidden `<input type=color>`; changing it calls `selectColor` → shader config with the picked hex; swatch selection clears. [GAP — pipette/color input untested]
- [ ] Upload button opens the file picker; choosing an image → `setBackgroundConfig({mode:"image", color:<activeColor>, imageUrl:<dataUrl>})`. [covered: `BackgroundView.test.tsx` "uploading an image sets an image config" (mock dataUrl); `BackgroundSettingsSection.test.tsx`]
- [ ] Upload input value is reset after selection (`event.target.value=""`) so re-selecting the SAME file fires `onChange` again. [GAP]
- [ ] Generate button visible ONLY when cloud connected AND not auth-rejected; toggles the prompt form open/closed and shows `aria-pressed`. [covered (visibility): `BackgroundView.test.tsx` "hides/shows Generate"; toggle open/close/aria-pressed GAP]
- [ ] Prompt form: type text → submit (Enter or Arrow-up button) calls `client.generateBackgroundImage(trimmed)` then applies `{mode:"image", imageUrl:url}`, closes form, clears prompt. [covered: `BackgroundView.test.tsx` "generates an image from a prompt and applies it"]
- [ ] Submit button disabled while `generating` OR when `prompt.trim().length===0`; spinner (`Loader2`) shows during generation. [GAP — disabled/spinner state untested]
- [ ] Undo button visible ONLY when `canUndoBackground` (history non-empty); click → `undoBackgroundConfig()` restores the previous config. [covered: `BackgroundView.test.tsx` "hides Undo…"/"shows Undo and reverts…"]
- [ ] There is NO reset control in the UI — reset is agent-only (`background:apply {op:"reset"}`); confirm no dead reset button. [GAP — invariant unasserted]

### State matrix
- [ ] Empty/default state: no history → Undo hidden; cloud off → Generate hidden; only swatches + custom + upload shown. [covered (undo/generate hidden): `BackgroundView.test.tsx`]
- [ ] Populated: after a swatch/upload/generate, Undo appears. [covered indirectly]
- [ ] Cloud connected but `elizaCloudAuthRejected=true` → Generate hidden (cloudAvailable=false). [GAP — auth-rejected branch untested]
- [ ] Generation failure surfaces `role="alert"` with the error message; error clears on the next successful action (`setError(null)`). [covered (error shown): `BackgroundView.test.tsx` "surfaces a generation error"; error-clear-on-retry GAP]
- [ ] Upload of a non-image / oversized file surfaces the `BackgroundImageError` message in the alert. [GAP — error path from the VIEW untested; util tested separately]
- [ ] Guest/unauth: swatches + upload still work (local-only, no cloud); Generate absent. [GAP]

### Repeated / rapid-fire
- [ ] Mash the same swatch 5× → identical config each time is a no-op after the first (`backgroundConfigsEqual` guard); no history churn. [covered (store level): `useDisplayPreferences.background.test.tsx` "setting the same config is a no-op"; from-UI GAP]
- [ ] Double/triple-submit the generate form → only ONE `generateBackgroundImage` call in flight (`if (generating) return` guard); no duplicate network calls, no duplicate applied images. [GAP — idempotency of generate untested]
- [ ] Spam Generate toggle open/close rapidly → prompt draft and focus behave; no latched spinner. [GAP]
- [ ] Rapid swatch A→B→A→B → history records each distinct change; canUndo stays true; no dropped state. [GAP]

### Back-and-forth / switching & recovery
- [ ] Open prompt, type a draft, navigate away and back → whether draft persists or resets is defined and consistent (component unmounts → draft lost by design). [GAP]
- [ ] Start a generate, switch view mid-flight, return → in-flight promise resolves against an unmounted component without applying/erroring on a dead tree (no state-update-after-unmount warning). [GAP — race untested]
- [ ] Apply a background on `/background`, switch to another view, return → the SAME wallpaper still painted (shared store, `AppBackground` never remounts). [covered (shared-store principle): `AppBackground.test.tsx`; cross-view GAP]
- [ ] Background the app / resume → persisted config reloaded from localStorage unchanged. [GAP]

### Fuzz / adversarial input
- [ ] Generate prompt: paste huge text / emoji / RTL / IME composition / whitespace-only → whitespace-only keeps submit disabled (`trim()`), other inputs pass through trimmed to the API. [GAP]
- [ ] Custom color picker fed a non-hex value → normalized to default (`normalizeHexColor` collapses invalid → `#ef5a1f`). [covered (normalize): `persistence.background.test.ts` "invalid color collapses"; from-picker GAP]
- [ ] Upload a `.svg`/`.gif`/0-byte/corrupt-image file → `fileToBackgroundDataUrl` rejects non-`image/*` and >4MB with a friendly `BackgroundImageError`. [covered (util): `background-image.test.ts`; from-VIEW GAP]
- [ ] Invariant: after ANY sequence of actions the config is always a valid `{mode:"shader"|"image", color:/^#[0-9a-f]{6}$/, imageUrl?}` — never wedged. [covered (normalize invariants): `persistence.background.test.ts`]

### Input modalities
- [ ] Keyboard: Tab reaches swatches → custom → upload → (generate) → (undo) in DOM order; Enter/Space activates each button; Escape closes the open prompt form. [GAP — no keyboard/focus-order test]
- [ ] Touch (mobile viewport): tap each swatch, tap upload, tap generate; hidden file/color inputs still trigger via label click. [GAP]
- [ ] Generate form Enter submits (form `onSubmit`), not just the button click. [covered indirectly via fireEvent click; Enter-key GAP]

### A11y / geometry
- [ ] Every control has an `aria-label` (swatches "Set background to X", upload, generate, undo, custom color); selected swatch `aria-pressed`. [covered (labels queried): `BackgroundView.test.tsx` uses getByLabelText — implies present]
- [ ] Tap targets: swatches are 36px (`h-9 w-9`) — FLAG as below the 44px min; action buttons are 48px (`h-12 w-12`) OK. [GAP — geometry unasserted; 36px swatch is a known finding]
- [ ] axe pass after opening the prompt form and after an error alert renders. [GAP — no axe run on this view]
- [ ] Hover: action buttons neutral `bg-bg-accent/70` → `bg-bg-accent` (neutral→neutral, never orange→black); active Generate uses `bg-accent`. No blue anywhere. [GAP — hover/color-contract untested for this view]
- [ ] Reduced-motion: shader rim animation stilled (`prefers-reduced-motion: reduce` → `animation:none`). [GAP — reduced-motion path untested]
- [ ] Focus visible on each control; alert has `role="alert"` and is announced. [covered (alert role): `BackgroundView.test.tsx`; focus-visible GAP]

### Concurrency / races
- [ ] Generate in flight + click a swatch → swatch applies immediately; the later-resolving generate does NOT clobber the newer manual choice unexpectedly (last-write-wins is defined). [GAP]
- [ ] Two uploads back-to-back → the second data-url wins; no interleaved half-applied config. [GAP]
- [ ] `background:apply` chat event arrives WHILE the user is mid-swatch-click → both funnel through `setBackgroundConfig`; final state is deterministic. [GAP]

---

## BackgroundSettingsSection (`/settings` → Background subview)

### Entry / Nav
- [ ] Reach via Settings; note `background` is NOT in `settings-section-meta.ts` groups list — confirm how the Background subview is routed/exposed (dedicated subview vs `/background` tab). [GAP — routing origin unverified]
- [ ] Renders the SAME `BackgroundSettingsControls` as `/background` (single source of truth), centered. [covered: `BackgroundSettingsSection.test.tsx` renders controls + swatch click]
- [ ] Settings panel stays transparent so the wallpaper shows through as choices apply instantly. [covered (settings-over-wallpaper seam): `app/test/ui-smoke/settings-background.spec.ts`]

### Primary interactions / state
- [ ] Swatch click here applies the shader config identically to `/background`. [covered: `BackgroundSettingsSection.test.tsx`]
- [ ] Background controls are ABSENT from the Appearance section (dedicated subview only). [covered: `AppearanceSettingsSection.background.test.tsx`]
- [ ] Settings captured over BOTH shader and a busy photo wallpaper, desktop + mobile; readability scrim (`app-background-scrim`) present on Settings, absent on sparse launcher. [covered: `settings-background.spec.ts`]
- [ ] No opaque `bg-bg` ancestor paints over the wallpaper (safe-area seam gone, #9143). [covered: `settings-background.spec.ts` seam inspector]

### Recovery / rapid-fire
- [ ] Switch Settings subsection away and back → background controls re-render against the current persisted config. [GAP]
- [ ] Rapid swatch changes inside Settings behave identically (shared store) — no divergence from `/background`. [GAP]

---

## AppBackground / ShaderBackground / ImageBackground (renderer)

### Rendering states
- [ ] `mode:"shader"` → renders `[data-testid=app-background-shader]` with `backgroundColor` = the config hex; no image node. [covered: `AppBackground.test.tsx`]
- [ ] `mode:"image"` + `imageUrl` → renders `[data-testid=app-background-image]` with `background-image:url(...)`; no shader node. [covered: `AppBackground.test.tsx`]
- [ ] Missing/non-object config slice (pre-seed / test proxy) → falls back to default shader `#ef5a1f`, never crashes. [covered: `AppBackground.test.tsx` "falls back to the shader"]
- [ ] `visible={false}` → no visual layer painted BUT the `background:apply` channel stays mounted (agent can still drive it). [covered: `AppBackground.test.tsx` "keeps the apply channel mounted"]
- [ ] Shader rim glow uses `${color}4d` (30% alpha) — valid CSS for any 6-digit hex; never produces an invalid color string. [GAP — rim-color composition untested]
- [ ] Image node is `fixed inset-0`, `cover`, `no-repeat`, `aria-hidden`, `pointer-events-none`, `zIndex:0`. [covered (attributes present in source); geometry-over-viewport asserted in `settings-background.spec.ts`]
- [ ] AppBackground mounted ONCE at shell root → never remounts on navigation (continuous wallpaper across every view). [GAP — remount-on-nav not asserted in a test]

### `background:apply` chat bridge (`useBackgroundApplyChannel`)
- [ ] `{op:"set", color}` → shader config with that color. [covered (e2e): `run-background-e2e.mjs` "chat-apply-teal"; unit GAP]
- [ ] `{op:"set", mode:"image", imageUrl}` → image config, color falls back to current-or-default. [GAP — image-via-chat unit untested]
- [ ] `{op:"set"}` with a bad/partial payload (no color, no url) → normalized, background never wedges (malformed → no-op or default). [GAP — adversarial payload untested]
- [ ] `{op:"undo"}` → reverts to the previous config. [covered (e2e): `run-background-e2e.mjs` "chat-undo-to-image"]
- [ ] `{op:"reset"}` → sets `DEFAULT_BACKGROUND_CONFIG` (orange shader). [GAP — reset op untested at the channel level (only the action's `inferBackgroundPlan` detects reset)]
- [ ] `op` missing → defaults to `"set"`. [GAP]
- [ ] The channel is the ONLY subscriber to `background:apply` (no second background mechanism). [GAP — single-subscriber invariant unasserted]

### Action mapping (`plugins/plugin-app-control/src/actions/background.ts`)
- [ ] Named color ("teal") → `#0891b2` shader plan; hex string passes through; "orange" → brand `#ef5a1f`. [covered: `background.test.ts` inferBackgroundPlan]
- [ ] "undo the background" → `{op:"undo"}`; "reset to default" → `{op:"reset"}`. [covered: `background.test.ts`]
- [ ] Image attachment → image plan using the media url. [covered: `background.test.ts` "uses an image attachment"]
- [ ] Agent color labels stay in sync with `BACKGROUND_PRESETS` (swatch and chat resolve the SAME hex). [GAP — cross-source consistency untested]

---

## Undo history store (`useDisplayPreferences` + persistence)

### Behavior
- [ ] Fresh state: default orange shader, `canUndoBackground=false`. [covered: `useDisplayPreferences.background.test.tsx`]
- [ ] `set` pushes the OUTGOING config onto history (unless equal); `canUndo` flips true. [covered]
- [ ] `undo` restores the most-recent previous config and pops it; repeated undo walks back to default then `canUndo=false`. [covered]
- [ ] Setting an identical config is a no-op (no history churn). [covered]
- [ ] There is NO redo — an undone config is discarded. [GAP — absence-of-redo not explicitly asserted]
- [ ] History capped at `MAX_BACKGROUND_HISTORY` (10) — oldest dropped. [covered: `useDisplayPreferences.background.test.tsx` "caps the undo history"]

### Persistence / fuzz
- [ ] Config + history persist to `eliza:ui-background` / `eliza:ui-background-history` and reload. [covered: `useDisplayPreferences.background.test.tsx`, `persistence.background.test.ts`]
- [ ] Corrupt / non-JSON stored value → default returned, no throw. [covered: `persistence.background.test.ts` "corrupt"]
- [ ] `normalizeBackgroundConfig`: lowercases hex, collapses image-without-url → shader, invalid color → default, null/string → default. [covered: `persistence.background.test.ts`]
- [ ] `normalizeBackgroundHistory`: non-array → `[]`, entries normalized, sliced to cap. [GAP — history normalize edge cases untested]
- [ ] localStorage quota-exceeded on save (huge image data-url history) → `tryLocalStorage` swallows without crashing the app. [GAP — quota path untested]
- [ ] Image data-url ≤4MB after downscale (`background-image.ts` cap); a still-too-large image is rejected pre-store. [covered: `background-image.test.ts`]

---

## AppearanceSettingsSection (theme presets + language) (`/settings` → appearance)

### Entry / Nav
- [ ] Reach via Settings `appearance` section (settings-section-meta `system` group). [GAP — no nav test]

### Primary interactions
- [ ] Theme tiles Light / Dark / System → `setUiThemeMode(mode)`; active tile `aria-current=true` + accent styling. [GAP — theme tile click/state untested at unit level]
- [ ] Selecting `System` follows `prefers-color-scheme` live (matchMedia change re-resolves theme). [GAP — system-follow untested]
- [ ] Theme change flips CSS vars app-wide (every element responds; no hardcoded color stuck light/dark). [covered (per-element diff): `app/test/ui-smoke/settings-theme-audit.spec.ts`]
- [ ] Language tiles → `setUiLanguage(id)`; active tile `aria-current`. [GAP]
- [ ] Advanced toggle reveals `LoadContentPackForm`; loaded packs list toggles active pack. [GAP — content-pack toggle untested here]

### State / rapid-fire / a11y
- [ ] Rapid Light→Dark→System→Light → final mode persists (`saveUiThemeMode`), no flicker-latch. [GAP]
- [ ] Theme + language selections persist across reload. [GAP — unit persistence untested; theme persist covered indirectly by audit]
- [ ] Theme tiles keyboard-navigable (role="tab"), 40px min height (`min-h-10`) — FLAG below 44px. [GAP]
- [ ] Hover on inactive tile → neutral `hover:bg-surface` (never orange→black); active uses accent tint. [covered (color response): `settings-theme-audit.spec.ts`; hover-specific GAP]
- [ ] Both themes captured desktop + mobile per settings section. [covered: `settings-theme-audit.spec.ts`]

---

## Coverage summary

| View / surface | Existing test path(s) | Biggest gap |
|---|---|---|
| BackgroundView (`/background`) | `packages/ui/src/components/pages/BackgroundView.test.tsx`; e2e `packages/ui/src/components/pages/__e2e__/run-background-e2e.mjs` | No route/nav-entry test; generate double-submit idempotency, keyboard/focus order, axe, and the other 9 preset swatches untested |
| BackgroundSettingsSection (Settings subview) | `BackgroundSettingsSection.test.tsx`, `AppearanceSettingsSection.background.test.tsx`, `app/test/ui-smoke/settings-background.spec.ts` | Subview routing origin unverified (not in settings-section-meta); no in-Settings rapid-fire/recovery test |
| AppBackground / Shader / Image renderer | `packages/ui/src/backgrounds/AppBackground.test.tsx` | Remount-on-nav continuity and rim-color composition unasserted |
| `background:apply` chat bridge | e2e `run-background-e2e.mjs`; action `plugins/plugin-app-control/src/actions/background.test.ts` | No UNIT test of `useBackgroundApplyChannel` (image-via-chat, reset op, malformed/partial payload normalization) |
| Undo history store | `useDisplayPreferences.background.test.tsx`, `persistence.background.test.ts` | localStorage quota-exceeded on image-history save, and `normalizeBackgroundHistory` edge cases untested |
| AppearanceSettingsSection (theme/language) | `app/test/ui-smoke/settings-theme-audit.spec.ts` | No UNIT test of theme-tile / language-tile click→setUiThemeMode/setUiLanguage or the System matchMedia-follow branch |

**Biggest single gap in this group:** `useBackgroundApplyChannel` — the sole chat→background bridge and the one place that normalizes untrusted agent payloads (`op:"set"|"undo"|"reset"`, malformed color/url) — has ZERO unit coverage; it is only touched indirectly by the screenshot e2e (`run-background-e2e.mjs`), so the `reset` op, image-via-chat, and adversarial/partial-payload normalization paths are entirely unverified.

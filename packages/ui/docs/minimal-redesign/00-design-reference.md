# Design Reference — elizaOS App UI (foundation for the minimalist redesign)

Scope: `@elizaos/ui` (`packages/ui`) + `@elizaos/app` (`packages/app`). All paths absolute under
`/home/shaw/eliza`. This documents the token/theme system, the surfaces that already feel
"right," the minimal primitive vocabulary, and — critically — exactly how the light/dark mode is
chosen at runtime and what it takes to force ONE light look app-wide.

---

## TL;DR — the load-bearing facts

1. **There are TWO theme layers, and they are wired together at boot:**
   - **Brand preset** (`ELIZA_DEFAULT_THEME` in `packages/ui/src/themes/presets.ts`) — defines a
     full `light` token set (bg `#eef8ff`, glassy white cards, orange `#ff8a24` accent, blue
     `#1d91e8` info) AND a `dark` set (bg `#050506`). It is injected as `BrandingConfig.theme` in
     `packages/app/src/main.tsx:322` and applied by `applyThemeToDocument(brandTheme, uiTheme)` in
     `packages/ui/src/state/AppContext.tsx:148-153`.
   - **Mode** (`light` | `dark`) — chosen by the user/system, resolved by `useDisplayPreferences`,
     and applied as a `data-theme`/`.dark` class + `color-scheme` by `applyUiTheme`
     (`packages/ui/src/state/persistence.ts:278-324`). `base.css` also has hard-coded `:root`
     (light) and `[data-theme="dark"]`/`.dark` (dark) fallback token blocks.
   - The brand preset's `light`/`dark` is selected by the *resolved mode*. So mode == `dark` →
     dark brand tokens AND the `.dark` CSS block both apply.

2. **The mode default is `system`, and `system` resolves to `dark` when `matchMedia` is
   unavailable** (`getSystemTheme()`, `packages/ui/src/state/persistence.ts:57-62`, returns `"dark"`
   on no-matchMedia). On a device that prefers dark, you get the heavy black look. This is the
   single switch that produces the "heavy black background" the redesign wants to move away from.

3. **To force ONE light look app-wide:** make the resolved `UiTheme` always `"light"`. The smallest,
   correct change is at the resolution layer (default mode → `light`, and/or `resolveUiTheme` pinned
   to `light`), plus removing/neutralizing the light/dark toggle in
   `packages/ui/src/components/settings/AppearanceSettingsSection.tsx`. Details in section (C).

4. **Reference surfaces that already feel light/minimal do NOT use the theme tokens** — the chat
   overlay, HomeScreen, onboarding, and glass-composer are *self-contained* dark-glass-on-color
   surfaces with fixed white text and hardcoded translucent values. They float over a colored
   substrate (orange ambient field, brand orange). This is the visual language to generalize.

---

## (A) Reference surfaces — what makes them feel right

These are the surfaces the redesign should treat as the aesthetic north star. The common thread:
**flat color field + floating liquid-glass + icon-first + whitespace + fixed light text** — they do
NOT read theme tokens, they carry their own contrast.

### A1. `ContinuousChatOverlay.tsx` — the PRIMARY interface
`packages/ui/src/components/shell/ContinuousChatOverlay.tsx`

The always-present floating chat that sits over every view. Two stated design rules
(`:69-77`): **self-contained contrast** (every surface carries its own dark-glass scrim + fixed
light text, never the theme's `--txt`) and **no chrome/signage** (no counters, no tabs, controls
dissolve into the glass).

- **Glass control language** (`SoftButton`, `:230-239`): round, border-blended, dissolves until
  active:
  ```
  "grid h-11 w-11 shrink-0 place-items-center rounded-full border transition-colors"
  active ? "border-white/40 bg-white/85 text-black"
         : "border-white/15 bg-white/10 text-white/75 hover:bg-white/20 hover:text-white"
  ```
  Neutral-resting → neutral-hover (NO accent color on idle controls). `active` = white fill, black
  glyph. `HeaderButton` (`:269-275`) is the same language at `h-9 w-9`.
- **Glyphs are inline SVG paths**, not icons, drawn in `currentColor` (`SEND_GLYPH`, `MIC_GLYPH`,
  `PLUS_GLYPH`, `STOP_GLYPH`, `SPEAKER_GLYPH`, `:175-192`). Lucide is used only for header controls
  (`Home, Maximize2, Minimize2, RotateCcw, Settings`, `:1-7`).
- **Floating text gets a soft shadow** instead of a scrim: `FLOAT_SHADOW =
  "[text-shadow:0_1px_4px_rgba(0,0,0,0.7)]"` (`:84`).
- **Chat bubbles** (`ThreadLine`, `:578-603`): `rounded-2xl` with one squared corner
  (`rounded-bl-md`/`rounded-br-md`), `px-3.5 py-2 text-[14px] leading-relaxed`. Floating variant:
  `border-white/15 bg-black/55 text-white` (user) / `border-white/10 bg-black/45 text-white/90`
  (assistant).
- **Motion is opacity/translate only** (`OVERLAY_EASE = [0.22,1,0.36,1]`, `:89`), iOS-style springs
  (`SHEET_SPRING`, `OPEN_SPRING`, `:149-163`); never animates blur/filter. Live drag stays on a
  `useMotionValue` so it never re-renders per frame.
- **Radius tracks height** so the pill→input is one continuous "liquid glass" morph:
  `panelRadius = useTransform(threadHeight, [0,12], [9999,24])` (`:1082`).
- **Detents**: `input → half → full` ordinal (`:691`) is the single source of truth; `sheetOpen`/
  `expanded` are derived. Five named states (`ChatState`, `:101-106`).

Takeaway: round white-on-glass icon controls, no idle accent, inline geometric glyphs, soft
shadows over scrims for floating text, springy opacity-only motion.

### A2. `HomeScreen.tsx` — the /chat home behind the chat
`packages/ui/src/components/shell/HomeScreen.tsx`

iOS-style dashboard: a big clock, optional activity/messages cards, and a 4-col tile grid. **Renders
content only when there's something to show** — clock + tiles otherwise (`:341-345`, `:364-386`).

- **Liquid-glass card** (`HomeCard`, `:183-187`):
  ```
  "relative rounded-3xl border border-white/[0.14] bg-black/30 p-4 backdrop-blur-2xl backdrop-saturate-150"
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_18px_50px_-26px_rgba(0,0,0,0.7)]"
  ```
- **Tile** (`:404-412`): `rounded-2xl border-white/[0.14] bg-black/25 ... backdrop-blur-2xl`, hover
  `hover:bg-white/[0.14]`, press `active:scale-[0.96]`. **No chip behind the icon** — lucide icon
  sits directly on the glass (`:414-418`), `h-[22px] w-[22px] text-white/90`, label `text-[11px]
  font-medium text-white/80`.
- **Clock**: `text-5xl font-semibold tracking-tight text-white tabular-nums` (`:215`). Section
  headers are tiny uppercase: `text-[13px] font-semibold uppercase tracking-wide text-white/70`
  (`:191`).
- White-with-opacity is the entire palette (`text-white/90`, `/80`, `/70`, `/55`, `/45`); no theme
  tokens, no borders beyond the faint `white/[0.14]` glass edge.

Takeaway: rounded-2xl/3xl glass panes, faint top specular edge, icon-on-glass tiles, opacity-graded
white text, render-only-when-populated.

### A3. `ChatAmbientBackground.tsx` — the light/color substrate
`packages/ui/src/components/shell/ChatAmbientBackground.tsx`

The wordless backdrop behind the chat home. **A flat warm-orange field** (`backgroundColor:
"#ef5a1f"`, `:54`) whose *edge* slowly breathes through the brand palette (white → orange → blue →
black) via stacked inset `box-shadow` layers crossfaded by `opacity` only (`:14-35`). No gradient,
no vignette, no text. Fully stilled under `prefers-reduced-motion`. `fixed inset-0`, `zIndex: 0`.

Takeaway: a flat brand-color field (not black, not a photo) is the canonical "view background." The
only motion is a compositor-cheap edge opacity pulse.

### A4. `glass-composer.tsx` — the negative-space icon button
`packages/ui/src/components/shell/glass-composer.tsx`

Shared composer chrome. The signature move: **negative-space icon buttons** — the glyph is cut OUT
of a white rounded square (fillRule="evenodd"), so the glass/background shows through it (`:14-27`,
`:95-99`). `h-9 w-9`, `hover:scale-105`, `drop-shadow-[0_1px_4px_rgba(0,0,0,0.3)]`. Same `SEND`/`MIC`
glyph geometry as the overlay so mic+send read as one set.

### A5. `FirstRunRuntimeChooser.tsx` — first-run runtime choice over chat
`packages/ui/src/first-run/FirstRunRuntimeChooser.tsx`

First-run now renders over the live chat shell, not as a separate onboarding screen. The chooser
uses white text on a dark glass surface, two primary runtime actions, and a collapsed advanced
path for bring-your-own-keys setup.

- **Primary action = solid white card with orange text** (`:278`): `rounded-2xl bg-white px-5 py-4
  ... shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)]`, icon chip `bg-[#FF5800]/10` with
  `text-[#FF5800]` lucide `Cloud`. (Note hardcoded `#FF5800`, the `base.css` brand orange, NOT the
  preset `#ff8a24` — see the orange discrepancy in section B.)
- **Secondary** = glass: `rounded-2xl border border-white/20 bg-white/[0.08] ... backdrop-blur-sm`,
  hover `hover:bg-white/[0.14]` (`:301`).
- **Tertiary "Advanced"** = a quiet text link (`text-white/55 hover:text-white/85`, `:332`).
- Min touch target respected (`min-h-11`, `:233`). Lucide icons throughout
  (`ArrowRight, Cloud, ShieldCheck, Mic, ...`, `:1-12`).

Takeaway: white-text-on-color, one solid-white primary, glass secondary, demoted tertiary link,
generous `gap-8`/`gap-5`/`gap-3` whitespace.

**Shared design DNA across A1–A5:** flat brand-color field → floating rounded glass (white/opacity
borders, `backdrop-blur-2xl`, faint inset top edge) → fixed white text graded by opacity → lucide or
inline-SVG icons → no badges/tags/dividers → opacity/translate motion → render only when populated.

> **Widgets are the CHROMELESS EXCEPTION to the glass-tile language (#10708).** The
> rounded-2xl/3xl border + `bg-black/*` glass surface above is for material surfaces
> (`HomeCard`, launcher tiles, modals, popovers), NOT for home/dashboard widgets. Home
> widgets render DIRECTLY on the wallpaper: no tile fill, no border, no corner radius.
> Their whole affordance is the icon + graded-white text + whitespace/rank separation;
> hover/press is opacity + transform, never a background fill. The `no-widget-chrome-gate`
> test enforces this by scanning the widget component files: any single container
> className that reintroduces the full glass-card triad — a corner radius (`rounded-sm`…`3xl`)
> AND an explicit colored border AND a translucent background fill together — fails the
> build. Legitimate inner content is unaffected (icon tiles `rounded-lg bg-white/10`,
> `rounded-full` status dots/pills, inner rows), since none combine all three. When a new
> home widget needs a container, keep it chromeless; borders, fills, and radii stay for the
> glass surfaces, not widgets.

---

## (B) Token / theme system — full token list + how to reference

### B1. Two parallel definitions of the same tokens — know which is live

| Layer | File | Form | When it wins |
|---|---|---|---|
| **Raw CSS fallback** | `packages/ui/src/styles/base.css` | `:root` (light) + `[data-theme="dark"],.dark` (dark) CSS-var blocks | Always present; overridden by the brand preset's inline `style` props |
| **Brand preset** | `packages/ui/src/themes/presets.ts` (`ELIZA_DEFAULT_THEME`) | JS object `{ light:{…}, dark:{…} }` | Applied as inline `root.style.setProperty(...)` by `applyThemeToDocument` → wins over base.css |
| **Mode class** | `applyUiTheme` (`persistence.ts`) | sets `data-theme`/`.dark`/`color-scheme` | Selects which base.css block + which preset half is read |

`applyThemeToDocument` (`packages/ui/src/themes/apply-theme.ts:22-69`) iterates
`THEME_CSS_VAR_MAP` and writes each preset color to its CSS var on `document.documentElement`. It
also keeps `--txt` in sync with `--text` (`:42-45`) and mirrors `--primary`/`--primary-foreground`
from accent (`:47-56`).

**Important divergence:** `base.css` brand vars and the preset disagree on values:
- `base.css` `--brand-orange: #ff5800`, `--brand-blue: #0b35f1` (`base.css:4-6`).
- Preset accent `#ff8a24`, info `#1d91e8`, light bg `#eef8ff` (`presets.ts:13,32,50`).
Because the preset is injected (`main.tsx:322`) and applied last, **the preset values are the live
ones in the app** for tokens it sets. But hardcoded surfaces (onboarding) use `#FF5800`. The
redesign should pick one orange (`#ff8a24` per the prompt) and reconcile.

### B2. The semantic token set (the canonical map)

Source of truth for names: `packages/shared/src/contracts/theme.ts` (`THEME_CSS_VAR_MAP`,
`:162-233`). Every `ThemeColorSet` key → CSS var. Reference these via the CSS var or its Tailwind
alias.

**Backgrounds**: `--bg` (`bg-bg`), `--bg-accent` (`bg-bg-accent`), `--bg-elevated`, `--bg-hover`,
`--bg-muted`. shadcn alias `--background` = `--bg` (`base.css:35`).

**Surfaces**: `--card` (`bg-card`), `--card-foreground` (`text-card-fg`), `--surface` (`bg-surface`).

**Text**: `--text` (`text-txt`), `--text-strong` (`text-txt-strong`), `--chat-text`, `--muted`
(`text-muted`), `--muted-strong` (`text-muted-strong`). Aliases `--foreground`=`--text`,
`--muted-foreground`=`--muted` (`base.css:34-36`), `--txt`=`--text` (kept in sync by apply-theme).

**Borders/inputs**: `--border` (`border-border`), `--border-strong`, `--border-hover` (= orange),
`--input`, `--ring` (`ring-ring`).

**Accent (orange)**: `--accent` (`bg-accent`/`text-accent`), `--accent-rgb`, `--accent-hover`,
`--accent-muted`, `--accent-subtle` (`bg-accent-subtle`), `--accent-foreground` (`text-accent-fg`),
`--primary`, `--primary-foreground`.

**Status**: `--ok`/`--ok-muted`/`--ok-subtle`; `--destructive`/`--destructive-foreground`/
`--destructive-subtle`/`--danger`; `--warn`/`--warn-muted`/`--warn-subtle`; `--info`;
`--status-info`/`--status-info-bg`. Plus semantic aliases in base.css
(`--status-success`, `--status-danger`, `--status-warning`, `--status-info`, `:68-78`).

> NOTE / accent-discipline landmine: in **base.css**, `--status-info` is deliberately set to a
> NEUTRAL (`--muted-strong`), NOT blue — with a comment that a blue here is "a live accent
> violation" (`base.css:75-78`, dark `:215-217`). But the **preset** sets `statusInfo` to blue
> `#1d91e8` (`presets.ts:51`) and the preset wins. So info currently renders blue. The CLAUDE.md
> brand rule is "orange is the only accent, no blue." The redesign must decide: keep blue as a
> secondary/info color (prompt allows blue as secondary/info) OR honor the base.css neutral stance.

**Focus**: `--focus`, `--focus-ring` (base.css sets these to `none`/neutral, `:80-81`).

**Scrollbar**: `--scrollbar-track`, `--scrollbar-thumb-{start,mid,end}`, `-hover-{…}`,
`--scrollbar-thumb-edge`.

**Header/section bars**: `--header-bar-bg/-fg`, `--section-bar-bg/-fg`. **Links**: `--link-color`,
`--link-hover-color`.

**Shadows**: `--shadow-{xs,sm,md,lg,xl,2xl,inset}`. NOTE: **base.css forces ALL shadows to `none`**
(`base.css:108-114`, dark `:242-248`), overriding the preset's shadow values. The app is flat.

**Radii**: `--radius{,-sm,-md,-lg,-xl,-2xl,-3xl}`, `--radius-full: 9999px`. NOTE: **base.css forces
every named radius to `--radius-xs: 3px`** (`base.css:115-124`) — "slight xs rounding, never
hard-edged, never pill-shaped." The preset's larger radii (`0.5rem`–`1.5rem`) are overridden. So
shadcn primitives that say `rounded-sm`/`rounded-lg` all render at 3px. (The glass surfaces opt out
with literal `rounded-2xl`/`rounded-3xl`/`rounded-full` Tailwind classes, not the radius tokens.)

### B3. Typography + spacing tokens

- **Font** (`base.css:99-105`): `--font-sans` = **Poppins** → `--font-body`/`--font-display`/
  `--font-chat`/`--mono` all alias to it (one typeface everywhere).
- **Compact text sizes** (`base.css:127-130`): `--text-3xs: 0.5625rem` (9px), `--text-2xs: 0.625rem`
  (10px), `--text-xs-tight: 0.6875rem` (11px). Native phones bump these up (`base.css:319-321`).
- **Touch target**: `--min-touch-target: 2.75rem` (44px, `base.css:132-133`) → `min-h-touch`.
- **Plugin UI tokens** (`base.css:136-149`): `--plugin-field-gap: 1rem`, `--plugin-group-gap:
  1.5rem`, `--plugin-section-padding: 1.5rem`, `--plugin-label-size: 0.8125rem`, etc. — the spacing
  rhythm for generated/plugin config forms.
- **Timing**: `--duration-normal` (150ms light / 200ms preset-dark).
- No global type SCALE token set beyond the 3 compact sizes; everything else uses Tailwind
  `text-sm`/`text-[13px]`/`text-5xl` literals.

### B4. Brand colors (raw, in base.css `:4-12`)
`--brand-blue: #0b35f1`, `--brand-orange: #ff5800`, `--brand-black: #000000`,
`--brand-white: #ffffff`, `--brand-gray: #d1d0d4`. Aliases `--sky-*`, `--eliza-orange`.
(Marketing theme variants `.theme-cloud/.theme-os/.theme-app/.theme-clouds` + `.brand-section--*`
live at `base.css:357-515` — full-bleed solid-color sections; not used by the agent shell.)

### B5. How a component should reference tokens (the rule)
- Use the **Tailwind token classes** that map to the CSS vars: `bg-bg`, `bg-card`, `bg-accent`,
  `bg-accent-subtle`, `text-txt`, `text-muted`, `text-muted-strong`, `text-accent`, `text-accent-fg`,
  `border-border`, `ring-ring`, `bg-destructive`, `text-danger`, etc. (See every primitive in
  section D.) This is what makes a component theme-aware.
- Use raw `var(--…)` only when no class exists (e.g. `font-[var(--mono)]`,
  `bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]` in `input.tsx`).
- The floating chat/home surfaces deliberately do NOT use tokens — they hardcode `white/NN`,
  `black/NN`, `bg-black/30`, `backdrop-blur-2xl` for self-contained contrast over any substrate.

---

## (C) Theme-mode mechanism + how to force a single LIGHT look

### C1. The exact runtime chain (where dark gets chosen)

```
loadUiThemeMode()                      persistence.ts:74-83   → default "system" for new users
   ↓ (read by)
useDisplayPreferences()                useDisplayPreferences.ts:32-101
   • uiThemeMode state, default loadUiThemeMode()  (:33-34)
   • uiTheme = resolveUiTheme(loadUiThemeMode())   (:35-37)
   • effect: if mode==="system" → setUiTheme(getSystemTheme()) and live-track
     matchMedia("(prefers-color-scheme: light)")   (:80-91)
   • effect: applyUiTheme(uiTheme) on change        (:98-101)
   ↓
resolveUiTheme(mode)                    persistence.ts:65-67   → mode==="system" ? getSystemTheme() : mode
getSystemTheme()                        persistence.ts:57-62   → matchMedia light? "light" : "dark";
                                                                  NO matchMedia → "dark"  ← heavy-black default
applyUiTheme(theme)                     persistence.ts:278-324 → sets data-theme + .dark + color-scheme
applyThemeToDocument(brandTheme,uiTheme) AppContext.tsx:150-153 → writes preset.light|dark vars
```

Two more apply sites:
- `packages/app/src/main.tsx:2279-2281` `applyStoredDetachedShellTheme()` →
  `applyUiTheme(resolveUiTheme(loadUiThemeMode()))` — pre-React paint for detached shells
  (onboarding/app windows) so they don't flash.
- User toggle UI: `packages/ui/src/components/settings/AppearanceSettingsSection.tsx:125-142`
  renders three buttons → `setUiThemeMode("system"|"light"|"dark")`.

Storage keys (`persistence.ts`): `eliza:ui-theme-mode` (`:42`), `eliza:ui-theme` (`:40`), legacy
`elizaos:ui-theme` (`:41`).

### C2. Why it currently can look heavy-black
A new user has no stored mode → `system` → on any dark-preferring OS (or any environment without
`matchMedia`, which falls back to `"dark"`) → resolved `dark` → both the `.dark` base.css block
(`--bg: #000000`) and the preset `dark` set (`--bg: #050506`) apply. That is the black look.

### C3. How to force ONE light look (smallest correct changes)

The redesign wants "ONE good-looking look, not really a dark/light toggle." Pin the resolved
`UiTheme` to `"light"` so the preset's light set + base.css `:root` light block are always live.
There are a few levers; the clean approach is to change the resolution layer and retire the toggle:

1. **Default + resolution → light** (`packages/ui/src/state/persistence.ts`):
   - `loadUiThemeMode()` default `"system"` → `"light"` (`:82`), and the legacy-fallback branch
     (`:81`).
   - `getSystemTheme()` no-matchMedia fallback `"dark"` → `"light"` (`:58,61`).
   - Optionally make `resolveUiTheme()` return `"light"` unconditionally (`:65-67`) — the hard pin;
     this single line guarantees light regardless of stored value or OS.
   - `loadUiTheme()` fallback `"dark"` → `"light"` (`:118`), `normalizeUiTheme` default (`:94`).
2. **Retire the toggle** in `AppearanceSettingsSection.tsx:120-143` (remove the light/dark/system
   segmented control, or leave a no-op) so users can't re-enter dark.
3. **base.css dark block** (`[data-theme="dark"],.dark`, `:158-281`) can stay as dead-but-harmless,
   or be deleted once nothing sets `.dark`. Since `applyUiTheme("light")` never adds `.dark`, the
   dark block simply won't match.
4. The preset `dark` set in `presets.ts:85-158` likewise becomes unused (apply-theme only reads
   `theme.dark` when mode==="dark"). Can be deleted later.

**Net:** the system is *already* built to render a fully-themed light look (`presets.ts` light set +
base.css `:root`). Forcing it is a resolution-layer pin, not a re-skin. The brand-preset injection
in `main.tsx:322` already passes the light tokens; nothing in the app *requires* dark.

Caveat: the floating chat/home/onboarding surfaces (section A) are hardcoded dark-glass-on-color and
won't change with the mode — they're designed to float over ANY substrate. They already feel light
because the substrate (orange ambient field) is light/warm. They remain as-is.

---

## (D) Minimal primitive vocabulary (rebuild views from these)

`packages/ui/src/components/ui/` is declared the **only** primitive layer (per `packages/ui/CLAUDE.md`).
All are token-aware (use `bg-card`, `text-muted`, etc.) so they follow the forced-light theme for free.

### Buttons & icon controls — `components/ui/button.tsx`
`Button` (cva). Variants (`:11-23`): `default` (`bg-accent text-accent-fg hover:bg-accent-hover`),
`surface`, `surfaceAccent`, `surfaceDestructive`, `destructive`, `outline`, `secondary`, `ghost`
(`text-muted-strong hover:bg-surface`), `link`. Sizes (`:25-31`): `default h-10`, `sm h-9`, `lg
h-11`, **`icon h-10 w-10`, `icon-sm h-8 w-8`, `icon-lg h-11 w-11`**. Auto-sizes child SVG
(`[&_svg]:size-4`, `:8`), auto `type="button"`. **No dedicated `IconButton`** — the icon-only button
IS `Button size="icon*"` (used 35×). Purpose-built: `new-action-button.tsx` (Plus + label,
`surfaceAccent`), `copy-button.tsx` (Copy↔Check toggle).

### Agent-aware primitives — `agent-surface/components.tsx`
For views the agent can target/drive (`useAgentElement` registration baked in):
- `AgentButton` (`:36-61`) — `<button>` + agent id/role/status/group/description. Roles:
  `button|toggle|tab|link`.
- `AgentInput` (`:72-90`) — `<input>` + agent metadata.
- **`IconTag`** (`:116-139`) — the canonical compact graphic-first chip to **replace bare text
  tags**: `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium`, icon
  `h-3 w-3`, `data-status`. Tones (`:92-98`): `neutral` (`bg-bg-muted text-text border-border`),
  `accent` (`bg-accent-subtle text-accent`), `success`, `warning`, `danger`. Use this instead of
  ad-hoc badges when a view needs a status tag.

### Surfaces & status
- **`card.tsx`** — `Card` (`rounded-sm bg-card/70 text-card-fg`) + variants `default|interactive|
  status|setting|flat`; `CardHeader/Title/Description/Action/Content/Footer`. (Note: `rounded-sm`
  resolves to 3px via the radius token override.)
- **`badge.tsx`** — `Badge` variants `default(bg-primary)|secondary|destructive|outline`.
- **`status-badge.tsx`** (+ `.helpers.ts`) — `StatusBadge` (semantic, tones
  `success|warning|danger|info|neutral|processing|muted`; `processing` spins a `Loader2`),
  `StatusDot`. Helpers `statusToneForBoolean/State`, `statusLabelForState`.
- **`empty-state.tsx`, `banner.tsx`, `alert.tsx`, `skeleton.tsx`, `spinner.tsx`, `progress.tsx`,
  `connection-status.tsx`.**

### Inputs & forms
`input.tsx` (variants `default|form|config`, density `default|compact|relaxed`, `hasError`),
`textarea.tsx`, `switch.tsx` (track `data-[state=checked]:bg-accent`), `checkbox.tsx`, `slider.tsx`,
`select.tsx`, `form.tsx`/`form-select.tsx`/`field.tsx`/`field-switch.tsx`/`input-group.tsx`/
`segmented-control.tsx`/`tag-editor.tsx`/`settings-controls.tsx`/`save-footer.tsx`,
`label.tsx`, `toggle.tsx`.

### Layout & disclosure
`grid.tsx`, `stack.tsx`, `table.tsx`, `separator.tsx`, `scroll-area.tsx`, `tabs.tsx` (`TabsList
bg-bg-accent`, active `data-[state=active]:bg-bg`), `accordion.tsx`, `collapsible.tsx`,
`dialog.tsx`/`alert-dialog.tsx`/`popover.tsx`/`hover-card.tsx`/`tooltip.tsx`/`dropdown-menu.tsx`,
`pagination.tsx`, `carousel.tsx`, `calendar.tsx`, `chart.tsx`, `typography.tsx`, `avatar.tsx`,
`code-block.tsx`.

### Iconography
**lucide-react is THE icon source** — imported across ~178 files in `components/`. No custom icon-set
wrapper at the primitive layer. The redesign's "icons over text" direction is already the house
style; lean on lucide + the inline-SVG glyphs used in the chat composer for the voice/send controls.

---

## (E) Design law — rules every redesigned view should follow

Derived from the reference surfaces (A), the token system (B), and the prompt's direction.

1. **One light look, no toggle.** Pin resolved theme to `light` (section C3). Build against the
   light token set; never assume a dark background. Treat `.dark`/preset-dark as dead.

2. **Reference tokens, never raw colors, for in-flow chrome.** Use `bg-bg`, `bg-card`, `text-txt`,
   `text-muted`, `border-border`, `bg-accent`/`text-accent-fg`. This keeps views theme-correct and
   lets a single token change re-skin everything. (Hardcoded `white/NN` glass is reserved for
   *floating* surfaces over a color field — the chat/home pattern.)

3. **Flat. No shadows, micro-radius.** Shadows are globally `none` and radii globally 3px
   (`base.css`). Don't reintroduce drop-shadows or big rounded cards for content chrome. The ONLY
   places that round hard are floating glass panels (`rounded-2xl/3xl/full` literals) and pills.

4. **Orange is the single accent; blue is secondary/info only.** Accent = `#ff8a24` (CTAs, active
   state, focus ring, links-on-hover). Resolve the orange discrepancy (`#ff5800` in base.css vs
   `#ff8a24` in preset; onboarding hardcodes `#FF5800`) to one value. Idle controls are NEUTRAL
   (neutral-resting → neutral-with-opacity hover), accent appears on hover/active only — exactly the
   `SoftButton` rule (`active ? white fill : white/10 → white/20`). No orange→black hovers.

5. **Icons + color + whitespace over text.** Strip descriptions, helper text, dividers, nested
   cards, and bare text tags. Replace text tags with `IconTag` (graphic-first chip) or a `StatusDot`.
   Use lucide icons; for the voice/chat controls reuse the inline-SVG glyph set.

6. **Render only when populated.** Mirror `HomeScreen` — activity/messages cards mount only when they
   have content; the resting view is calm (clock + tiles). No empty cards, no placeholder rows.

7. **The floating chat is the primary surface; views are the calm backdrop.** Build views to sit
   BEHIND the `ContinuousChatOverlay` (pointer-events-none container), with bottom clearance for the
   composer (`--eliza-continuous-chat-clearance`, see `HomeScreen.tsx:355`). Don't compete with the
   chat for the bottom edge or add a second chat entry point.

8. **Flat color field as background, not black, not photos.** The canonical view background is a flat
   brand color (`ChatAmbientBackground`'s orange) or the light `--bg` (`#eef8ff`). Animation, if any,
   is a compositor-cheap opacity pulse — never per-frame paint or blur tweens.

9. **Whitespace rhythm.** Use the generous gaps the references use (`gap-3/4/5/8`), the 44px touch
   minimum (`min-h-touch`), and Poppins everywhere (one typeface). Tiny labels are uppercase
   `text-[11px]/[13px] tracking-wide text-muted`.

10. **Motion: opacity + translate only, iOS springs.** `ease [0.22,1,0.36,1]`, spring presets like
    the overlay. Honor `prefers-reduced-motion` (collapse to a fade). Never animate `blur`/`filter`
    or scale scrollable content.

---

## Key file index

- Tokens (preset): `packages/ui/src/themes/presets.ts` (`ELIZA_DEFAULT_THEME`)
- Tokens (raw CSS + brand colors + radii/shadow overrides): `packages/ui/src/styles/base.css`
- Token name map: `packages/shared/src/contracts/theme.ts` (`THEME_CSS_VAR_MAP`)
- Apply preset → vars: `packages/ui/src/themes/apply-theme.ts`
- Mode resolve/persist/apply: `packages/ui/src/state/persistence.ts`, `.../useDisplayPreferences.ts`,
  `.../ui-preferences.ts`
- Brand theme injection: `packages/app/src/main.tsx:322`; applied in
  `packages/ui/src/state/AppContext.tsx:148-153`; pre-paint in `main.tsx:2279-2281`
- Theme toggle UI: `packages/ui/src/components/settings/AppearanceSettingsSection.tsx`
- Reference surfaces: `packages/ui/src/components/shell/{ContinuousChatOverlay,HomeScreen,
  ChatAmbientBackground,glass-composer}.tsx`, `packages/ui/src/first-run/FirstRunRuntimeChooser.tsx`
- Primitives: `packages/ui/src/components/ui/*`; agent primitives:
  `packages/ui/src/agent-surface/components.tsx`

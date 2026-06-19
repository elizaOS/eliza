# Minimal, chat-forward redesign — master plan

> Goal: rebuild **every** Eliza app view around minimalism + the floating,
> chat-forward, voice-forward interface. Remove excess text, borders, divs,
> tags, inputs, and "slop". Icons + color + whitespace over text. One curated
> **light** look (no dark/light toggle). Eliza colors: **orange `#ff8a24`**
> (accent), **blue `#1d91e8`** (info/secondary only), white, black (text), some
> gray. Flat, futuristic, modern. Each view shows only what the user needs, lets
> them stay in chat, exposes view-dependent actions, and surfaces proactive
> agent context.

This folder holds the research + the rolling redesign log. Detailed per-view
inventories live in the sibling files:

- `01-builtin-system-views.md` — Apps, Plugins, Config, Settings sections, Cloud, Release, Runtime, Secrets, Heartbeats
- `02-builtin-data-character-views.md` — Database, Memory, Logs, Documents, Relationships, Automations, Browser, Media, Camera, Character, Help, Tutorial
- `03-plugin-views-productivity.md` — Calendar, Todos, Goals, Health, Blocker/Focus, Inbox, Contacts, Phone, Messages, Companion, LifeOps, Documents, Relationships, Social, Feed
- `04-plugin-views-finance-tools-games.md` — Wallet, Finances, Polymarket, Hyperliquid, Shopify, Steward, Vincent, Task-coordinator, Screenshare, Model-tester, Vector-browser, Trajectory-logger, Facewear/XR, games
- `05-e2e-screenshot-harness.md` — how to boot the stack, navigate, and screenshot every view at desktop + mobile

## The single source of "the look"

The **chat** view is the north star: a warm flat brand field (orange ambient),
a floating glass composer pinned bottom-center, big quiet clock, a few pinned
glyph tiles. No chrome, no borders, no walls of text. Every other view should
feel like it belongs on top of that — glanceable content under the same
floating chat.

The app already ships a complete **light** theme (`bg #eef8ff`, glassy white
cards, orange accent) in `packages/ui/src/themes/presets.ts`. The "lots of
black" the user sees comes from two places, both now being fixed:

1. **System-dark default.** `resolveUiTheme`/`getSystemTheme`
   (`packages/ui/src/state/persistence.ts`) used to return `dark` whenever the
   OS preferred dark or `matchMedia` was unavailable. → **Pinned to `light`**;
   the dark/light/system toggle is removed from Appearance settings. There is
   now one curated light look. (The `dark` token set + `.dark` CSS block are now
   dead and can be deleted in a later sweep.)
2. **Hardcoded-dark plugin views.** ~7 plugin views hardcode `#0a0a0a` /
   `#020617` inline themes, and the comms plugins ship a second `#020617`-cyan
   "TUI twin" codepath. Against the now-light builtin views these read as a
   jarring black gap. → fixed per-view (use tokens; delete TUI twins).

## Design laws (apply to every view)

1. **One light surface.** Background = `var(--background)` (or the chat ambient
   for chat). Never hardcode `#0a0a0a`/`#020617`/`bg-black`. No `dark:` variants.
2. **No eyebrow labels.** Delete the uppercase micro `SECTION` / `IDENTITY` /
   `PLUGINS` headers. A glyph + a plain title is enough.
3. **No restating subtitles.** Delete description paragraphs that just re-say the
   title ("Open Calendar.", "Apps and interfaces for your system.", "The agent's
   core instructions."). Keep a subtitle only when it carries new, needed info.
4. **Borders → whitespace.** Replace bordered row-cards with flat rows separated
   by space (or one hairline divider). Don't nest a card in a card. One panel
   edge max. Shadows are globally `none`; lean on it.
5. **One status signal.** Collapse border-color + badge + toggle + text into a
   single dot or pill. Color carries state (green ok / orange busy / red error /
   gray idle); never encode the same fact 3 ways.
6. **Icon + color over text tags.** Replace stacks of text badges
   (`Plugin`/`GUI`/`@elizaos/...`/`/route`) with one glyph and, at most, one
   chip. Use `IconTag` (`packages/ui/src/agent-surface/components.tsx`).
7. **Drop manual Refresh buttons.** Views poll or subscribe; a Refresh button is
   slop. Remove it (keep a quiet auto-refresh).
8. **Fewer inputs.** Per-view search boxes become "search by typing in chat".
   Forms collapse to the few fields that matter; the agent fills the rest.
9. **Orange is accent only; blue is info only.** No green/indigo/purple/cyan
   accents. Resting-orange → darker-orange hover; neutral resting → neutral hover
   (never → black). Fix `#ff5800` → `#ff8a24`.
10. **Agent-controllable + proactive.** Every actionable element uses
    `useAgentElement` (so chat can drive it), every view exposes view-dependent
    actions, and where it helps, a single quiet line of proactive agent context
    (not a banner) tops the view.

## Shared primitive vocabulary (build with these, not bespoke chrome)

- `Button` (incl. `size="icon|icon-sm|icon-lg"`), `Card`, `Badge`,
  `StatusBadge`/`StatusDot`, `Input`, `Switch`, `Tabs` — `components/ui/`.
- `AgentButton` / `AgentInput` / `IconTag` — `agent-surface/components.tsx`.
- Settings: `SettingsGroup` / `SettingsRow` / `SettingsStack` —
  `components/settings/settings-layout`. Sections that hand-roll chrome get
  refactored onto these.
- `lucide-react` is the house icon set.

## Cross-cutting cleanups (kill once, helps everywhere)

- **Dead/duplicate code:** `LifeOpsPageView` (pure stub printing its own class
  name), `StewardVaultOverview` (477 lines, never rendered), `DatabaseView`
  legacy branch (~380 dup lines), comms `#020617` TUI twins (~1500 lines),
  `HeartbeatsDesktopShell` dup, `plugin-view-modal` third config surface.
- **Brand violations:** blue `primary` in `ElizaOsAppsView`, green `#10b981` in
  `AppsPageView`, indigo/cyan in CharacterExperience/Relationships/XR, `#ff5800`
  drift, hover-lift `-translate-y` + shadow in `AdvancedSection`.
- **Repeated motifs:** uppercase eyebrow (6–12×/view), bordered row-card,
  per-view pill components → one chip, "Open X." subtitles (every Views card),
  manual Refresh buttons, triple-encoded status.

## Merge / remove / demote candidates

- **Merge** Contacts + Phone + Messages → one Comms surface.
- **Merge** Todos + Goals + Calendar-agenda → one "Today" surface.
- **Remove** LifeOps stub; demote Social Alpha + Feed out of the default set.
- **Demote behind "Advanced/Developer"** Logs, Trajectories, Database tables,
  vector-browser, smartglasses, model-tester — most users never need raw
  SQL/logs/traces; the agent answers "show me the last error" in chat.
- **Chat-replaceable:** Help (ask→answer is what the agent does), Steward
  approvals (yes/no prompt), Automations create-chooser.

## Rollout (highest impact first)

P0 foundation — **done:** single light look pinned; toggle removed.
P1 high-traffic builtin: Views/Apps, Settings sections, Plugins, Config.
P2 productivity plugin views: Calendar/Todos/Goals/Health/Focus/Inbox/Companion.
P3 comms merge + finance views (wallet/finances light surface).
P4 demote dev tools; delete dead code; games/XR chrome.
P5 e2e: extend `plugin-views-visual.spec.ts` to screenshot every builtin +
   plugin view at desktop + mobile; ensure interaction specs hit every input.

Each view: simplify → screenshot (desktop+mobile) → review against the design
laws → fix → re-screenshot until `good` → adapt/extend e2e. The rolling per-view
verdict log is appended to `99-REDESIGN-LOG.md`.

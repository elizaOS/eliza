# Redesign log (per-view verdicts)

Verdicts: `good` · `needs-work` · `broken`. Newest at bottom.

## P0 — foundation
- **Single light look** — pinned `resolveUiTheme`/`getSystemTheme` to `light` (packages/ui/src/state/persistence.ts); removed dark/light/system toggle from Appearance settings. Verdict: good.

## P1 — high-traffic builtin (verified via dev-server screenshots)
- **Views launcher (ViewCatalog)** — heavy 5-chip/"Open X." cards → flat icon-grid tiles (icon + label only); merged Core/Plugins; icon-only sort; dropped subtitle/meta/Refresh. + ViewIcon label-keyword fallback so every tile gets a distinct glyph. Verdict: good.
- **Settings (Basics/IdentitySection)** — uppercase eyebrow → sentence-case (global SettingsGroup); merged Name/Voice/System-prompt into one group; dropped "core instructions" subtitle. Verdict: good (minor double-border remains; acceptable in light mode).
- **Plugins catalog (PluginCard + PluginsView)** — dropped category eyebrow, "Ready"/"No config needed"/provenance chips (status = ON/OFF toggle + left border); removed "Advanced" eyebrow + "N shown" chip; section headers sentence-case. Verdict: good.

## P2 — plugin views (typecheck-verified; visual pending live-stack rebuild)
- **Todos/Health/Goals/Focus/Inbox** — text "Refresh" → icon-only; Inbox subtitle dropped; #ff6a00 → #ff8a24. (Restating subtitles in Todos/Health/Goals left in place — pinned by tests; revisit with test updates.)
- **AppsPageView** — green #10b981 section accent → orange #ff8a24.
- Note: comms GUI views (Contacts/Phone/Messages) already clean. Dark TUI-twin code co-located in those GUI files (ContactsTuiView/PhoneTuiView/MessagesTuiView) flagged for a separate removal pass.

## Infra note
- Builtin views (App.tsx-rendered) hot-reload in the app vite dev server → full screenshot loop. Plugin views load as pre-built bundles via the stub API → source edits need a bundle/live-stack rebuild to verify visually; rely on typecheck + review in the meantime.

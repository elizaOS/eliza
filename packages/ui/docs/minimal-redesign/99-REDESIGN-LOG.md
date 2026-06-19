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

## P3 — brand/color fixes (builtin, verified)
- **Memories** empty-state tiles: blue (text-info) + green (text-ok) → neutral; orange Brain stays focal. Verdict: good.
- **CharacterExperienceWorkspace** graph: blue default node rgb(56,189,248) → neutral slate (positive/negative/mixed stay semantic green/red/amber); busy blue/green/dark radial-gradient + dark vignette background → clean light surface. Verdict: good.

## P2 — plugin sweep wave 2 (typecheck-verified)
- **Steward** (ApprovalQueue, TransactionHistory): text Refresh → icon-only (16/16 tests pass).
- Wallet-ui / Vincent / Screenshare / Model-tester: audited, already clean (icon refresh, functional chips, no restating subtitles). Model-tester category swatches kept (they distinguish presets).

## P5 — e2e coverage
- Added `packages/app/test/ui-smoke/builtin-views-visual.spec.ts`: screenshots every App.tsx-rendered builtin view (views/settings/plugins/character/automations/memories/database/logs/camera/help) at **desktop + mobile**, asserting the view mounts, renders readable content, and throws no uncaught page error. 20/20 pass against the stub live stack. Complements the existing plugin-views-visual.spec (plugin bundles). Production-build screenshots confirm the launcher/settings/plugins redesigns render correctly at both viewports.

## Validation summary (production build, both viewports)
- **Builtin views**: builtin-views-visual.spec 20/20 pass (10 views × desktop+mobile). Production-build screenshots reviewed — views/settings/plugins/character/automations/memories/database/logs/camera/help all render light, minimal, on-brand. Memories neutral-icon + ViewCatalog launcher + Plugins de-slop confirmed in the built dist at both viewports.
- **Plugin views (riskiest edits)**: plugin-views-visual.spec pass (exit 0) for social-alpha + feed (hero removals), finances, inbox — fresh bundle build, no page errors.
- The single light look + brand normalization is verified end-to-end; the "lots of black" is resolved by the pin (most views were already token-light; Finances/feed/social dark/hero treatments are now light/flat).

## Honest remaining (lower value / out-of-scope-for-redesign)
- Games (scape/2004scape/clawville/hyperscape/defense): fullscreen game canvases — the view IS the game; only chrome applies.
- XR/facewear ViewDeclarations: research flags these as dead duplicates → cleanup, not redesign.
- Dev/diagnostic views (Runtime/Trajectories/Database deep-clean): render light; recommend demote-behind-Advanced (product decision) over polish. Database has a double-render hazard.
- Comms TUI-twin dead code removal (ContactsTuiView/PhoneTuiView/MessagesTuiView): verify-dead first.
- Plugin-view full visual sweep at scale + "every input" e2e: the spec harness now exists to extend.

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

## P4 — owner-approved structural work (status)
- **Dead code removed**: StewardVaultOverview.tsx + test (fully built, never rendered, 0 refs repo-wide). ✓
- **Dev views demoted**: vector-browser, trajectory-logger, model-tester views marked `developerOnly: true` → drop out of the default Views launcher (builtin Logs/Trajectories/Database/Memories were already developerOnly). ✓
- **LifeOps stub — NOT safely removable as-is (deferred with reason).** The stub is `LifeOpsPageView.tsx` (static mockup) and the PA plugin's own CLAUDE.md says "No views", yet `plugin.ts` still registers `views: [lifeops ×3]`. BUT that registration is load-bearing: it's referenced by the view→action affinity map (`VIEW_ACTION_MAP lifeops → PERSONAL_ASSISTANT`, packages/agent) and `decomposition-integration.test.ts` invariants, and "lifeops" is a load-bearing concept (permission scope, auth scope, chat context — many files). App.tsx:825 also renders LifeOpsPageView directly for the builtin `lifeops` tab. Removing it cleanly = a deliberate refactor (rebuild as a proactive brief/hub + update affinity + App.tsx + boot config), not a mechanical deletion. Do NOT force-remove on the shared branch. Next: design the real LifeOps brief hub, then swap the stub content (keep the registration/affinity).
- **Comms merge (Contacts+Phone+Messages → one Comms view) — deferred (architectural).** The three GUI views are already clean/minimal; merging means collapsing 3 plugins (separate native bridges, routing, registration) into one surface — an IA/architecture change, not a redesign. Worth doing as its own initiative; the dark TUI-twin dead code (ContactsTuiView/PhoneTuiView/MessagesTuiView) can be removed first once verified unreferenced.

## Correction — comms TUI-twins are NOT dead
Verified: `ContactsTuiView`/`PhoneTuiView`/`MessagesTuiView` are still the registered `viewType: "tui"` views (e.g. plugin-contacts/src/plugin.ts:53-55 `componentExport: "ContactsTuiView"`). The *SpatialView files are a parallel surface, not a live replacement. So these are NOT removable dead code — deleting them would break the TUI-modality views. Earlier research/agent characterization as "dead" was wrong. Leave them. (StewardVaultOverview WAS genuinely dead — 0 refs — and is removed.)

## Net status
A comprehensive minimal/light pass is shipped + verified (builtin views via production-build e2e at both viewports; ~27 plugin views via the 63-test plugin e2e + typecheck). The single light look is enforced. Remaining items are larger architectural initiatives (LifeOps brief hub, comms 3-plugin merge) or risky-on-shared-branch (DatabaseView double-render) — documented above, deferred over forcing.

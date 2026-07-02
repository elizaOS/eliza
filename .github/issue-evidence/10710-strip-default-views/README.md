# #10710 — strip default-visible views to minimal "eliza" aesthetic

Branch `feat/strip-default-views-10710`. All numbers below are from `bun run --cwd packages/app audit:app`
(349-test playwright matrix: every builtin + plugin view × 5 viewports, rest + hover).

## What changed

Chrome-strip across every default-visible surface (system/release ViewKind), per the flat
pattern codified in `SettingsView`/`HomeScreen` and merged batches #10995/#10786:

- **Launcher / apps grid** (`Launcher.tsx`) — dock band solid-dark card → translucent wash,
  borderless; per-tile borders dropped. This is the shared surface behind
  `/apps`, `/views`, rolodex, contacts, camera, phone, messages.
- **Automations** (`AutomationsFeed`, `WorkflowEditor`, `HeartbeatForm`, `HeartbeatsView`,
  `TaskEditor`, `WorkflowGraphViewer`) — stat cards → plain figures, dividers gone,
  status chips → dot + text, filter pills → borderless text tabs (counts hide at zero).
- **Documents** (`DocumentsView`, `documents-detail`, `documents-upload`) — row/metadata
  chips → middot text, icon tiles → bare icons, dividers gone, scope filters → borderless
  tabs; fixed illegible `text-accent-fg`-on-wash "Add Knowledge" label.
- **Character** (editor panels, experience workspace, hub, roster, timeline, skills,
  music widget) — conversation/example cards, count chips, dashed empty boxes, timeline
  rail, tab-list box all stripped; bottom-line inputs.
- **Training / fine-tuning** (`TrainingDashboard`, `JobDetailPanel`, `BudgetPanel`,
  `InferenceEndpointPanel`, plugin-training views) — table row/header borders, panel
  cards, status pills stripped; progress bars kept (data, not chrome).
- **Settings-reachable + misc** (`SecretsView`, `ConfigPageView`, `config-page-sections`,
  `StreamView`, `MediaGalleryView`, `BrowserWorkspaceView` wrapper fills,
  `PairingView`, `StartupFailureView`, `BugReportModal`, wallet `InventoryAppView`).
- **Chat overlay** (`ContinuousChatOverlay`) — `HeaderButton` → borderless icon-only
  (matches `SoftButton`), composer top divider removed, edit-textarea border removed.
  Glass sheet, bubble tone borders, and warn chips untouched (deliberate design).
- **Shared primitives** — `SegmentedControl` outer box + active border removed;
  `PagePanelFeatureEmpty` icon-medallion border removed; sidebar toggle border removed;
  `AppPageSidebar` right-edge hairline removed; memories feed `divide-y` removed.
- **Semantic chrome kept everywhere**: warn/error/destructive boxes, focus rings,
  active-selection states, drag/drop zones, progress bars, modal/glass scrims
  (self-contained contrast over wallpaper), form-input affordances (bottom-line style).

Also fixed while in here:
- **Triple "Fine-Tuning" launcher tile** — `TAB_PATHS` has both `fine-tuning` and
  `advanced` (same path) plus the `@elizaos/plugin-training` app registration;
  deduped via `CANONICAL_ID` in `launcher-curation.ts`.
- **Stream "Go Live" was a green-tinted CTA** — orange is the only accent; now accent.
  ("Stop Stream" stays danger — semantic destructive.)
- **Radius gate** (`all-views-aesthetic-audit.spec.ts`) — admits `3px` (base.css collapses
  every `--radius-*` token to `--radius-xs: 3px`) and `32px` (the floating chat capsule's
  animated collapsed-state radius, present on every view; it was flagging all 348
  findings as off-token).
- **CI strict flip** (`app-aesthetic-audit.yml`) — `ELIZA_AUDIT_APP_STRICT=1` +
  `ELIZA_AUDIT_APP_STRICT_NEEDS_WORK=1` with an empty `AESTHETIC_VERDICT_DEBT`
  (the #10970 operator steps).

## Border/divider density (per 1M px², ceiling 45) — before → after (final strict run)

| view | desktop | mobile-portrait |
|---|---|---|
| launcher family (apps/views/rolodex/…) | 89.5 → 6.2 | 303.8 → 24.3 |
| fine-tuning | 52.5 → 9.3 | 145.8 → 30.4 |
| automations | 37.0 → 6.2 | 145.8 → 24.3 |
| documents | 27.8 → 6.2 | 109.4 → 24.3 |
| memories | 17.0 → 6.9 | 75.9 → 39.5 |
| stream | 15.4 → 6.2 | 60.8 → 24.3 |

**Final strict-gated run (`ELIZA_AUDIT_APP_STRICT=1` + `_NEEDS_WORK=1`, empty debt):
349/349 passed — 307 good / 41 needs-eyeball (was 136/212), 0 radius violations
(was 348/348), 0 blue, 0 needs-work, 0 broken.** The 41 needs-eyeball are
baselined density entries: developer views (runtime/logs/plugins/skills), plugin
app views (sibling-issue scope), and 3 single-viewport builtin entries
(browser + relationships mobile — functional toolbars / a form select on a
390px viewport — and settings mobile-landscape). Minimalism ratchet baseline
refreshed from this run: 41 entries (launcher family, documents, automations,
fine-tuning, memories, stream all cleared out of the debt record).

Full after-report: `after/report.json`. Baseline (develop tip a9be4f48c70):
`before/report.json`.

## Evidence

- `before/desktop|mobile/*.png` — develop-tip baseline screenshots (18 views × 2 viewports).
- `after/desktop|mobile/*.png` — same views after the strip (final tree: includes the
  Fine-Tuning tile dedup — one tile, was three — and brand-accent native checkboxes).
- `after/report.json` — complete strict-gated run (349/349). `after/report-final-328of349.json`
  — re-run on the final tree (accent-color + dedup): 287 good / 41 needs-eyeball / 0 radius /
  0 blue through test 328, harness-killed (SIGTERM) before the TUI tail; no failures.
- `manual-review/*.md` — per-view/per-viewport verdicts with reviewer notes (all default
  views `good`, eyeballed by hand).
- **Video walkthroughs** — regenerated from the stripped UI by the checked-in ui e2e
  runners: `packages/ui/src/components/pages/__e2e__/output-launcher/launcher-walkthrough.webm`
  and `packages/ui/src/components/shell/__e2e__/output-home/mobile-launcher-flow.webm`
  (+ per-step screenshots/HTML contact sheets alongside).
- Clicksafe e2e: `/apps`, `/views`, `/rolodex` probes were failing on develop tip itself
  (stale text ready-checks pre-dating the launcher surface — verified by running the same
  tests on a clean develop worktree: 5/5 fail there too); fixed here by anchoring on
  `[data-testid="launcher"]` — now pass in ~1s each. The `/polymarket`+`/shopify` probe
  failures are the same pre-existing family (overlay-app shells), fixed separately.
- Full ui suite: **494 files / 5107 tests passed** (run twice: post-strip and post-polish).
- Per-group scoped verification by each strip pass: character 26/26, documents 2/2,
  automations 42/42, apps/shell 89, settings/misc 99, training 40 — plus
  `packages/ui` typecheck (tsgo) and biome 2.5.1 clean on every touched file.
- Real-LLM trajectory: **N/A** — pure presentation/CSS change; no model, action, or
  prompt path touched.
- Backend logs: **N/A** — no server code path changes.
- Known out-of-scope finding: several launcher **icon artworks** contain blue pixels
  (asset-level, invisible to the CSS audit); flagged for the icon-artwork owner.

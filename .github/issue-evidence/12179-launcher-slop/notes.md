# Issue #12179 — Launcher UX: remove slop/legacy state + props (Phase 1)

Human-verifiable evidence for the Phase 1 cleanup (PR-A: WI-1 + WI-2 + WI-4).
This phase is a **pure dead-code / dead-state removal** — the launcher renders
and behaves identically for users, so the proof is (a) the real-browser
walkthroughs still pass green after the machine was ripped out, and (b) the
grep-based "done when" checks are empty.

## What changed (why it's slop)

- **`curateLauncherPages` always returned ≤1 page** (`launcher-curation.ts`), so
  the launcher's entire multi-page machine was production-dead: the inner grid
  pager, page dots, controlled/uncontrolled `localPage` dual mode, and the store
  fields `launcherPage`/`launcherPageCount` never did anything. All deleted.
  `curateLauncherPages` now returns `ViewEntry[]`; the launcher is a single
  scrolling page.
- **`eliza:home-launcher:navigate` window event** was a self-described legacy
  bridge (dispatch → window → store) with one dispatcher pair. Deleted;
  `useShellController.navigateHome` calls `goHome()` directly. The dead
  `navigateToViews` controller method (+ 4 e2e fixture stubs) removed.
- **Dead props / constants / write-only state / telemetry** (WI-4):
  `HomeScreen.clockAccessory` (never passed), `HomeLauncherSurface.className`
  (never passed), `LAUNCHER_PAGE_SIZE` (zero users), `view-recents.ts` (written
  every launch, never read repo-wide), and 7 emitter-less `ViewInteractionAction`
  members + the unused `query` field.

## Rendered proof (real headless Chromium, CDP trusted touch)

Both walkthroughs boot the **real** composed surface (real `HomeLauncherSurface`
+ real `LauncherSurface`/`Launcher`) and drive real pointer/touch input.

`bun run --cwd packages/ui test:launcher-e2e` — **PASSED**
- `launcher-e2e-desktop-rest.png`, `launcher-e2e-mobile-rest.png` — the launcher
  grid renders every curated tile on one page.
- `launcher-e2e-mobile-after-swipe-home.png` — a right-swipe on the launcher
  rides the outer rail back home (`data-page=home`).
- Asserted live: tap launches the tile (onLaunch + telemetry ring), mid-drag rail
  tracks the pointer 1:1 (m41=-281 ≈ expected -281), long-press never enters an
  edit mode, single launcher page window (no `launcher-page-1`).
- Video: `packages/ui/src/components/pages/__e2e__/output-launcher/launcher-walkthrough.webm`.

`bun run --cwd packages/ui test:home-screen-e2e` — **PASSED**
- `home-e2e-04-mobile-launcher.png` / `home-e2e-05-mobile-launcher-single-page.png`
  — 18 distinct hero-image tiles on the single page; a left-swipe rubber-bands
  (no page 2) and stays on the launcher.
- `home-e2e-07-desktop-launcher.png` / `home-e2e-09-desktop-edge-buttons-launcher.png`
  — desktop fine-pointer edge buttons: `<` (→ home) shown on the launcher, `>`
  hidden (rail is at its last page).
- Rail-swipe frame budget: fps=120, p95=9.9ms, dropped 0/304 (0%).
- Video: `packages/ui/src/components/shell/__e2e__/output-home/mobile-launcher-flow.webm`.

## Verification commands + results

| Command | Result |
|---|---|
| `test -- shell-surface-store HomeLauncherSurface useShellController Launcher launcher-curation LauncherSurface HomeScreen useDesktopTabs view-telemetry useHorizontalPager app-navigate-view` | 16 files, **189 passed** |
| `bun run --cwd packages/ui test` (full suite) | 574 passed, 2 failed — both unrelated to launcher (`startup-phase-poll.test.ts`, `WalletKeysSection.test.tsx`; neither imports any touched module; pre-existing timing flakes / worker-fork crash in this worktree) |
| `bun run --cwd packages/ui typecheck` | clean for all touched files; 1 pre-existing unrelated error (`iwer` devDep not installed in the shared worktree node_modules — green on CI) |
| `bunx biome check <changed files>` | clean (auto-fixed 2 format/import-sort) |
| `test:launcher-e2e` / `test:home-screen-e2e` | **PASSED** (see above) |

## "Done when" greps (all empty / expected)

- `home-launcher-events | dispatchHomeLauncherNavigation | launcherPage | navigateToViews` → only the `ViewStatusStates.navigateToViews` live function (a distinct symbol) and DOM-local test variables remain.
- `clockAccessory | LAUNCHER_PAGE_SIZE | recordRecentViewId | view-recents | edit-mode-enter | search-zero-results` → empty (one JSON-literal `action:"search"` in an unrelated trajectory story is mock payload, not the telemetry type).
- `pageGroups | showPageDots | onPageCountChange` → empty.
- `plugins/` consumers of `shell-surface-store` → none (verified before landing).

## Frozen contracts preserved (unchanged)

`home-launcher-surface` + `data-page`, sr-only `home-launcher-page-probe`,
`home-launcher-rail`, `home-launcher-{home,launcher}-page`, `launcher`,
`launcher-page-window`, `launcher-tile-<id>`, `home-screen`,
`home-notification-pull-zone`, `rail-pager-edge-{prev,next}`, and the iOS smoke
waits in `packages/app/src/main.tsx`.

## PR_EVIDENCE checklist

- Before/after full-page screenshots (desktop + mobile): rendered proof attached (e2e PNGs, both viewports). Visual output is unchanged by design (dead-code removal) — N/A for a visual diff.
- Video walkthrough: `launcher-walkthrough.webm` + `mobile-launcher-flow.webm` (committed in the e2e output dirs).
- Backend structured logs: N/A — client-only UI change, no server code touched.
- Real-LLM trajectories: N/A — no agent/action/provider/prompt/model behavior changed.
- Frontend console/network logs: e2e runner asserts **0 page errors**.
- Non-happy states: loading skeleton (Launcher `loading`), empty catalog, and rejected gestures (rubber-band, below-threshold drag) covered by unit + e2e.
- `audit:app` (packages/app visual loop): deferred to Phase 4 (WI-9) per the dossier's phase plan; no `packages/app` source changed in this PR.

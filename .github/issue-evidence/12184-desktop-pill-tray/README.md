# #12184 Phase 1 — Desktop pill + tray launcher: evidence

Branch `feat/12184-desktop-pill-tray-phase1`. App-layer only (electrobun@1.18.1
npm APIs, zero fork changes), per the settled dossier plan (D1–D10).

## What shipped (per work item)

| Item | Change | Proof |
| --- | --- | --- |
| W1 | Pill window: `passthrough: true` (OS click-through on the transparent strip, direct + isolated-CEF paths), darwin `setVisibleOnAllWorkspaces(true)`, re-anchor on `showWindow()` + 5s poll via pure `shouldReanchorBottomBar()`; stale "No hide()" comment fixed | `desktop-bottom-bar-config.test.ts` (re-anchor cases), full EB lane green |
| W2 | Global hotkey toggles the overlay (focused+visible → hide, else show+focus) via pure `decideChatOverlayToggle()`; Escape collapses the overlay first, hides the window when already collapsed | `packages/app/src/desktop-hotkey.test.ts` (3 cases) |
| W3 | Tray popover anchored at real `Tray.getBounds()` via pure `computeTrayPopoverFrame()` (bottom-left→top-left y-flip, x-centering, work-area clamp, zero-rect top-right fallback); window reused across toggles; blur-dismiss with 200 ms tray-click re-entry guard | `tray-popover-position.test.ts` (6 cases incl. clamping + y-flip), `desktop-window.test.ts` popover suite |
| W4 | `TrayLauncher` rows (icon + label per `DESKTOP_VIEW_WINDOWS` entry + "Open Eliza") above the WidgetHost stack in `TrayPopoverShell`; rows dispatch existing `tray-open-view-*` / `tray-show-window` ids through the shared `TRAY_ACTION_EVENT` handling — no new RPC, no catalog duplication (host registers localized rows into a ui store; ui cannot import app-core) | `TrayLauncher.test.tsx` (5 cases) + story |
| W5 | Dockless macOS default: `shouldStartTrayFirst` ON for darwin (kill switch `ELIZA_DESKTOP_TRAY_FIRST=0`); pill still created at boot; Dock icon visible iff the set of full/managed windows (dashboard/surface/settings/app — `SurfaceWindowManager.onRegistryChanged` + main-window full/pill flag) is non-empty | updated `desktop-experience-contract.test.ts` + `desktop-tray-config.test.ts`; new `DesktopManager` dockless Dock-tracking suite; `desktop-window-lifecycle.md` updated in the same PR |

## Verification (commands run, real output)

- `bunx vitest run --config vitest.electrobun.config.ts` (packages/app-core/platforms/electrobun):
  **61 files / 447 tests passed** — includes the new `tray-popover-position`,
  re-anchor, and dockless Dock-tracking tests and the UPDATED
  `desktop-experience-contract.test.ts`.
- `bun run --cwd packages/ui test -- TrayLauncher`: **5/5 passed**.
- `bunx vitest run --config packages/app/vitest.config.ts src/desktop-hotkey.test.ts`: **3/3 passed**.
- `bun run --cwd packages/app-core typecheck`: clean.
- `bun run --cwd packages/app-core/platforms/electrobun typecheck`: clean.
- `bun run --cwd packages/ui typecheck`: only pre-existing failure
  (`src/spatial/__e2e__/immersive-fixture.ts` → missing optional `iwer` module;
  untouched by this PR).
- `biome lint` over every touched file: clean.
- `bun run --cwd packages/ui test -- App`: all App suites pass except the
  pre-existing `App.screen-background-fuzz.test.tsx` worker-pool crash
  (crashes identically on unmodified checkout; 0 assertions run — worktree
  resource flake, not a regression).

## Live capture — attempted, blocked by worktree topology (not faked)

Two real launch attempts on this Mac (Apple Silicon, macOS):

1. `ELIZA_DESKTOP_SCREENSHOT_SERVER=1 bun run dev:desktop` — renderer
   `vite build` fails: `Could not load packages/ui/node_modules/lucide-react`.
   This agent worktree (`.claude/worktrees/…`) shares the parent checkout's
   `node_modules`; per-package `node_modules` dirs are empty here, so
   package-relative resolution fails. Worked around with a symlink to the
   parent's `lucide-react`.
2. Re-run after the symlink — build progresses (12,406 modules transformed)
   then fails inside the **parent tree's** stale `@elizaos/core` browser dist:
   `"Buffer" is not exported by "__vite-browser-external", imported by
   /Users/…/eliza/packages/core/dist/browser/index.browser.js` (parent path;
   the parent checkout is on a different branch with concurrent agents).
   Rebuilding the parent's dist would mutate shared artifacts under another
   branch mid-flight, so it was not done. `dev:desktop:watch` and the packaged
   `desktop-build.mjs build` path run the same renderer build first and hit the
   same wall.

Consequence: `GET /api/dev/cursor-screenshot` captures of the pill, popover
launcher rows, hidden Dock icon, hotkey toggle, Escape, and blur-dismiss could
not be produced from this worktree. They require a normal checkout with its own
`bun install` + built `@elizaos/core` dist — flagged for pre-merge capture (the
Phase 3 / W10 item in the dossier also re-captures per-OS evidence after the
Phase 2 fork bump).

## Evidence rows (PR_EVIDENCE.md)

| Row | Status |
| --- | --- |
| Real-LLM trajectories | N/A — no agent/action/provider/prompt/model behavior change; window-management + shell UI only |
| Backend structured logs | Partial — boot logs from the live-launch attempts captured (`[Main] …` lines print before the renderer build gate); full-path logs blocked as above |
| Frontend console/network logs | N/A — blocked by the renderer-build blocker above |
| Before/after screenshots (desktop) | N/A — blocked by the renderer-build blocker above; unit + contract tests pin every behavioral default |
| Before/after screenshots (mobile) | N/A — desktop-only change; no mobile surface touched |
| Video walkthrough | N/A — blocked by the renderer-build blocker above |
| Per-platform capture: macOS | N/A — same blocker; macOS is the only Phase-1 target |
| Per-platform capture: Windows | N/A — requires Phase 2 fork work (G3/G4) + non-mac hardware, per dossier D8 |
| Per-platform capture: Linux | N/A — requires Phase 2 fork work + non-mac hardware, per dossier D8 (Linux tray is menu-only by platform constraint) |
| Audio/narrated walkthrough | N/A — no voice/TTS/STT change |
| Domain artifacts | Unit/contract test output above; no DB/memory/chain artifacts in scope |

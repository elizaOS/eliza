# D3 — one-command iOS dev automation: SIMULATOR validation run

Leg D3 of the iOS agent-boot-automation epic (branch
`feat/ios-agent-boot-automation`, stacked on the #11030 fix). Delivers three
one-command scripts plus the **committed** XCUITest capture harness (the prior
session's harness lived only in DerivedData and died).

## What is committed

| Piece | Path |
|---|---|
| Device deploy (build→graft→sign→verify→install→launch) | `packages/app/scripts/ios-device-deploy.mjs` (`bun run ios:device:deploy`) |
| Device logs (bounded devicectl console + boot-trace pull) | `packages/app/scripts/ios-device-logs.mjs` (`bun run ios:device:logs`) |
| XCUITest boot capture (sim + device) | `packages/app/scripts/ios-device-capture.mjs` (`bun run capture:ios-sim:boot` / `bun run ios:device:capture`) |
| Pure decision logic + unit tests (33) | `packages/app/scripts/ios-device-lib.mjs` + `ios-device-lib.test.mjs` (runs in `bun run --cwd packages/app test`, the root `test:client` lane) |
| XCUITest harness source | `packages/app-core/platforms/ios/App/AppUITests/BootCaptureUITests.swift` |
| Xcode target + shared schemes (template, propagated by cap sync) | `packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj` (`AppUITests` target) + `xcshareddata/xcschemes/{App,AppUITests}.xcscheme` |
| Docs | `packages/app/CLAUDE.md` + `AGENTS.md` § "iOS device automation" |

## Simulator validation (this phase; device validation happens in phase B — leg D1 owns the physical phone)

Environment: booted iPhone 16 simulator `39F890C2-072D-4BFE-9144-5327AF30B10A`
(iOS 18.1), worktree HEAD `8abbb50e940`, renderer dist buildId `1b42c91d2f46…`
(`variant=direct, capacitorTarget=ios, runtimeMode=local`, commit `8abbb50…`).

Steps actually run:

1. `run-mobile-build.mjs ios-local` (sim destination, full-Bun) — rebuilt the
   lane with the committed template changes; the template sync delivered the
   `AppUITests` target + shared schemes into the generated `packages/app/ios`
   project and the lane built green with the committed `App.xcscheme`
   (`sim-lane-rebuild-tail.log`, `** BUILD SUCCEEDED **`).
2. One command, end to end (twice — see honest notes for what the first run
   caught):

   ```bash
   node scripts/ios-device-capture.mjs --platform sim \
     --device 39F890C2-072D-4BFE-9144-5327AF30B10A --output <dir>
   ```

   → `xcodebuild build-for-testing -scheme AppUITests` (`** TEST BUILD
   SUCCEEDED **`, BootCaptureUITests.swift compiled from the committed
   template source) → generated
   `AppUITests_AppUITests_iphonesimulator26.4-arm64.xctestrun` →
   `simctl install` of `AppUITests-Runner.app` + `App.app` (automatic
   pre-install step) → `test-without-building` drove the app on the booted
   sim → attachments exported from `BootCapture.xcresult`.

### Results (artifacts in this directory, all reviewed by hand)

- **Verdict: PASSED** — `testBootReachesHomeOrErrorCard` passed in 6.4 s
  (`sim-test-summary.json`: `"result": "Passed"`, 1/1 test;
  `sim-capture-run.log`: the `[ios-device-capture]` step lines +
  `boot capture PASSED (home or startup-failure card reached)`).
- `sim-boot-000s-splash.png` — t=0 s: the orange "Booting up…" splash.
- `sim-boot-final-home.png` — final state: live home surface (clock widget,
  weather card, "Welcome — ask me anything" chips, composer "Choose an option
  to continue"). Boot reached home in <7 s, so the filmstrip is two frames —
  the 15 s interval shots only appear on slow boots.
- `sim-ax-hierarchy.txt` — exported AX snapshot: live `WebView` with
  focusable `Button`/`StaticText` elements (an interactive UI, not a splash).

### Honest notes

- **The first end-to-end run of this session caught a real bug and it is now
  fixed in the scripts**: `extractXctestrunAppPaths` /
  `rewriteXctestrunUITargetApp` originally only handled a FormatVersion 2
  layout with `TestConfigurations` nested under a root dict — but xcodebuild
  emits `TestConfigurations` as a **root-level array**, so the sim
  pre-install step silently installed nothing (run #1 still passed only
  because the previous session had manually installed the runner). Both
  functions now handle the real root-level shape (unit-tested against the
  actual structure), and run #2 shows `simctl install AppUITests-Runner.app`
  + `simctl install App.app` firing (`sim-capture-run.log`). This pre-install
  is the scripted fix for the prior session's manual workaround
  (`SBMainWorkspace: Unknown application display identifier
  ai.elizaos.app.xctrunner`).
- The relocated working `.xctestrun` (written to `--output`) now has
  `__TESTROOT__` resolved to the original Build/Products dir before use —
  xcodebuild expands the placeholder against the `.xctestrun` file's own
  directory, so the unresolved copy would have pointed `TestHostPath` at the
  wrong place on device runs.
- Device lane of `ios-device-capture.mjs` (xctestrun `UITargetAppPath`
  rewrite onto the grafted-signature App.app) and `ios-device-deploy.mjs` /
  `ios-device-logs.mjs` are codified from the proven #11030 recipe
  (`.github/issue-evidence/11030-ios-boot-fix/device-boot-README.md`) but are
  **not device-validated here** — the physical phone belongs to leg D1 this
  phase; device validation happens in phase B. Their argument/error paths
  were exercised (missing device, unknown device, `--help`): each fails with
  actionable remediation, exit 1, no stack traces.
- Boot-trace pull path is coupled to leg D1's sink
  (`ElizaStartupTrace.swift`: primary `Documents/eliza-boot-trace.jsonl` +
  rotated `eliza-boot-trace.prev.jsonl`; the renderer appends into the SAME
  primary file via the Agent plugin's `appendBootTrace` bridge — there is no
  separate renderer stream, and `ELIZA_IOS_BOOT_TRACE_PATH` is a pull-side
  override consumed only by `ios-device-logs.mjs`, not by native code) —
  constants mirrored in `ios-device-lib.mjs` with a coupling note in both
  files.

## Re-verification pass (same day, post-commit `c24f720d277`)

A second independent end-to-end run (fresh `build-for-testing` + a follow-up
`--skip-build` run into a deliberately dirty output dir) re-validated the
committed tooling and caught **two more real bugs, both fixed**:

1. **`devicectl … --json-output /dev/stdout` never worked** — devicectl writes
   its JSON with atomic-save file semantics, so targeting `/dev/stdout` fails
   with `NSCocoaErrorDomain error 512` ("The file 'stdout' couldn't be saved in
   the folder 'dev'"), which surfaced as a JSON-parse stack trace instead of a
   device listing. All three scripts now route the JSON through a temp file via
   the shared impure helper `scripts/ios-device-devicectl.mjs` (the pure lib
   stays side-effect free). Proven against the real device list: the
   unknown-device path now prints the actual paired phones
   ("Known devices: MoonCycles …, Shaw's iPhone …") and exits 1.
2. **Attachment export failed on a reused output dir** — `xcresulttool export
   attachments` refuses to write `manifest.json` into a directory that already
   has one (and stale files would mix runs). `ios-device-capture.mjs` now clears
   `attachments/` before exporting, mirroring what it already did for the
   `.xcresult` bundle. Re-run into the same dirty dir: clean export, exit 0.

Re-verification artifacts (reviewed by hand):

- `sim-reverify-capture.log.txt` — the `--skip-build` run end to end
  (`.txt` suffix because `*.log` is repo-gitignored):
  `simctl install` pre-install → `TEST EXECUTE SUCCEEDED`
  (`testBootReachesHomeOrErrorCard` passed, 19.6 s in the fresh-build pass) →
  3 attachments exported → `boot capture PASSED`.
- `sim-reverify-final-home.png` — final frame: live home surface (2:01 AM
  clock, weather card, welcome chips, "Choose an option to continue" composer).
- `sim-reverify-test-summary.json` — `"result": "Passed"`, 1 passed / 0 failed.

Also corrected in this pass: the boot-trace coupling constants now match leg
D1's REAL sink (single primary file + `.prev` rotation; no
`eliza-boot-trace.renderer.jsonl` — the renderer appends into the same file via
the `appendBootTrace` bridge), in `ios-device-lib.mjs` and the package docs.

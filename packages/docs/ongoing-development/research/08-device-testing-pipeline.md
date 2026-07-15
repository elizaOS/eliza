# On-device testing pipeline (Android + iOS fleet)

## Summary

The MVP is the LifeOps Personal Assistant (GitHub project 15): chat, onboarding, the
current views, and LifeOps scheduling/reminders/goals/tasks, serving children, adults
with ADHD/ADD/Asperger's/autism, neurotypical adults, and elderly users through real-life
scenarios — no therapy language, no special rails. Every dev machine has Android and iOS
devices plugged in; those devices ARE the mobile e2e environment (CI has no iOS e2e lane
at all, and the Android CI lane is dispatch-only with a known x86_64 SIGSEGV limitation).
The MVP question for this workstream: can any engineer or coding agent, on any dev
machine, run one command per platform that builds current develop, installs it on the
plugged-in device, runs the e2e lane, and hands back a triage-ready artifact bundle —
and can they check at a glance whether every connected device runs develop HEAD?

Decision: **do not build new infrastructure.** Nearly every primitive already exists —
per-platform orchestrators, a physical-iPhone deploy pipeline, a content-derived renderer
build stamp carrying the git commit, capture scripts, an evidence-required gate. The work
is (1) fixing a verified stale-install bug in the Android runner, (2) wiring the existing
build stamp into a fleet-wide `devices:status` check, (3) collapsing scattered artifacts
into one run-scoped bundle in inline-postable formats (MP4/JPG), and (4) chaining the
already-proven physical-iPhone scripts into one command.

## Current state

What exists today, verified in code:

**Per-platform e2e orchestrators exist and are real (not mocks).**
- `packages/app/scripts/android-e2e.mjs:189-281` — single entrypoint: boots an
  emulator or reuses an attached device (`lib/android-device.mjs:263-276` prefers the
  attached physical device), installs the APK, runs the on-device local-model chat smoke,
  drives every route on the real WebView via Playwright's Android driver, optional cloud
  probe. Loud non-zero exits.
- `packages/app/scripts/ios-e2e.mjs:87-131` — simulator lane: boots a sim, builds by
  default (`build:ios:local:sim`), runs the auth deep-link smoke and the full-Bun
  on-device local chat smoke. **Simulator only** — there is no physical-iPhone e2e
  entrypoint; the pieces exist but are not chained (see below).

**Verified bug: the Android runner runs stale builds by default.**
`android-e2e.mjs:202-214`: `--build` is opt-in, and the install step is
`if (!isInstalled(...))` — `isInstalled` (`lib/android-device.mjs:382-392`) only checks
`pm list packages`. Consequences: (a) the default run executes whatever APK was installed
last week; (b) even `--build` builds a fresh APK and then **skips installing it** when
any version of the app is already on the device. This is the exact Capacitor
bake-the-web-bundle-into-the-APK footgun the root `CLAUDE.md` warns about, live in the
runner itself.

**A build-identity stamp already exists — but is only enforced on the iOS simulator.**
- `packages/app/vite/renderer-build-manifest-plugin.ts:13-37` writes
  `dist/eliza-renderer-build.json` on every production renderer build: content-derived
  `buildId`, `commit` (git HEAD), variant, capacitorTarget, runtimeMode.
- `packages/app/src/renderer-build-stamp.ts:1-36` exposes it at runtime as
  `window.__ELIZA_RENDERER_BUILD__` and at the web root.
- `packages/app/scripts/lib/ios-renderer-stamp.mjs:123-145`
  (`assertInstalledIosAppRendererFresh`) compares the installed sim app's stamp against
  fresh dist — used by `mobile-local-chat-smoke.mjs:336` and
  `ios-onboarding-smoke.mjs:184-218`.
- `packages/app-core/scripts/lib/mobile-lane-stamp.mjs:1-31` guards against wrong-lane
  dist reuse pre-Capacitor-sync (#11030).
- **Gaps:** no Android installed-freshness check anywhere (the stamp ships inside the APK
  at `assets/public/eliza-renderer-build.json` since Capacitor `webDir: "dist"`,
  `capacitor.config.ts:129`, but nothing reads it back); no physical-iOS freshness check;
  no fleet-wide "what does each connected device run vs develop HEAD" report.
  `ELIZAOS_VERSION_NAME`/`CODE` stamping in `run-mobile-build.mjs:807-887` only fires
  when the env vars are set — dev builds all report `1.0`.

**Physical-iPhone pipeline exists and is proven, but is four separate commands.**
- `packages/app/scripts/ios-device-deploy.mjs` — unsigned build → provisioning-profile
  auto-discovery → graft → explicit nested signing → `devicectl` install → launch.
  `--skip-appexes` (lines 24-36, 429-441; PR #13174, merged 2026-07-04) strips the five
  app extensions so the main app deploys with only the app's own team profile — the
  unattended posture, since minting per-appex profiles needs an Xcode account session or
  an ASC API key, neither available headlessly on dev machines.
- `packages/app/scripts/ios-device-capture.mjs` — XCUITest BootCapture harness
  (screenshots via XCUIScreen, exports attachments + `test-summary.json` from the
  .xcresult, lines 522-537); retry-in-isolation for flake cascades landed in #13698.
- `packages/app/scripts/ios-device-logs.mjs` — bounded console capture + boot-trace pull
  (with the #11515 caveat: attached console SIGTRAPs the full-Bun engine, so engine
  observability uses `--no-console --pull-boot-trace`).
- No deploy ledger: nothing records which buildId/commit was last deployed to which
  physical device, and `ios-device-deploy.mjs` has no renderer-freshness assertion
  (verified: zero matches for `renderer|stale|fresh` in the file).

**Capture and evidence tooling exists but targets the old evidence mechanics.**
- `packages/app/scripts/capture-ios-sim.mjs:48-79` records `.mov` via
  `simctl io recordVideo` (h264 in a QuickTime container) — GitHub does **not** render
  `.mov` inline in issues/PRs, so today's iOS captures cannot satisfy the new
  inline-evidence rule without a remux. `capture-android-emu.mjs:84-158` records `.mp4`
  (fine), plus `logcat -d -t 500` and a backend-log pull.
- All capture defaults write to `.github/issue-evidence/`
  (`lib/issue-evidence.mjs:16-21`) — the repo is moving to inline PR/issue posting
  (MP4 + JPG), so the committed-evidence directory stops being the destination.
- The green-with-nothing fix landed (#13624): `resolveRequireEvidence` +
  `skip()` exiting non-zero when evidence is required
  (`lib/issue-evidence.mjs:60-100,246-260`; sweep enforcement in
  `scripts/e2e-recordings/run-all.mjs:56-61,388-402`).

**Failure surfacing is stdout-only and artifacts scatter across five locations.**
- `playwright.android.config.ts:36-43`: reporters are `list` + `html` — no JUnit, no
  JSON; screenshots `only-on-failure`, trace `retain-on-failure`, landing in Playwright's
  own `test-results/`.
- iOS smokes throw with a screenshot path embedded in the error string
  (`mobile-local-chat-smoke.mjs:1475-1492`) — actionable only if you scroll the log.
- Artifact locations today: `.github/issue-evidence/`, `e2e-recordings/<suite>/test-results/`,
  `packages/app/ios/build/{device-deploy-stage,device-logs,boot-capture}/`,
  Playwright `test-results/`, `reports/walkthrough/`. No single per-run bundle.
- `packages/app/scripts/walkthrough-device-matrix.mjs:20-26` is the closest thing to a
  fleet probe: it detects available platforms and writes an honest per-platform
  `device-matrix.json` (run | n/a + reason) — but it reports availability, not
  installed-build-vs-HEAD.

**CI cannot replace the dev-machine fleet.**
`.github/workflows/mobile-build-smoke.yml` is the canonical simulator build/smoke
authority for iOS and Android; its iOS local-runtime lane is nightly because it stages a
real GGUF and performs CPU inference. `.github/workflows/android-device-e2e.yml` adds a
dispatch-only hardware lane plus a minimal PR slice behind the `ci:device` label, but its
header documents that the on-device agent SIGSEGVs on stock x86_64 emulators. The
local-model route only greens on real arm64 hardware, so the plugged-in device fleet
remains the authority for real mobile-device paths.

**No device lease.** Concurrent agent sessions on one machine collide on the same
simulator/device — `ios-e2e.mjs:50-61` grabs the first booted simulator; nothing locks a
serial/udid. This has caused real contention between concurrent sessions on this fleet.

## Design considerations

- **Wire, don't build.** Every capability the mission asks for maps onto an existing
  script; the deltas are defaults, one new ~200-line status script, and bundle plumbing.
- **Freshness must be stamp-driven, not rebuild-always.** The renderer stamp is
  content-derived and carries the commit; comparing installed-vs-fresh `buildId` makes
  "skip the 4-minute rebuild when nothing changed" safe, and makes "reinstall when stale"
  automatic. Rebuild-always would make the runner too slow to be run habitually.
- **Inline evidence formats are a capture-time concern.** MP4 renders inline on GitHub;
  MOV does not. The simctl recording is already h264, so `.mov → .mp4` is a container
  remux (`ffmpeg -c copy`), not a re-encode. Screenshots stay PNG for pixel assertions;
  the bundle emits JPG copies for posting.
- **JUnit-ish summary is nearly free.** Playwright ships `junit` and `json` reporters —
  adding them to `playwright.android.config.ts` is config. The non-Playwright iOS smokes
  need a small shared `summary.json` writer; `ios-device-capture.mjs` already writes
  `test-summary.json`, so the schema should extend that shape.
- **Fail-fast doctrine applies to the runners.** On a fleet machine with devices
  guaranteed plugged in, a runner that soft-skips "no device" is lying. The
  `--require-evidence` contract (#13624) already encodes this; the per-platform runners
  should arm it by default and keep the opt-out.
- **Point-of-failure forensics beat post-hoc archaeology.** The runner already owns the
  child-process boundary (`android-e2e.mjs:162-171 run()`); catching a failed step there
  and immediately capturing screenshot + `logcat -d` / boot-trace is a ~30-line change
  per platform, not a framework.

## Open questions → answers

**Q1. Should the per-platform runner always rebuild?**
No — stamp-driven. Default flow: compute fresh-dist `buildId` (building only if dist is
missing/stale for the lane per `mobile-lane-stamp.mjs`), read the installed stamp, and
rebuild+reinstall only on mismatch. `--skip-build` stays for tight iteration,
`--force-build` for paranoia. Rationale: correctness of the Capacitor footgun without
making the habitual command cost 5+ minutes when nothing changed.

**Q2. Where do triage bundles live now that `.github/issue-evidence/` is deprecated as a
destination?**
A gitignored run-scoped directory: `packages/app/device-e2e-output/<platform>-<runId>/`
with `inline/` (the MP4s + JPGs sized for posting), `logs/`, `summary.json`, and
`junit.xml`. The runner prints the absolute path as its last line so an agent can post
`inline/` contents directly to the PR. Existing `.github/issue-evidence/` writers remain
untouched for old flows but the runners stop defaulting there.

**Q3. JUnit or JSON as the machine-readable summary?**
Both, JSON canonical. `summary.json` (shared schema: lane, device identity, installed
buildId/commit, steps[] with status/duration/artifact paths) is what coding agents parse;
`junit.xml` is a free byproduct of the Playwright reporter for anything expecting JUnit.
Undecidable-free: nothing consumes JUnit today, so JSON-canonical costs nothing.

**Q4. Do we try to green the CI emulator's local-model route for MVP?**
No. The x86_64 SIGSEGV is a hardware-emulation issue documented in
`android-device-e2e.yml`; the fix (self-hosted arm64 runner) is infrastructure the MVP
does not need while every dev machine has real arm64 devices attached. CI stays
dispatch/label-gated; the fleet is the mobile e2e environment of record.

**Q5. Do we need a device farm / fleet service?**
No. One machine, a handful of devices, multiple concurrent agent sessions — the failure
mode is contention, not scale. A lease lockfile keyed by serial/udid under the state dir
(stale-expiry, holder PID + session id) is sufficient and deletes nothing if unused.

**Q6. What about the iOS appex signing blocker for unattended runs?**
Accept `--skip-appexes` as the default unattended posture (already merged, PR #13174) and
have the runner log loudly that widgets/keyboard/device-activity surfaces are untested on
device. Minting per-appex profiles requires an ASC API key — a real owner decision
(credential provisioning), default: park it; the MVP surfaces (chat, onboarding, views,
LifeOps) do not live in appexes.

**Q7. How does a physical iPhone report its installed build when we can't read its app
container?**
Deploy-time ledger. `ios-device-deploy.mjs` stages the App.app locally, so it can read
the staged bundle's renderer stamp and append `{udid, buildId, commit, deployedAt}` to a
state-dir ledger; `devices:status` reads the ledger and reports "unknown — no ledger
entry" honestly when a device was flashed by other means. The boot-trace pull
(`ios:device:logs --pull-boot-trace`) remains the ground-truth cross-check.

## Recommendation

Minimal-scope MVP plan, in order:

1. **Fix the Android stale-install bug and make freshness stamp-driven** in
   `android-e2e.mjs` (P0). Add the Android installed-stamp reader
   (`pm path` → pull APK → read `assets/public/eliza-renderer-build.json`) to
   `lib/android-device.mjs`; reinstall on mismatch; make `--build` actually reinstall.
2. **Ship `devices:status`** (P0): one read-only script enumerating `adb devices`,
   `simctl list`, `devicectl list devices`; per device print installed
   buildId/commit vs `origin/develop` HEAD and fresh dist; exit non-zero on `--require-fresh`.
3. **Triage bundle + machine-readable summary** (P1): run-scoped output dir, Playwright
   junit+json reporters, shared `summary.json` writer, MOV→MP4 remux + JPG copies in
   `inline/`.
4. **One-command physical-iPhone lane** (P1): chain deploy (`--skip-appexes` default) →
   local-chat smoke → BootCapture → logs → bundle, and write the deploy ledger.
5. **Point-of-failure forensics** (P1): failed step ⇒ immediate screenshot + device log
   snapshot into the bundle; runner exit summary names the failing step + artifact paths.
6. **Device lease lock** (P2): serial/udid-keyed lockfile so concurrent sessions queue
   instead of colliding.

## Out of scope (MVP non-goals)

- Greening the CI x86_64 emulator local-model route or standing up self-hosted arm64
  runners.
- Automating per-appex provisioning-profile minting (needs ASC API key — owner decision).
- Any device-farm service, remote-device brokering, or multi-machine fleet orchestration.
- Changes to desktop capture lanes (`capture-linux-desktop.mjs`,
  `capture-windows-desktop.mjs`, `capture-macos-desktop.mjs`) — they already exist and
  are not on the mobile-fleet path.
- New mobile test *content* (LifeOps scenario coverage is the scenarios workstream; this
  workstream is the pipeline those tests run on).
- Store-release signing/TestFlight automation (`apple-store-release.yml`,
  `android-release.yml` are separate release lanes).

## Proposed issues

1. [device-testing] android-e2e runs stale builds: install-if-missing skips fresh APKs — make freshness stamp-driven (P0)
2. [device-testing] devices:status — report installed buildId/commit per connected device vs develop HEAD (P0)
3. [device-testing] Triage-ready artifact bundle per device-e2e run: MP4 + JPG + logs + summary.json + junit.xml (P1)
4. [device-testing] One-command physical-iPhone e2e lane (deploy → smoke → capture → bundle) with deploy ledger (P1)
5. [device-testing] Point-of-failure forensics: auto-capture screenshot + device logs when a runner step fails (P1)
6. [device-testing] Device lease lock: stop concurrent agent sessions colliding on one simulator/device (P2)

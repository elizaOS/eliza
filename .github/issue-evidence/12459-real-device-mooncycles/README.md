# Real-device lifecycle matrix — physical iPhone "MoonCycles" (#12459 / #12185)

Real-hardware counterpart to the simulator/emulator lifecycle lane
(`packages/app/scripts/ios-sim-lifecycle.mjs`,
`.github/issue-evidence/12185-device-lifecycle/`). Everything here was run
against ONE owner-authorized physical device and nothing else.

## TL;DR outcome

- **Device build + code-sign: SUCCEEDED** on real A18 Pro hardware (full-Bun
  engine, `** BUILD SUCCEEDED **`, `codesign --verify --deep --strict` OK).
- **Install on MoonCycles: BLOCKED** — the device is paired over a wireless
  (localNetwork) tunnel with **no USB cable**, and CoreDevice does not offer the
  `installapp` capability over wireless. First install requires a cable, which a
  headless environment cannot provide. This is the exact blocker; it is a
  transport limitation, not a signing or code failure.
- **Lifecycle events: not executed this session** (install is their
  prerequisite). The committed `AppUITests/DeviceLifecycleUITests` harness is
  ready and every event's backing CoreDevice/XCUITest primitive is confirmed
  present on the device — see `matrix.md` (authoritative) and
  `device-capabilities-wireless.txt`.

## Device under test (the only device touched)

| Property | Value |
|---|---|
| Name | **MoonCycles** |
| Model | iPhone 16 Pro Max (iPhone17,2, `D94AP`) |
| iOS | 18.7.8 (build 22H352) |
| Hardware UDID | `00008140-0006491E2E90801C` |
| CoreDevice identifier | `59EBB356-BC44-5AA2-91F1-E6AAE756BB86` |
| Developer Mode | enabled |
| Pairing / transport | paired, CoreDevice localNetwork tunnel |

Every `devicectl` call targeted `--device 00008140-0006491E2E90801C`; every
`xcodebuild` run targeted `-destination 'platform=iOS,id=00008140-0006491E2E90801C'`.
"Shaw's iPhone" (`00008130-001955E91EF8001C`, iPhone 15 Pro) and all other
devices were never addressed. The `00008140` SoC prefix = A18 Pro = iPhone 16
Pro Max; `00008130` = A17 Pro = iPhone 15 Pro — the prefixes disambiguate the
two phones and confirm targeting.

## Signing / deploy

The device build uses the repo's canonical unsigned-build → profile-graft →
explicit-nested-signing → `devicectl install` lane
(`packages/app/scripts/ios-device-deploy.mjs`), with `--skip-appexes` because
only the app's own development profile exists on this machine (per-appex
profiles would each need an Xcode-account/ASC session to mint).

- **Provisioning profile:** `iOS Team Provisioning Profile: ai.elizaos.app`
  (`0b619c06-…`) — `application-identifier 25877RY2EH.ai.elizaos.app`, includes
  MoonCycles UDID in `ProvisionedDevices`, `get-task-allow=true`, unexpired
  (2027-06-22).
- **Signing identity:** `Apple Development: Shaw Walters (UT5K5Q5EVF)` — matched
  to the profile's embedded `developerCertificateSha1s` by the deploy lane's own
  selector (`selectSigningIdentity`). The `--skip-appexes` flag strips
  `PlugIns/*.appex` (widgets / keyboard / website-blocker) before signing, so
  those extension surfaces are absent from this install — main-app lifecycle
  testing only, which is the scope here.

### Fresh-worktree build gaps resolved (build environment, not device)

This branch was built from a fresh git worktree that shares the parent
`eliza/node_modules`. Three environment gaps had to be closed to produce a
device build; none are code changes to the app:

1. `packages/agent/scripts/build-mobile-bundle.mjs` resolves
   `@electric-sql/pglite/dist` via a literal `repoRoot/node_modules` join that
   does not walk up to the shared parent — satisfied by symlinking the
   worktree's `node_modules` to the parent it already resolves against
   (node_modules is gitignored).
2. The mobile web build only runs the heavy `dev:prepare` turbo declaration
   build when `packages/shared/dist/index.js` is absent; once present, Vite
   `build:web` aliases `@elizaos/*` to source and does not need it.
3. `@capacitor/share@^8.0.0` (declared in `packages/app/package.json`, pinned in
   `bun.lock` at 8.0.1, statically imported by `src/main.tsx` →
   `ios-attachment-smoke.ts`) was missing from the shared parent node_modules
   (installed before the dependency was added) — installed targeted.

## What is drivable on real hardware vs simulator-only

The honest delta is captured in `matrix.md`. The XCUITest driver
(`AppUITests/DeviceLifecycleUITests`, committed) delivers the events the
simulator lane must mark N/A — Home-button backgrounding, the real Camera app,
orientation, and true process death — screenshotting the real pixels via
`XCUIScreen` and hard-asserting foreground + live-renderer recovery after each.
The events a physical battery / ringer switch / lock button do not expose to the
public XCUITest API stay honest N/A rows with the precise reason.

## Files

- `matrix.md` — the per-event real-hardware matrix (drivable? → pass/fail/N-A).
- `device-capabilities-wireless.txt` — the CoreDevice capability list captured
  over the wireless tunnel, including the missing `installapp` capability.
- `device-info-mooncycles.json` — device identity and transport metadata for
  the single owner-authorized iPhone targeted by this run.
- `signed-app-verification.txt` — `codesign` inspection and strict verification
  of the signed device app that was prepared for install.

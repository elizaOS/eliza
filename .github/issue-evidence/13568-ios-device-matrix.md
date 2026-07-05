# Issue #13568 - iOS Device Matrix Lane

## Change

- Replaced the hardcoded `ios-device` `n/a` result in
  `packages/app/scripts/walkthrough-device-matrix.mjs` with real
  `devicectl`-based physical-device selection.
- The lane now honors `--ios-device` / `ELIZA_IOS_DEVICE_ID`, preflights the
  staged signed app at `packages/app/ios/build/device-deploy-stage/App.app`,
  and invokes:
  `ios-device-capture.mjs --platform device --device <id> --skip-build --app-path <staged App.app> --output <matrix run>/ios-device`.
- Updated `DEVICE_MATRIX.md` so the iOS physical-device prerequisites, artifact
  path, and skip reasons match the implementation.

## Verification

- PASS: `git fetch origin && git rebase origin/develop`
- PASS: `bun install`
- PASS: `node --check packages/app/scripts/walkthrough-device-matrix.mjs`
- PASS: `node --test packages/app/scripts/walkthrough-device-matrix.test.mjs`
  - 16 tests passed, including iOS physical-device selection and honest
    devicectl-derived `n/a` reasons.
- PASS:
  `bunx @biomejs/biome check packages/app/scripts/walkthrough-device-matrix.mjs packages/app/scripts/walkthrough-device-matrix.test.mjs packages/app/test/ui-smoke/walkthrough/DEVICE_MATRIX.md`
- PASS: `node packages/app/scripts/walkthrough-device-matrix.mjs --platform device --skip-android-drive`
  - Generated `reports/walkthrough/2026-07-05_02-56-58_devices/device-matrix.json`.
  - Manually inspected the report: `ios-device` is now `n/a` because `xcrun
    devicectl list devices` is unavailable on this host, proving the lane
    probes devicectl instead of returning the old canned no-device reason.
  - `android-device` is `n/a` because `adb` is not installed.
- PASS: `git diff --check`
- FAIL (unrelated repo ratchet): `bun run verify`
  - Failed in `audit:type-safety-ratchet` before this branch's package checks
    ran.
  - Reported existing ratchet deltas:
    - `as unknown as`: 74 current > 73 baseline
    - `?? []` in core/agent/app-core: 582 current > 581 baseline

## Not Run

- Real iOS physical-device capture with a connected, provisioned iPhone and
  staged signed app was not run on this host. That requires full devicectl
  device availability plus `packages/app/ios/build/device-deploy-stage/App.app`
  from `install:ios:sideload`.

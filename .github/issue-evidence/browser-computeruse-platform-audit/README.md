# Browser + computer-use platform audit

Date: 2026-06-23

## Scope

This audit tracks the broader platform contract for browser and computer use,
separate from the narrower #8912 per-step-progress fix.

## Platform Contract

| Platform | Browser-use expectation | Computer-use expectation | Current proof |
|---|---|---|---|
| Desktop web/app | `workspace` is always available; bridge/companion can win when explicitly available. | Desktop screenshot, input, windows, terminal, files, browser, and clipboard are capability-gated by OS/tool availability. | `browser-service.test.ts`; `platform-capabilities.test.ts`; Windows real-driver evidence in `.github/issue-evidence/browser-computeruse-hardening/`. |
| Mobile app browser | Internal workspace/browser surface wins automatic routing. Bridge and companion targets opt out on mobile. | Mobile app does not pretend desktop-level control exists. | `browser-service.test.ts`; `stagehand-target.test.ts`; `parity-status.md` guard in `platform-capabilities.test.ts`. |
| iOS | No Chromium/Puppeteer target; use own-app browser/runtime surfaces. Stagehand is off by default and explicit-only if opted in. | Own-app ReplayKit capture, Vision OCR, App Intents, and own-app accessibility snapshot only. Cross-app input/process enumeration is blocked by OS policy. | `ios-bridge.test.ts`; `ios-computer-interface.test.ts`; `IOS_CONSTRAINTS.md`; physical device manifest still required for release proof. |
| Android consumer | Internal/browser routing remains app-owned; external automation requires explicit bridge paths. | MediaProjection capture, AccessibilityService tree/gestures, UsageStats, Camera2, and memory pressure bridge are permission-gated. | `android-bridge.test.ts`; `mobile-screen-capture.test.ts`; `mobile-computer-interface.test.ts`; `ANDROID_CONSTRAINTS.md`; physical device validation still required. |
| Android AOSP/system | Same runtime routing contract, with privileged capabilities separated from consumer build. | Privileged `SurfaceControl` capture and `InputManager.injectInputEvent` are system-build-only; consumer build must not expose them. | `aosp-input-actor.test.ts`; `ANDROID_CONSTRAINTS.md`; system-image validation still required. |

## Evidence Manifests

Platform proof now has machine-checkable manifests:

- `plugins/plugin-computeruse/docs/ios-device-validation.json`
- `plugins/plugin-computeruse/docs/android-device-validation.json`
- `plugins/plugin-computeruse/docs/android-aosp-validation.json`
- `plugins/plugin-computeruse/docs/macos-desktop-validation.json`
- `plugins/plugin-computeruse/docs/linux-desktop-validation.json`
- `plugins/plugin-computeruse/docs/windows-desktop-validation.json`

Run the structural gate with:

```bash
bun run --cwd plugins/plugin-computeruse validate:platform-evidence
```

Run the release gate only after real platform artifacts are recorded:

```bash
bun run --cwd plugins/plugin-computeruse validate:platform-evidence -- --require-complete
```

Current expected release-gate result: fail. Every manifest is still marked
`requires_device_evidence`, so the broad objective is not yet complete.

## Validation Run

Passed on the current worktree:

```bash
bun run --cwd plugins/plugin-browser test \
  src/__tests__/browser-service.test.ts \
  src/targets/stagehand-target.test.ts

bun run --cwd plugins/plugin-computeruse test \
  src/__tests__/platform-capabilities.test.ts \
  src/__tests__/ios-computer-interface.test.ts \
  src/__tests__/mobile-computer-interface.test.ts \
  src/__tests__/android-bridge.test.ts \
  src/__tests__/mobile-screen-capture.test.ts \
  src/__tests__/aosp-input-actor.test.ts \
  src/__tests__/ios-bridge.test.ts

bun run --cwd plugins/plugin-computeruse test \
  src/__tests__/platform-evidence-validator.test.ts

bunx --bun biome check \
  plugins/plugin-browser/src/__tests__/browser-service.test.ts \
  plugins/plugin-browser/src/targets/stagehand-target.test.ts \
  plugins/plugin-computeruse/src/__tests__/platform-capabilities.test.ts \
  plugins/plugin-computeruse/src/mobile/parity-status.md
```

Observed results:

- Browser target routing: 2 files passed, 7 tests passed.
- Computer-use platform/mobile/iOS/Android/AOSP: 7 files passed, 123 tests passed.
- Platform evidence validator: 1 file passed, 4 tests passed. The tests cover
  default manifest validation, release-gate failure while evidence is missing,
  malformed-manifest rejection, and a synthetic complete-manifest success path.
- Targeted Biome check passed.
- Platform evidence manifest validation passed in non-complete mode:
  - iOS device: 10 checks tracked.
  - Android consumer: 10 checks tracked.
  - Android AOSP/system: 8 checks tracked.
  - macOS desktop: 9 checks tracked.
  - Linux desktop: 9 checks tracked.
  - Windows desktop: 9 checks tracked.
- `validate:platform-evidence -- --require-complete` failed as expected because
  physical artifacts and per-check pass/block statuses are still missing.

## Remaining Physical Evidence

The repository now has executable coverage for routing and capability contracts,
plus existing Windows real-driver evidence. The full objective is still not
proven until these live checks are recorded:

- iOS physical device run for ReplayKit foreground capture, broadcast extension
  handshake, Vision OCR, App Intents, own-app accessibility snapshot, Foundation
  Models fallback, and memory pressure probe.
- Android consumer device run for AccessibilityService gestures/tree,
  MediaProjection consent + frame capture, UsageStats, Camera2, memory pressure,
  App Actions/static shortcuts, and LifeOps handoff.
- Android AOSP/system-image run for assistant role, privileged capture/input,
  and consumer-build stripping of privileged services.
- macOS real desktop-control run for Screen Recording/Accessibility gated paths.
- Linux desktop run for dependency probing, display capture, input, window focus,
  browser automation, clipboard, terminal safety, and approval modes.
- Windows desktop run linking or refreshing real-driver hardening proof for
  PowerShell-backed screenshot/input/browser/clipboard/terminal behavior.

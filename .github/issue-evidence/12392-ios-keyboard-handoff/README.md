# Issue #12392 - iOS Keyboard Handoff

Date: 2026-07-04

## Scope

- Added a first-party `ElizaKeyboard` iOS keyboard extension target with:
  - minimal QWERTY rows,
  - a suggestion strip,
  - a `Dictate` entry point,
  - explicit app handoff through `elizaos://keyboard-dictation`.
- Added an app-group handoff contract:
  - keyboard writes `com.elizaos.keyboard.pendingRequest`,
  - containing app bridge can write `com.elizaos.keyboard.completedTranscript`,
  - keyboard polls and inserts the completed transcript.
- Added `ElizaKeyboardBridge` as the containing-app Capacitor bridge for pending-request read and completed-transcript writeback.
- Wired `ElizaKeyboard` into the Xcode project, app extension embed phase, app dependency graph, product list, privacy manifest, and app-group entitlements.
- Updated iOS app identity rewriting so white-label builds rewrite `ElizaKeyboard` bundle ids and app-group entitlements.
- Routed `elizaos://keyboard-dictation?source=ios-keyboard&requestId=...` into the existing chat voice launch path with `keyboardRequestId` preserved.

## Verification

- `plutil -lint packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj packages/app-core/platforms/ios/App/App/ElizaKeyboard/Info.plist packages/app-core/platforms/ios/App/App/ElizaKeyboard/ElizaKeyboard.entitlements packages/app-core/platforms/ios/App/App/ElizaKeyboard/PrivacyInfo.xcprivacy`
  - Result: PASS.
- `swiftc -parse packages/app-core/platforms/ios/App/App/ElizaKeyboard/KeyboardViewController.swift packages/app-core/platforms/ios/App/App/ElizaKeyboardBridge.swift`
  - Result: PASS.
- `bunx vitest run packages/app/src/deep-link-routing.test.ts packages/app-core/scripts/run-mobile-build-ios-identity.test.mjs`
  - Result: PASS, 2 files / 29 tests.
  - Note: executed from a narrow exported tree with a temporary `node_modules` symlink to the already-installed main workspace.

## Not Captured On This Host

- iOS simulator/real-device screenshots, screen recording, enablement walkthrough, and native logs are pending because this host does not have a full Xcode/iOS simulator SDK installed.
- Real-LLM trajectories are N/A for this patch because it changes native keyboard, app-group, Xcode, and deep-link handoff plumbing only; it does not change agent/action/provider/prompt/model behavior.

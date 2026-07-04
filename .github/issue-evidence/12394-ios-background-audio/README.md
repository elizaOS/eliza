# Issue #12394 — iOS Background Audio Plist Guard

Date: 2026-07-04

## Scope

- Kept the latest `develop` WidgetKit quick-action, iOS 18 control, and Live Activity implementation intact.
- Fixed the app `patch-ios-plist.mjs` sync path so an existing `UIBackgroundModes` array is updated to include `audio` instead of being skipped because the key already exists.
- Aligned the checked-in app-core iOS template `Info.plist` so `audio` is present beside `fetch`, `processing`, and `remote-notification`.

## Verification

- `bunx vitest run packages/app/scripts/patch-ios-plist.test.mjs packages/app-core/scripts/run-mobile-build-ios-plist.test.mjs`
  - Result: PASS, 2 files / 11 tests.
  - Note: the clean worktree used a temporary `node_modules` symlink to the already-installed main workspace because this host checkout has no local install.
- `bunx biome check packages/app/scripts/patch-ios-plist.mjs packages/app/scripts/patch-ios-plist.test.mjs packages/app-core/scripts/run-mobile-build-ios-plist.test.mjs`
  - Result: PASS.
- `plutil -lint packages/app-core/platforms/ios/App/App/Info.plist packages/app-core/platforms/ios/App/App/ElizaWidgets/Info.plist packages/app-core/platforms/ios/App/App/ElizaWidgets/ElizaWidgets.entitlements packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj`
  - Result: PASS.
- `swiftc -parse packages/app-core/platforms/ios/App/App/ElizaWidgets/ElizaWidgets.swift packages/app-core/platforms/ios/App/App/ElizaWidgets/ElizaWidgetControls.swift packages/app-core/platforms/ios/App/App/ElizaWidgets/ElizaDictationAttributes.swift packages/app-core/platforms/ios/App/App/ElizaWidgets/ElizaDictationLiveActivity.swift packages/app-core/platforms/ios/App/App/ElizaLiveActivityBridge.swift`
  - Result: PASS.

## Not Captured On This Host

- iOS simulator build, screenshot, screen recording, and native logs are blocked because this machine only has Command Line Tools selected:
  - `xcodebuild -version` fails with `active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance`.
  - `xcrun --sdk iphonesimulator --show-sdk-path` fails because the `iphonesimulator` SDK cannot be located.
- Real-LLM trajectories are N/A for this patch because it only changes native plist/static entrypoint configuration and does not change agent/action/provider/prompt/model behavior.

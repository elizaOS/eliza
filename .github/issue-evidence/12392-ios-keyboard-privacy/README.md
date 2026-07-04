# iOS keyboard privacy manifest evidence

## Scope

Adds the missing `PrivacyInfo.xcprivacy` resource for the `ElizaKeyboard` app extension in PR #12685. The extension uses the App Group `UserDefaults` handoff channel through `ElizaKeyboardDictationState`, so the manifest declares the UserDefaults accessed API reason and no collected data or tracking.

## Verification

- `plutil -lint packages/app-core/platforms/ios/App/App/ElizaKeyboard/PrivacyInfo.xcprivacy packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj` - PASS.
- `swiftc -parse packages/app-core/platforms/ios/App/App/ElizaKeyboard/ElizaKeyboardDictationState.swift packages/app-core/platforms/ios/App/App/ElizaKeyboard/KeyboardViewController.swift packages/app-core/platforms/ios/App/App/ElizaKeyboardBridge.swift` - PASS.

## Evidence matrix

- Live model trajectories: N/A - no model, prompt, provider, action, or evaluator behavior changed.
- Screenshots/video: BLOCKED - this host has Command Line Tools only; no full Xcode/iOS simulator SDK is installed.
- Native/iOS device logs: BLOCKED - no iOS simulator/device runtime is available on this host.

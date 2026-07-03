## iOS device build — full-Bun engine compiled; failed ONLY at code-signing

Command: ELIZA_IOS_DEVELOPMENT_TEAM=UT5K5Q5EVF ELIZA_IOS_CODE_SIGNING_ALLOWED=YES ELIZA_IOS_ALLOW_PROVISIONING_UPDATES=1 bun run --cwd packages/app build:ios:local:device:full-bun

### Engine + renderer built OK (the inference path is intact):
warning: Run script build phase '[CP] Copy XCFrameworks' will be run during every build because it does not specify any outputs. To address this issue, either add output dependencies to the script phase, or configure it to run in every build by unchecking "Based on dependency analysis" in the script phase. (in target 'OSBarcodeLib' from project 'Pods')
warning: Run script build phase '[CP] Copy XCFrameworks' will be run during every build because it does not specify any outputs. To address this issue, either add output dependencies to the script phase, or configure it to run in every build by unchecking "Based on dependency analysis" in the script phase. (in target 'LlamaCppCapacitor' from project 'Pods')
warning: Run script build phase '[CP] Copy XCFrameworks' will be run during every build because it does not specify any outputs. To address this issue, either add output dependencies to the script phase, or configure it to run in every build by unchecking "Based on dependency analysis" in the script phase. (in target 'ElizaBunEngine' from project 'Pods')
warning: Run script build phase '[CP] Copy XCFrameworks' will be run during every build because it does not specify any outputs. To address this issue, either add output dependencies to the script phase, or configure it to run in every build by unchecking "Based on dependency analysis" in the script phase. (in target 'LlamaCpp' from project 'Pods')

### Failure — code-signing only (xcodebuild exit 65):
** BUILD FAILED **
Error: xcodebuild exited with code 65
apps/app/ios/App/App.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'App' from project 'App')
apps/app/ios/App/App.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'DeviceActivityMonitorExtension' from project 'App')
apps/app/ios/App/App.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'DeviceActivityReportExtension' from project 'App')
apps/app/ios/App/App.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'WebsiteBlockerContentExtension' from project 'App')
apps/app/ios/App/App.xcodeproj: error: No profiles for 'ai.elizaos.app' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'ai.elizaos.app'. (in target 'App' from project 'App')
apps/app/ios/App/App.xcodeproj: error: No profiles for 'ai.elizaos.app.DeviceActivityMonitorExtension' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'ai.elizaos.app.DeviceActivityMonitorExtension'. (in target 'DeviceActivityMonitorExtension' from project 'App')
apps/app/ios/App/App.xcodeproj: error: No profiles for 'ai.elizaos.app.DeviceActivityReportExtension' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'ai.elizaos.app.DeviceActivityReportExtension'. (in target 'DeviceActivityReportExtension' from project 'App')
apps/app/ios/App/App.xcodeproj: error: No profiles for 'ai.elizaos.app.WebsiteBlockerContentExtension' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'ai.elizaos.app.WebsiteBlockerContentExtension'. (in target 'WebsiteBlockerContentExtension' from project 'App')
apps/app/ios/App/Pods/Pods.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'Capacitor-Capacitor' from project 'Pods')
apps/app/ios/App/Pods/Pods.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'CapacitorCordova-CapacitorCordova' from project 'Pods')

# Launch Readiness 22: Store Review Notes

## Permissions Kept For Full-Capability Review

This launch posture keeps the full-capability mobile surface declared so store review sees the same build users will receive. Android declarations include camera, microphone, fine/background location, notifications, foreground services, contacts, phone/call-log, SMS/MMS, usage access, app-op management, home/assistant/browser/default-app intents, and the special-use foreground service for the local agent runtime. iOS declarations keep camera, microphone, local network, location, push, HealthKit, Family Controls, app groups, WebsiteBlocker extension, and required privacy manifest placeholders visible for review.

Reviewer note: permissions are requested in context from the feature that needs them. The app should not ask for contacts, phone, SMS, camera, microphone, location, HealthKit, Family Controls, local network, or notifications on first launch unless the user enters the related workflow.

## Core Feature Use

- Camera, microphone, and location support multimodal assistant input, location-aware automations, and user-triggered context capture.
- Contacts, phone, call-log, SMS/MMS, default dialer/SMS/browser/home roles, usage access, and app-op management support the full LifeOps / AOSP assistant strategy where the user explicitly chooses Eliza as the device assistant or privileged system app.
- Foreground service declarations keep the local agent and gateway connection visible while they are running.
- Local network, app groups, Family Controls, WebsiteBlocker, push, and HealthKit support remote pairing, shared extension state, website blocking, notifications, and user-enabled health/life automation.

## local-safe And local-yolo

`local-safe` is the default review posture for local execution. It keeps local agent requests authenticated, keeps browser/runtime sandboxing intact, prompts before sensitive local actions, and routes mobile local-agent traffic through the native token bridge.

`local-yolo` is a power-user posture for explicit opt-in builds or settings where the user accepts broader local automation. Store notes should describe it as user-controlled, reversible, and not the default. It must not disable Chromium sandboxing for store runtime paths.

## Mobile Limitations

- iOS is primarily a cloud, cloud-hybrid, and remote shell today; the native iOS local-agent plugin is still a stub, so full local execution claims need device proof before App Store submission.
- Android local mode runs the packaged local agent on loopback with `ELIZA_REQUIRE_LOCAL_AUTH=1` and a per-boot bearer token supplied by the Capacitor Agent plugin.
- Cloud-hybrid and local mobile inference still need physical-device performance, battery, thermal, background, and reconnect validation before being positioned as generally available.
- Store reviewers should be told that default phone/SMS/home/browser roles are optional and are only relevant when the user enables device-assistant or full-capability Android/AOSP workflows.

## Android Store Notes

Use the review notes to explain why high-risk permissions remain in the manifest: Eliza is submitted as a full-capability assistant that can become the user-selected home, assistant, browser, dialer/SMS helper, website blocker, and local runtime. The notes should map every sensitive permission group to a visible user feature and state that unsupported or unselected workflows remain dormant.

Before upload, attach device QA evidence for runtime permission prompts, foreground-service notifications, local-agent auth, role selection, SMS/phone workflows if enabled, background behavior, and data safety disclosures.

## iOS App Review Notes

Use the review notes to explain Local Network, microphone, camera, location, push, HealthKit, Family Controls, WebsiteBlocker, and app-group usage. Keep the privacy manifest and entitlement placeholders complete even when a capability is pending approval, then update the exact App Store Connect privacy answers after device QA.

Before TestFlight or App Store review, attach proof for cloud login, remote Mac pairing, notification behavior, WebsiteBlocker extension behavior, HealthKit/Fitness permission flows if shipped, Family Controls approval status, and the current limitation that iOS does not ship the same full local-agent runtime as Android.

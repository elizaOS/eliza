# Android Google Play capability inventory

This inventory describes the `android-cloud` release for package
`ai.elizaos.app`. The AAB audit is authoritative for what ships; the committed
manifest and build-strip tests are regression guards for future builds.

## Standard consumer capabilities

- Cloud chat over TLS using ordinary `INTERNET` and `ACCESS_NETWORK_STATE`.
- User-invoked voice capture using `RECORD_AUDIO`, requested at runtime, plus
  `MODIFY_AUDIO_SETTINGS` for Android audio routing and echo cancellation.
- Audio playback through ordinary platform media APIs with no background
  foreground service.
- Secure app-private persistence. Android backup is disabled.
- Text sharing through `ACTION_SEND` and `ACTION_PROCESS_TEXT`.
- The `elizaos://` custom deep link and Android launcher entry point.
- Narrow package visibility queries for the system speech-recognition service
  and Custom Tabs service. No package names and no broad app inventory access.
- A non-exported `FileProvider` for scoped content sharing.

The release targets API 36, does not allow cleartext traffic, and is not
debuggable. `RECORD_AUDIO` is the only runtime permission in the audited base
module.

## Play account model

The consumer UI says **Sign in**, but its phone, email magic-link, OAuth, and
wallet/SIWE paths can provision a new Eliza Cloud user and agent. For Google
Play policy this is an **account-creating app**, not a sign-in-only app.

Production submission therefore requires both of these working paths, bound to
the same authenticated account lifecycle:

- a readily discoverable in-app request to delete the account and associated
  data; and
- an external web resource where a user can request account deletion, entered
  in Play Console's designated account-deletion URL field.

A disabled or placeholder deletion control does not satisfy this contract. The
release remains blocked until the Cloud/Steward lifecycle completes deletion,
session revocation, required provider/resource cleanup, and an identifier-free
receipt without deleting another user's or a shared organization's data.

## Components in the audited release AAB

- Activities: `MainActivity`, `ElizaShareActivity`, and Capacitor's browser
  controller activity.
- Providers: the non-exported AndroidX `FileProvider` and AndroidX startup
  provider.
- Receiver: AndroidX profile installation receiver.
- No application-defined services.

## Explicitly absent from the Play release

The build and artifact audits fail if these return:

- Accessibility services, gesture injection, screen capture, MediaProjection,
  notification-listener access, device admin, or device/profile-owner flows.
- Default Assistant, Browser, Dialer, SMS, Home/launcher, or IME role requests.
- SMS, MMS, contacts, call log, phone, camera, location, Bluetooth, nearby
  devices, notifications, Health Connect, usage access, overlay, VPN, exact
  alarm, boot-completed, package installation, or broad package visibility.
- Foreground or background services, reboot autostart, background microphone,
  local-agent/runtime assets, model files, Bun binaries, inference libraries,
  privileged/AOSP permissions, and platform-signature APIs.
- Cleartext HTTP, local Mac routing, adb reverse assumptions, development
  endpoints, embedded provider credentials, or production signing material.

## Policy basis

- [Google Play target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [User data and account deletion policy](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Account deletion implementation guidance](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Permissions and APIs that access sensitive information](https://support.google.com/googleplay/android-developer/answer/16558241)
- [SMS and Call Log permission policy](https://support.google.com/googleplay/android-developer/answer/10208820)
- [Broad package visibility policy](https://support.google.com/googleplay/android-developer/answer/10158779)
- [Foreground service declaration requirements](https://support.google.com/googleplay/android-developer/answer/13392821)

## Release verification

For every release candidate:

1. Run the Android Play policy and account-deletion regression tests.
2. Build `build:android:cloud:debug` and `build:android:cloud` from a clean head.
3. Require the pre-Gradle, post-Gradle, APK, AAB manifest, and DEX audits to pass.
4. Run Gradle unit tests and `lintRelease` with `-PelizaCloudBuild=true`.
5. Record the exact commit, APK/AAB sizes and SHA-256 hashes, signing state, and
   merged-manifest inventory in the release evidence.
6. Install the matching debug APK after clearing app data, then verify launch,
   runtime microphone consent, sharing, deep links, account deletion, chat,
   voice, persistence, background/restore, and crash-free logs.

An unsigned local AAB proves build and package contents only. Play App Signing,
Play Console declarations, staged backend deletion, real-account flows, and
physical-device voice remain separate release gates.

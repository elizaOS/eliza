# Eliza App installer and release pipeline spec

Status: proposed
Owner: Eliza App release engineering
Scope: `packages/app` release packaging and distribution only

## Goals

- Prefer first-party store distribution for mobile: TestFlight and App Store
  for iOS, Play internal or closed testing and Play Store for Android.
- Keep developer sideloading as a constrained helper for contributors and
  internal QA, not as the public iOS installer path.
- Publish desktop artifacts on GitHub Releases with repeatable signing,
  notarization, checksums, and release notes.
- Make failed signing, profile expiry, missing devices, and store credential
  gaps fail early with actionable diagnostics.

## Non-goals

- No implementation changes are specified here.
- No new task primitive, runtime installer, update daemon, or mobile app
  behavior is introduced by this spec.
- No public iOS `.ipa` download flow. Public iOS distribution must use
  TestFlight or the App Store.
- No bypass of Apple review, App Store Connect, provisioning limits, or
  device trust requirements.

## Current release surface

- `packages/app/package.json` exposes mobile build and sync commands:
  `build:ios`, `build:ios:local`, `build:ios:local:device`,
  `build:android`, `build:android:cloud`, `cap:sync:ios`, and
  `cap:sync:android`.
- The iOS native project lives under `packages/app/ios/App` and has Fastlane
  lanes in `packages/app/ios/fastlane/Fastfile` for certificates, App Store
  build, TestFlight upload, App Store release, and metadata upload.
- The Android native project lives under `packages/app/android` and has
  Fastlane lanes in `packages/app/android/fastlane/Fastfile` for signed AAB
  builds and Play Store track promotion.
- GitHub workflows already separate mobile smoke builds, Apple store release,
  Android release, package publishing, and desktop release concerns.

## Distribution model

### iOS

The supported iOS installer paths are, in priority order:

1. TestFlight for internal and external beta testers.
2. App Store for public stable releases.
3. Developer sideload helper for contributors and internal QA with registered
   devices or local Apple development signing.

The release pipeline must produce App Store signed `.ipa` artifacts only for
App Store Connect upload. It must not attach public installable `.ipa` files to
GitHub Releases unless the release is explicitly marked as internal and access
controlled outside the public release page.

### Android

The supported Android installer paths are:

1. Play internal testing for release candidates.
2. Play closed testing or production for public staged rollout.
3. GitHub Release APK for developer and QA install when signed with the
   project release key or clearly labeled as debug.
4. Play Store AAB as the canonical public artifact.

The release pipeline may attach `.apk` files to GitHub Releases for QA and
developer convenience. The public Play Store artifact remains the `.aab`.

### Desktop

Desktop artifacts are distributed through GitHub Releases:

- macOS Apple Silicon `.dmg`
- macOS Intel `.dmg`
- Windows `.exe` installer
- Linux `.AppImage`
- Linux `.deb`
- Optional Linux Flatpak artifact when produced by release packaging

macOS desktop artifacts must be signed and notarized before public release.
Windows artifacts must be Authenticode signed when certificate material is
available. Linux artifacts must include checksums and package metadata.

## iOS pipeline

### Preflight checks

The iOS release job must fail before build when any required release input is
missing:

- `APPLE_ID`
- `APPLE_TEAM_ID`
- `ITC_TEAM_ID`
- `APP_STORE_APP_ID`
- `APP_IDENTIFIER`
- `MATCH_GIT_URL`
- `MATCH_PASSWORD`
- App Store Connect API key or an equivalent authenticated Fastlane session
- Profiles for the app bundle and extension bundle identifiers listed in
  `APP_IDENTIFIER_EXTRA`

The job must report which input is missing and whether the failure blocks
TestFlight, App Store release, or both.

### Xcode and project checks

Before building, CI must verify:

- The runner has the pinned Xcode version or an allowed newer version.
- `xcodebuild -showsdks` includes an iPhoneOS SDK compatible with the release.
- `packages/app/ios/App/App.xcworkspace` exists.
- The `App` scheme is shared and buildable.
- `packages/app/ios/App/ExportOptions.plist` exists when the pipeline expects
  explicit export options.
- `packages/app/ios/App/App/PrivacyInfo.xcprivacy` exists.
- The app target and extension targets use expected bundle identifiers.
- The deployment target is within the range accepted by App Store Connect.
- `cap:sync:ios` and the iOS overlay step have run before native build.

Recommended diagnostic commands:

```bash
xcodebuild -version
xcodebuild -showsdks
xcodebuild -workspace packages/app/ios/App/App.xcworkspace -list
```

### Signing and provisioning

The preferred signing flow is Fastlane `match` with App Store profiles:

- `packages/app/ios/fastlane/Fastfile` lane `certs` syncs App Store
  certificates and profiles.
- `APP_IDENTIFIER_EXTRA` must include every extension bundle identifier.
- CI must use readonly match mode.
- Local release maintainers may refresh profiles outside CI, but CI must never
  mutate signing state unexpectedly.

The build must fail when:

- A required provisioning profile is missing.
- A profile expires within the release warning window.
- The certificate expires within the release warning window.
- A target is signed with a development profile for a TestFlight or App Store
  upload.
- Entitlements in the profile do not satisfy target entitlements.

Default warning windows:

- 30 days before provisioning profile expiry.
- 30 days before distribution certificate expiry.
- 14 days before Apple Developer Program membership renewal date when it is
  available to the release operator.

### TestFlight

The preferred beta path is:

1. Build web and Capacitor assets.
2. Sync iOS native project.
3. Run Xcode, signing, entitlement, and profile checks.
4. Build an App Store signed `.ipa`.
5. Upload to TestFlight.
6. Attach the `.ipa` as a private workflow artifact for traceability.
7. Publish build number, version, bundle id, commit SHA, and App Store Connect
   processing status in the job summary.

TestFlight upload must not silently downgrade to local artifact only. If
`APP_STORE_APP_ID` or upload credentials are absent, the job must either fail or
be explicitly run in a build-only mode.

### App Store release

The stable iOS release path is:

1. Confirm the release tag, version, and build number.
2. Confirm TestFlight build has passed smoke validation.
3. Upload or reuse App Store metadata and screenshots.
4. Submit for review with export compliance answers recorded in CI summary.
5. Use manual release after approval unless the release manager explicitly
   chooses automatic release.

The App Store release job must publish a summary containing:

- Version and build number.
- App Store Connect app id.
- Bundle id and extension bundle ids.
- Export compliance settings.
- Whether release is manual or automatic after approval.
- Links or identifiers for workflow artifacts.

## Developer sideload helper constraints

iOS sideloading exists for local development and controlled QA only. The helper
may automate checks and open Xcode, but it must not present itself as a public
installer.

Allowed capabilities:

- Detect connected iOS devices through `xcrun xctrace list devices`,
  `xcrun devicectl list devices`, or equivalent Xcode tooling.
- Detect simulators and route simulator builds to `build:ios:local:sim`.
- Route physical device builds to `build:ios:local:device`.
- Confirm the user has accepted the Xcode license.
- Confirm the selected device is paired, unlocked, and in Developer Mode.
- Print instructions to trust the developer certificate on the device.
- Warn when a free development profile may expire after roughly 7 days.
- Warn when paid development profiles may expire after roughly 1 year.
- Open `packages/app/ios/App/App.xcworkspace` for manual run and signing fixes.

Required warnings:

- Public iOS installs must use TestFlight or App Store.
- Development signing may require registering the device UDID.
- The device may need Settings > General > VPN & Device Management trust
  approval after first install.
- Builds installed with development profiles can stop launching when the
  profile expires.
- Enterprise or ad hoc distribution must not be used for public release.

Required failure cases:

- No Xcode command line tools are selected.
- No compatible SDK is installed.
- No connected physical device is detected for a physical device build.
- A selected device is unavailable, locked, unpaired, or not in Developer Mode.
- Signing cannot find a valid development team.
- The app bundle identifier conflicts with an installed app signed by another
  team.

The helper may never:

- Ask users to disable iOS security protections.
- Instruct public users to install untrusted profiles.
- Generate or publish public `.ipa` links.
- Re-sign App Store builds with development credentials.

## Android pipeline

### Preflight checks

Android release jobs must verify:

- Java and Android SDK versions match the Gradle project expectations.
- `ANDROID_HOME` or `ANDROID_SDK_ROOT` is set.
- Required SDK platforms and build tools are installed.
- `packages/app/android/gradlew` is executable.
- `cap:sync:android` and Android overlay steps have run before Gradle release
  build.
- Release signing inputs exist when producing release APK or AAB artifacts:
  `ELIZAOS_KEYSTORE_PATH`, `ELIZAOS_KEYSTORE_PASSWORD`,
  `ELIZAOS_KEY_ALIAS`, and `ELIZAOS_KEY_PASSWORD`.
- `PLAY_STORE_SERVICE_ACCOUNT_JSON` exists for Play upload.

### APK and AAB artifacts

The release pipeline should produce:

- Debug APK for smoke testing on pull requests and manual workflow runs.
- Signed release APK for direct QA install when requested.
- Signed release AAB for Play Store upload.

GitHub Release attachment rules:

- Attach signed release APK only when it is clearly named with version and
  architecture or universal scope.
- Attach signed release AAB for traceability when release policy allows.
- Never attach an unsigned release APK without an explicit `unsigned` label.
- Attach checksums for every Android binary artifact.

### Play Store

The preferred Play Store flow is:

1. Build signed AAB.
2. Upload to internal testing.
3. Promote internal to closed beta after QA approval.
4. Promote closed beta to production with staged rollout.

Promotion jobs must require an existing uploaded AAB and must not rebuild from
a different commit. The job summary must show package name, versionName,
versionCode, source tag, target track, rollout percentage, and whether
changelogs were uploaded.

## Desktop release pipeline

Desktop release preparation must verify:

- Version in package metadata matches the release tag.
- macOS Apple Silicon and Intel artifacts were built on the correct
  architectures or with the documented Rosetta path.
- macOS artifacts are signed, notarized, and stapled.
- Windows installer is signed when signing credentials are configured.
- Linux `.AppImage`, `.deb`, and optional Flatpak artifacts are generated with
  expected metadata.
- Native runtime dependencies and plugin package closure are copied into the
  packaged app by the release packaging scripts.
- Every desktop artifact has a checksum.

GitHub Release desktop assets should use stable names:

- `Eliza-<version>-macos-arm64.dmg`
- `Eliza-<version>-macos-x64.dmg`
- `Eliza-<version>-windows-x64.exe`
- `Eliza-<version>-linux-x64.AppImage`
- `Eliza-<version>-linux-x64.deb`
- `Eliza-<version>-linux-x64.flatpak`
- `Eliza-<version>-checksums.txt`

## GitHub Release preparation

Before publishing a release:

1. Confirm the tag maps to the intended commit.
2. Confirm package version, mobile versionName, Android versionCode, iOS
   marketing version, and iOS build number are coherent.
3. Confirm required CI jobs passed for the target release channel.
4. Confirm TestFlight or Play internal testing has a build from the same commit
   for mobile releases.
5. Confirm desktop artifacts are signed and checksummed.
6. Generate release notes with install sections for desktop, Android, and iOS.
7. Mark prereleases clearly for beta, RC, and internal test channels.
8. Attach only artifacts approved for public distribution.

Release notes must include:

- Version and commit SHA.
- Supported install channels.
- Mobile store status: TestFlight, App Store, Play internal, Play closed beta,
  or Play production.
- Desktop artifact list and checksums.
- Known upgrade, signing, trust, or profile expiry warnings.
- Rollback instructions or previous stable release link.

## Device detection requirements

Installer or helper UX must distinguish:

- iOS simulator.
- iOS physical device.
- Android emulator.
- Android physical device.
- Desktop platform and architecture.

For mobile devices, diagnostics should include:

- Device name when available.
- OS version.
- Architecture.
- Connection state.
- Whether the device is eligible for the selected build path.
- The next command or manual step required when it is not eligible.

## Acceptance criteria

- A release manager can identify the supported installer path for each platform
  without reading CI implementation.
- iOS public distribution is clearly TestFlight or App Store only.
- Developer sideloading constraints and warnings are explicit.
- Xcode, signing, provisioning, device detection, and profile expiry checks are
  specified.
- Android APK, AAB, and Play Store responsibilities are separated.
- Desktop GitHub Release artifact requirements are specified.
- GitHub Release preparation gates and release note contents are specified.

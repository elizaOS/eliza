# @elizaos/capacitor-system

A Capacitor plugin that bridges Android system-role status and device-settings control
into the elizaOS mobile runtime.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-system build  # build
bun run --cwd plugins/plugin-native-system test   # tests
```

## Android device verification

From the repository root, run `node packages/app/scripts/android-native-plugins.ts --serial <emulator> --plugin plugin-native-system --system-controls` on an isolated stock emulator without the user app. This verifies real brightness and music-volume changes, clamping, permission denial/revocation, and restoration against Android settings and AudioManager. A second instrumentation process verifies recovery of persisted original settings after the first process exits with changes outstanding. Reports include bridge receipts and native observations. Home/SMS/assistant role flows and physical-device behavior require separate coverage.

The installed-app hosted lane (`ELIZA_ANDROID_BACKEND=host node
packages/app/scripts/android-e2e.ts --serial <emulator> --build --skip-local-chat
--host-emulator-probes --start-host-agent --no-emulator-boot`) checks all five
settings intents against actual Android screens, including an existing Wi-Fi task
covered by Sound settings. It also verifies invalid roles, dialer-picker cancellation,
grant and already-held results, restores the original phone app, and reattaches to
the app after permission revocation. The role tests use a separate session. This lane
requires an isolated stock emulator and exports native screenshots and observations.

The baseline native-plugin runner also verifies flashlight input rejection before
permissions, actual camera permission denial/grant, and torch on/off against
CameraManager callbacks when the emulator exposes flash hardware. It exports
native dialog screenshots, capabilities and receipts, then restores the torch and
removes the test package. A device without flash must reject explicitly; emulator
callbacks do not certify physical light output.

The native-only `setup.DeviceSetup` helper reports installed/default browser and
Autofill-provider packages and opens host-approved settings/app destinations.
Hosts supply supported package sets, their selected browser/certificate trust
verifier, and an Activity launch callback. The helper snapshots package policy,
rejects unlisted app destinations and uses separate Android tasks. It never reads
credentials, proves vault readiness or changes defaults silently. It adds no
`ElizaSystem` bridge methods or permission grants. `DeviceSetupInstrumentedTest`
checks independent host policy against Android observations while capturing
navigation instead of launching screens or changing roles. Real settings/provider
journeys and physical-device behavior require separate acceptance.

Android hosts can use `SystemLauncherApps.list(context)` and
`SystemLauncherApps.launchIntent(context, packageName)` for launcher discovery
and intent resolution. Declare an `ACTION_MAIN`/`CATEGORY_LAUNCHER` package
visibility query in the host manifest. Discovery excludes the host, disabled
apps and unexported activities, and deduplicates packages. Intent resolution does
not launch an activity; the host retains its user-intent and foreground policy.

`SystemAppIntents` resolves the dialer and default messaging destinations and
opens a gallery through a host-supplied launch callback. Only a missing gallery
triggers the image-viewer fallback; permission denial never triggers another
gallery destination. Results describe dispatch or failure, not user completion.
Hosts retain foreground/user-intent policy and presentation. Instrumentation tests
capture dispatch without opening apps, placing calls or sending messages.

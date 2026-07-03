# Real-device evidence — Shaw's iPhone (iPhone 15 Pro, iOS 26.5)

The elizaOS app built from `develop` (with the merged #10699 transcription button
and the #10700 send/new-chat routing fix) on the **physical device**:

1. **Detected + paired** — `xcrun devicectl list devices`:
   `Shaw's iPhone … available (paired) … iPhone 15 Pro (iPhone16,1)`
2. **Builds for the device** — `build:ios:local` (device destination) → `** BUILD SUCCEEDED **`,
   `…/Build/Products/Debug-iphoneos/App.app`.
3. **Installed on the device** — `xcrun devicectl device install app …` → `INSTALL OK`.
4. **Launched on the device** — during an unlock window the auto-launch monitor reported
   `LAUNCHED on device` (`devicectl device process launch ai.elizaos.app`). When the phone
   is locked the same call is denied: *"Unable to launch ai.elizaos.app because the device
   was not, or could not be, unlocked."*

## Why there is no automated device screenshot
This iPhone connects over the **CoreDevice** transport (iOS 17+), which the CLI screenshot
tools do not support: `idb` enumerates only simulators (`Could not connect … no matching
target`), `libimobiledevice`/`idevicescreenshot` do not see it (`No device found with udid …`;
`idevice_id -l` empty), and `xcrun devicectl` has no screenshot subcommand. A pixel capture
therefore requires an on-device action — **side button + volume-up**, or
**Xcode ▸ Window ▸ Devices and Simulators ▸ Take Screenshot** while the app is foregrounded.

The auto-launch-on-unlock monitor stays armed, so the app re-foregrounds whenever the phone
is unlocked; capture the screenshot on-device at that moment.

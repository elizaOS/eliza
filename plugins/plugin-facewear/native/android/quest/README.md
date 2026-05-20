# Eliza Facewear — Meta Quest 3 APK

Trusted Web Activity (TWA) wrapping the Eliza Facewear PWA for Meta Quest 3 (Horizon OS).

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Java JDK | 17 | `brew install openjdk@17` / [Adoptium](https://adoptium.net/) |
| Android SDK | Build-tools 35 | Android Studio or `sdkmanager` |
| Bubblewrap CLI | ≥ 1.22.0 | `npm i -g @bubblewrap/cli` |
| ADB | any | bundled with Android SDK platform-tools |
| Meta Quest developer mode | on | [Meta developer portal](https://developer.oculus.com/) |

Android SDK environment variables must be set:
```bash
export ANDROID_HOME=$HOME/Library/Android/sdk       # macOS
export ANDROID_HOME=$HOME/Android/Sdk               # Linux
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools/bin:$PATH"
```

## First-Time Setup

```bash
# 1. Install Bubblewrap CLI globally
npm install -g @bubblewrap/cli

# 2. Install Node dependencies
npm install

# 3. Initialise Bubblewrap (only needed once — downloads Gradle/JDK wrappers)
bubblewrap doctor
```

If `bubblewrap doctor` reports missing components, run:
```bash
bubblewrap updateConfig --jdkPath /usr/local/opt/openjdk@17
```

## Building the APK

```bash
npm run build
# Output: app-release-unsigned.apk  (debug keystore for dev builds)
```

For a **release** build, first create a signing keystore:
```bash
keytool -genkey -v -keystore eliza-facewear-quest.keystore \
  -alias facewear -keyalg RSA -keysize 2048 -validity 10000
# Then run:
bubblewrap build --skipPwaValidation
```

## Installing on Quest 3

1. Enable **Developer Mode** on the headset:
   - Open Meta Quest mobile app → headset menu → Developer Mode → On
2. Connect Quest 3 via USB-C
3. Accept the "Allow USB debugging" prompt inside the headset
4. Install the APK:
   ```bash
   npm run install-device
   # or manually:
   adb install -r app-release-unsigned.apk
   ```
5. Launch from Unknown Sources in the Quest app library

## Digital Asset Links

For the TWA to verify ownership of `facewear.elizaos.app`, a Digital Asset Links file
must be served at:
```
https://facewear.elizaos.app/.well-known/assetlinks.json
```

Generate the correct fingerprint:
```bash
keytool -printcert -jarfile app-release-signed.apk | grep SHA256
```

Then add to `assetlinks.json`:
```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.elizaos.facewear.quest",
    "sha256_cert_fingerprints": ["<YOUR_SHA256_HERE>"]
  }
}]
```

## Meta Quest-Specific Features

The `bubblewrap.json` sets `isMetaQuest: true` and `features.metaQuest: true`, which:
- Enables the Horizon OS browser engine (Chromium-based, WebXR enabled)
- Grants access to hand-tracking and controller input via WebXR APIs
- Shows the app under the headset's Unknown Sources panel

For OpenXR native integration (beyond the TWA), see the XREAL native project as a
reference for the Camera2/GLES2 bridge pattern, then adapt for Meta's OpenXR loader.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ADB not found` | Add `$ANDROID_HOME/platform-tools` to PATH |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | `adb uninstall com.elizaos.facewear.quest` first |
| TWA shows browser bar (not full-screen) | Digital Asset Links file missing or SHA256 mismatch |
| Black screen on Quest | The PWA must be served over HTTPS; check `manifest.json` is reachable |
| `bubblewrap build` fails on Gradle | Run `bubblewrap doctor` and accept the JDK/Gradle setup prompts |

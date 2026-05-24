# Meta Quest 3 — Bubblewrap TWA Build

## Prerequisites
- Node.js 18+
- Android SDK (set ANDROID_HOME)
- Java 17+ (set JAVA_HOME)
- Bubblewrap CLI: `npm install -g @bubblewrap/cli`

## Build
```
cd native/android/quest
npm install
npm run build
```
The APK will be at `app-release-signed.apk`.

## Hardware Connection
1. Enable Developer Mode on Quest: Settings → Developer → USB Debugging
2. Install APK: `adb install app-release-signed.apk`
3. Launch the app and point it to your Eliza agent's XR WebSocket endpoint

## Full Setup

### Android SDK Environment Variables

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk       # macOS
export ANDROID_HOME=$HOME/Android/Sdk               # Linux
export JAVA_HOME=$(/usr/libexec/java_home -v 17)    # macOS
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools/bin:$PATH"
```

### First-Time Setup

```bash
# Install Bubblewrap CLI globally
npm install -g @bubblewrap/cli

# Install Node dependencies
npm install

# Initialise Bubblewrap (downloads Gradle/JDK wrappers)
npm run init

# Run doctor to verify setup
npx @bubblewrap/cli doctor
```

If `doctor` reports missing components, run:
```bash
npx @bubblewrap/cli updateConfig --jdkPath /usr/local/opt/openjdk@17
```

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
    "package_name": "com.eliza.xr.quest",
    "sha256_cert_fingerprints": ["<YOUR_SHA256_HERE>"]
  }
}]
```

## Meta Quest-Specific Features

The `bubblewrap.json` sets `isMetaQuest: true` and `features.metaQuest: true`, which:
- Enables the Horizon OS browser engine (Chromium-based, WebXR enabled)
- Grants access to hand-tracking and controller input via WebXR APIs
- Shows the app under the headset's Unknown Sources panel

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ADB not found` | Add `$ANDROID_HOME/platform-tools` to PATH |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | `adb uninstall com.eliza.xr.quest` first |
| TWA shows browser bar (not full-screen) | Digital Asset Links file missing or SHA256 mismatch |
| Black screen on Quest | The PWA must be served over HTTPS; check `manifest.json` is reachable |
| `bubblewrap build` fails on Gradle | Run `npx @bubblewrap/cli doctor` and accept the JDK/Gradle setup prompts |

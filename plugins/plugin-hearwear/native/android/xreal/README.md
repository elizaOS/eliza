# Eliza Facewear — XReal Native Android App

Android Studio project for XReal Air / Air 2 / Air 2 Pro / Air 2 Ultra glasses.

Architecture: WebView-based activity loads the Eliza Facewear PWA. A Camera2 bridge
captures frames from the world camera and sends them to the elizaOS agent over WebSocket
using the binary frame protocol from `plugin-hearwear/src/protocol.ts`.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Android Studio | Hedgehog 2023.1+ | [developer.android.com](https://developer.android.com/studio) |
| JDK | 17 | `brew install openjdk@17` |
| Android SDK | API 35 | Install via SDK Manager |
| XREAL SDK | 3.0.0 | See below |
| ADB | any | bundled with Android SDK |

## Build
```
cd native/android/xreal
chmod +x gradlew
./gradlew assembleDebug
```
APK at: `app/build/outputs/apk/debug/app-debug.apk`

## Hardware Connection
1. Enable Developer Mode on XReal glasses
2. Connect glasses via USB-C
3. Install APK: `adb install app/build/outputs/apk/debug/app-debug.apk`

## Installing XREAL SDK 3.0.0

1. Register at [developer.xreal.com](https://developer.xreal.com/) (free account)
2. Download **NRSDK for Android v3.0.0** from the downloads page
3. Extract the zip — locate `nrsdk-release-3.0.0.aar`
4. Copy it to `app/libs/nrsdk-release-3.0.0.aar`
5. In `app/build.gradle.kts`, uncomment the `fileTree` dependency line

Without the AAR the app still builds and runs — `XrealBridgeJs.isXrealSdkAvailable()`
returns `false` and the PWA falls back to standard WebXR APIs.

## Replacing Camera2 with NRCameraRig

Once XREAL SDK is integrated, replace the Camera2 path in `CameraService.kt`:

```kotlin
// Remove CameraManager/CameraDevice setup.
// Replace with:
import com.nreal.magic.sdk.NRManager
import com.nreal.magic.sdk.NRRgbCamera

NRManager.Init(context, null)
val rgb = NRRgbCamera.getInstance()
rgb.setCallback { frame ->
    val jpegBytes = frame.encodeToJpeg()
    dispatchFrame(jpegBytes, System.currentTimeMillis())
}
rgb.startCapture()
```

For spatial anchor and IMU data, call `NRKernalClient.getInstance()` and register
an `NRTrackingListener` — forward pose data in the `XRFrameHeader.pose` field.

## Installing on Device

```bash
# Enable Developer Mode on your Android phone (that drives the XReal glasses)
# Connect via USB-C and accept debugging prompt

adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Set the agent URL by passing an Intent extra before launch:
```bash
adb shell am start \
  -n com.elizaos.facewear.xreal/.MainActivity \
  --es AGENT_URL "http://192.168.1.100:31337/xr"
```

Or edit the default in `MainActivity.kt` → `agentUrl()`.

## Project Structure

```
app/src/main/java/com/elizaos/facewear/xreal/
  MainActivity.kt         — WebView host, permission management, camera lifecycle
  CameraService.kt        — Camera2 frame capture → binary frame dispatch to JS
  XrealBridgeJs.kt        — @JavascriptInterface bridge: WebSocket ↔ PWA
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Build fails: `Could not find :app:libs` | Create `app/libs/` directory (even if empty) |
| Camera black — Camera2 access denied | Grant CAMERA permission in system settings |
| WebSocket connection refused | Ensure agent is running; check firewall; use device LAN IP not 127.0.0.1 |
| XREAL SDK classes not found | AAR not in `app/libs/` or `fileTree` dep still commented out |
| Gradle sync fails | Run `./gradlew --stop` then sync again |

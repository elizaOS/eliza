# AOSP system-app build path

## Why a system-app build

Third-party apps on stock Android cannot:

- Capture the frame buffer of other apps without the user consenting to each session (MediaProjection).
- Inject raw input events with pixel-perfect coordinates (only `AccessibilityGestureDescription`, which is coarser).
- Enumerate all running processes beyond what `ActivityManager.getRunningAppProcesses()` returns to non-system callers.

Deploying Milady as a privileged system app in a custom AOSP build removes all three restrictions.
The `aosp` build flavor enables the `AospPrivilegedBridge` implementation; the `consumer` flavor
ships the stub that always returns `null` from `createIfAvailable()`.

Being the system assistant does not change LifeOps persistence. Assistant-role
entry points may wake Eliza and pass an utterance into the app/runtime, but
reminders, check-ins, follow-ups, watchers, recaps, and approvals must still be
created as LifeOps `ScheduledTask` records. Do not add a privileged native
reminder path that bypasses the scheduled-task runner.

## Required AOSP setup

### 1. `vendor/elizaos` or `device/elizaos` overlay

Place the app source under a dedicated overlay to keep the `device/` tree clean:

```
device/elizaos/
  milady/
    Android.bp          # BUILD module for the system app
    app/                # APK source tree (this repo, checked out)
    privapp-permissions-milady.xml
    sepolicy/
      milady_app.te
      file_contexts
```

### 2. `Android.bp` — platform-signed system app

```makefile
android_app {
    name: "MiladyApp",
    certificate: "platform",        # co-signs with the platform key
    privileged: true,               # installs into /system/priv-app/
    platform_apis: true,            # allows hidden API access
    srcs: ["app/src/**/*.kt", "app/src/**/*.java"],
    resource_dirs: ["app/src/main/res"],
    manifest: "app/src/main/AndroidManifest.xml",
    static_libs: [
        "androidx.core_core-ktx",
        "androidx.appcompat_appcompat",
        "capacitor-android",        # or bundle the AAR
    ],
    optimize: {
        enabled: false,
    },
}
```

### 3. `privapp-permissions-milady.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<permissions>
    <privapp-permissions package="ai.milady.milady">
        <permission name="android.permission.READ_FRAME_BUFFER" />
        <permission name="android.permission.INJECT_EVENTS" />
        <permission name="android.permission.REAL_GET_TASKS" />
    </privapp-permissions>
</permissions>
```

Install this to `$(TARGET_COPY_OUT_SYSTEM)/etc/permissions/privapp-permissions-milady.xml`
via the `PRODUCT_COPY_FILES` variable in your device's `device.mk`:

```makefile
PRODUCT_COPY_FILES += \
    device/elizaos/milady/privapp-permissions-milady.xml:$(TARGET_COPY_OUT_SYSTEM)/etc/permissions/privapp-permissions-milady.xml
```

### 4. SELinux policy (`milady_app.te`)

The minimal type enforcement rules for the privileged capabilities:

```te
type milady_app, domain;
type milady_app_exec, exec_type, file_type;

# Allow binder IPC to system_server (IActivityManager, InputManager)
binder_call(milady_app, system_server)
binder_use(milady_app)

# Allow surface flinger frame buffer read
allow milady_app gpu_device:chr_file { read ioctl };
allow milady_app surfaceflinger:fd use;

# Allow input event injection
allow milady_app input_device:chr_file { read write };

# Standard app capabilities
# (inherit from untrusted_app with additions above)
```

Add `milady_app.te` and the `file_contexts` line:

```
/system/priv-app/MiladyApp/MiladyApp.apk  u:object_r:priv_app_data_file:s0
```

to your `sepolicy/` overlay directory.

### 5. `AndroidManifest.xml` additions for the system build

Add `sharedUserId` and `protectionLevel` declarations alongside the existing manifest:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    android:sharedUserId="android.uid.system">  <!-- or a custom shared UID -->

    <!-- Privileged permissions — only granted when certificate matches platform -->
    <uses-permission android:name="android.permission.READ_FRAME_BUFFER" />
    <uses-permission android:name="android.permission.INJECT_EVENTS" />
    <uses-permission android:name="android.permission.REAL_GET_TASKS" />
    ...
</manifest>
```

## Kotlin implementation notes (aosp flavor)

### `SurfaceControl.captureDisplay()` (READ_FRAME_BUFFER)

```kotlin
// Hidden API — requires platform_apis: true in Android.bp
// Available from API 26; stable-ish since API 29.
val hardwareBuffer = SurfaceControl.captureDisplay(
    SurfaceControl.DisplayCaptureArgs.Builder(
        SurfaceControl.getInternalDisplayToken()
    )
    .setSourceCrop(Rect(0, 0, displayWidth, displayHeight))
    .build()
)
val bitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer.hardwareBuffer, null)
    ?.copy(Bitmap.Config.ARGB_8888, false)
```

This is synchronous and captures the composited display without the user prompt
that MediaProjection requires. The resulting Bitmap can be encoded to JPEG and
forwarded to JS exactly as `ScreenCaptureService` does.

### `InputManager.injectInputEvent()` (INJECT_EVENTS)

```kotlin
val im = InputManager.getInstance()
// Obtain via reflection for hidden API in consumer flavor;
// direct call allowed with platform_apis: true.
val downEvent = MotionEvent.obtain(
    downTimeMs, SystemClock.uptimeMillis(),
    MotionEvent.ACTION_DOWN, x, y, 0
)
im.injectInputEvent(downEvent, InputManager.INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH)
downEvent.recycle()
```

Higher fidelity than `AccessibilityGestureDescription`: bypasses the gesture recognizer,
works in apps that disable AccessibilityEvent delivery (e.g. banking apps with `filterTouchesWhenObscured`).

### `IActivityManager.getRunningAppProcesses()` (REAL_GET_TASKS)

```kotlin
val am = ActivityManagerNative.getDefault()  // hidden API binder proxy
val processes: List<RunningAppProcessInfo> = am.runningAppProcesses
// Each entry: { pid, processName, pkgList, importance }
```

Returns all processes including background services, not just "visible to the user"
subset that the public API returns for non-system callers.

## Build commands

```bash
# From the AOSP root
source build/envsetup.sh
lunch <target>-eng          # e.g. sdk_phone_x86_64-eng or device_name-userdebug
m MiladyApp                 # build just the APK
adb install -r -d $(ANDROID_PRODUCT_OUT)/system/priv-app/MiladyApp/MiladyApp.apk
adb reboot
```

For a full system image build:

```bash
m -j$(nproc)
fastboot flashall -w
```

## Assistant-role validation

On a flashed AOSP image:

1. Confirm `ROLE_ASSISTANT` resolves to Eliza:
   `adb shell settings get secure assistant`.
2. Trigger the assistant activity:
   `adb shell am start -a android.intent.action.ASSIST -n com.elizaai.eliza/ai.elizaos.app.ElizaAssistActivity`.
3. Trigger voice command routing:
   `adb shell am start -a android.intent.action.VOICE_COMMAND -n com.elizaai.eliza/ai.elizaos.app.ElizaAssistActivity`.
4. Ask for a reminder, a check-in, and a follow-up. Verify the app/runtime
   creates LifeOps `ScheduledTask` records for each request.
5. Verify privileged capture/input (`SurfaceControl` / `InputManager`) does not
   introduce a separate scheduling or notification store.

## Sepolicy considerations

- The SELinux audit log (`adb logcat -b events | grep avc`) is the ground truth
  for missing allow rules. Build in `userdebug` or `eng` mode to get `auditd` output.
- Use `audit2allow -i /path/to/avc.log` to generate candidate rules, then
  review them manually — `audit2allow` output is a starting point, not the final policy.
- Avoid `permissive milady_app` in production builds; it disables all MAC enforcement
  for the domain.

## Consumer build difference

In the `consumer` Gradle build flavor:

- `AospPrivilegedBridge.createIfAvailable()` always returns `null`.
- `ComputerUsePlugin` never calls any hidden API.
- The `aosp` source set (`src/aosp/java/`) is excluded from compilation.
- The privileged permissions are absent from the manifest — the Play Store build
  would be rejected anyway if `sharedUserId="android.uid.system"` is present.

// TODO: validate on device — checklist in ANDROID_CONSTRAINTS.md
//
// ComputerUsePlugin — Capacitor plugin that wires the Android computer-use
// surface to JS. Registered as plugin name "ComputerUse" (same jsName as iOS).
//
// All methods return the AndroidBridgeResult<T> envelope:
//   { ok: true, data: T } | { ok: false, code: string, message: string }
//
// MARK: - Contract (mirrors android-bridge.ts AndroidComputerUseBridge)

package ai.elizaos.computeruse

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "ComputerUse")
class ComputerUsePlugin : Plugin() {

    private var camera2Source: Camera2Source? = null

    // ── Component lifecycle — onTrimMemory → MemoryArbiter pressure ───────────

    private val trimMemoryCallbacks = object : ComponentCallbacks2 {
        override fun onTrimMemory(level: Int) {
            // Map Android trim levels to the JS pressure levels.
            // WS1 memory-pressure.ts CapacitorPressureSource.dispatch() is called
            // from JS via bridge.dispatchMemoryPressure(). We route through the
            // bridge so the JS arbiter receives the signal on its own event loop.
            val pressureLevel = when {
                level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "critical"
                level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> "low"
                else -> "nominal"
            }
            val freeMb = (Runtime.getRuntime().freeMemory() / (1024L * 1024L)).toInt()
            notifyListeners("memoryPressure", JSObject().apply {
                put("level", pressureLevel)
                put("freeMb", freeMb)
            })
        }
        override fun onConfigurationChanged(newConfig: Configuration) {}
        override fun onLowMemory() {
            notifyListeners("memoryPressure", JSObject().apply {
                put("level", "critical")
                put("freeMb", (Runtime.getRuntime().freeMemory() / (1024L * 1024L)).toInt())
            })
        }
    }

    override fun load() {
        activity?.application?.registerComponentCallbacks(trimMemoryCallbacks)
    }

    override fun handleOnDestroy() {
        activity?.application?.unregisterComponentCallbacks(trimMemoryCallbacks)
        camera2Source?.close()
        camera2Source = null
    }

    // ── MediaProjection ───────────────────────────────────────────────────────

    @PluginMethod
    fun startMediaProjection(call: PluginCall) {
        val fps = call.getInt("fps", 1) ?: 1
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            call.resolve(err("unsupported_platform", "MediaProjection requires API 21+"))
            return
        }
        val mgr = context.getSystemService(MediaProjectionManager::class.java)
        val captureIntent = mgr.createScreenCaptureIntent()
        // Store fps so the ActivityCallback can use it.
        bridge.saveCall(call)
        startActivityForResult(call, captureIntent, "onMediaProjectionResult")
    }

    @ActivityCallback
    private fun onMediaProjectionResult(call: PluginCall?, result: ActivityResult?) {
        if (call == null) return
        val fps = call.getInt("fps", 1) ?: 1
        if (result == null || result.resultCode != Activity.RESULT_OK || result.data == null) {
            call.resolve(err("permission_denied", "User declined MediaProjection consent"))
            return
        }
        val serviceIntent = Intent(context, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START
            putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
            putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.data)
            putExtra(ScreenCaptureService.EXTRA_FPS, fps)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
        call.resolve(JSObject().apply { put("ok", true); put("data", JSObject().apply { put("running", true) }) })
    }

    @PluginMethod
    fun stopMediaProjection(call: PluginCall) {
        val intent = Intent(context, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_STOP
        }
        context.startService(intent)
        call.resolve(JSObject().apply { put("ok", true); put("data", JSObject().apply { put("stopped", true) }) })
    }

    @PluginMethod
    fun captureFrame(call: PluginCall) {
        val frame = ScreenCaptureService.latestFrame
        if (frame == null) {
            call.resolve(err("capture_unavailable", "No frame available — call startMediaProjection first"))
            return
        }
        call.resolve(JSObject().apply {
            put("ok", true)
            put("data", JSObject().apply {
                put("jpegBase64", frame.jpegBase64)
                put("width", frame.width)
                put("height", frame.height)
                put("timestampMs", frame.timestampMs)
            })
        })
    }

    // ── AccessibilityService ──────────────────────────────────────────────────

    @PluginMethod
    fun getAccessibilityTree(call: PluginCall) {
        val svc = MiladyAccessibilityService.instance
        if (svc == null) {
            call.resolve(err("accessibility_unavailable", "MiladyAccessibilityService not running — enable in Settings > Accessibility"))
            return
        }
        val json = svc.getAccessibilityTreeJson()
        call.resolve(JSObject().apply {
            put("ok", true)
            put("data", JSObject().apply { put("nodes", json) })
        })
    }

    @PluginMethod
    fun dispatchGesture(call: PluginCall) {
        val svc = MiladyAccessibilityService.instance
        if (svc == null) {
            call.resolve(err("accessibility_unavailable", "MiladyAccessibilityService not running"))
            return
        }
        val type = call.getString("type") ?: "tap"
        val x = call.getFloat("x", 0f) ?: 0f
        val y = call.getFloat("y", 0f) ?: 0f
        val ok = when (type) {
            "tap" -> svc.dispatchTap(x, y)
            "swipe" -> {
                val x2 = call.getFloat("x2", x) ?: x
                val y2 = call.getFloat("y2", y) ?: y
                val durationMs = call.getLong("durationMs", 300L) ?: 300L
                svc.dispatchSwipe(x, y, x2, y2, durationMs)
            }
            else -> {
                call.resolve(err("invalid_argument", "Unknown gesture type: $type"))
                return
            }
        }
        call.resolve(JSObject().apply { put("ok", ok) })
    }

    @PluginMethod
    fun performGlobalAction(call: PluginCall) {
        val svc = MiladyAccessibilityService.instance
        if (svc == null) {
            call.resolve(err("accessibility_unavailable", "MiladyAccessibilityService not running"))
            return
        }
        val action = call.getString("action") ?: ""
        val ok = when (action) {
            "back" -> svc.doBack()
            "home" -> svc.doHome()
            "recents" -> svc.doRecents()
            "notifications" -> svc.doNotifications()
            else -> {
                call.resolve(err("invalid_argument", "Unknown global action: $action"))
                return
            }
        }
        call.resolve(JSObject().apply { put("ok", ok) })
    }

    @PluginMethod
    fun setText(call: PluginCall) {
        val svc = MiladyAccessibilityService.instance
        if (svc == null) {
            call.resolve(err("accessibility_unavailable", "MiladyAccessibilityService not running"))
            return
        }
        val text = call.getString("text")
        if (text == null) {
            call.resolve(err("invalid_argument", "setText requires a text string"))
            return
        }
        val ok = svc.setFocusedEditableText(text)
        call.resolve(JSObject().apply {
            put("ok", true)
            put("data", JSObject().apply { put("ok", ok) })
        })
    }

    // ── UsageStats / app enumeration ──────────────────────────────────────────

    @PluginMethod
    fun enumerateApps(call: PluginCall) {
        bridge.execute {
            try {
                val entries = UsageStatsHelper.enumerateApps(context)
                val json = UsageStatsHelper.toJson(entries)
                call.resolve(JSObject().apply {
                    put("ok", true)
                    put("data", JSObject().apply { put("apps", json) })
                })
            } catch (e: SecurityException) {
                call.resolve(err("permission_denied", e.message ?: "PACKAGE_USAGE_STATS not granted"))
            } catch (e: Exception) {
                call.resolve(err("internal_error", e.message ?: "enumerateApps failed"))
            }
        }
    }

    // ── Memory pressure (one-shot snapshot) ───────────────────────────────────

    @PluginMethod
    fun getMemoryPressureSnapshot(call: PluginCall) {
        val runtime = Runtime.getRuntime()
        val freeMb = (runtime.freeMemory() / (1024L * 1024L)).toInt()
        val maxMb = (runtime.maxMemory() / (1024L * 1024L)).toInt()
        val usedMb = ((runtime.totalMemory() - runtime.freeMemory()) / (1024L * 1024L)).toInt()
        val freeFraction = runtime.freeMemory().toDouble() / runtime.maxMemory().toDouble()
        val level = when {
            freeFraction < 0.05 -> "critical"
            freeFraction < 0.15 -> "low"
            else -> "nominal"
        }
        call.resolve(JSObject().apply {
            put("ok", true)
            put("data", JSObject().apply {
                put("level", level)
                put("freeMb", freeMb)
                put("maxMb", maxMb)
                put("usedMb", usedMb)
                put("source", "android-runtime")
            })
        })
    }

    @PluginMethod
    fun dispatchMemoryPressure(call: PluginCall) {
        // Called by JS-side onTrimMemory handler to propagate pressure level
        // to the WS1 MemoryArbiter. The plugin notifies the arbiter listener
        // attached to the capacitorPressureSource in memory-pressure.ts.
        val level = call.getString("level") ?: "nominal"
        val freeMb = call.getInt("freeMb")
        notifyListeners("memoryPressure", JSObject().apply {
            put("level", level)
            if (freeMb != null) put("freeMb", freeMb)
        })
        call.resolve(JSObject().apply { put("ok", true) })
    }

    // ── Camera (MobileCameraSource implementation) ────────────────────────────

    @PluginMethod
    fun startCamera(call: PluginCall) {
        bridge.execute {
            try {
                val src = Camera2Source(context)
                src.open(
                    cameraId = call.getString("cameraId"),
                    width = call.getInt("width", 640) ?: 640,
                    height = call.getInt("height", 480) ?: 480,
                    fps = call.getInt("fps", 1) ?: 1,
                )
                camera2Source?.close()
                camera2Source = src
                val cameraList = src.listCameras()
                call.resolve(JSObject().apply {
                    put("ok", true)
                    put("data", JSObject().apply { put("cameras", cameraList) })
                })
            } catch (e: SecurityException) {
                call.resolve(err("permission_denied", e.message ?: "CAMERA not granted"))
            } catch (e: Exception) {
                call.resolve(err("internal_error", e.message ?: "startCamera failed"))
            }
        }
    }

    @PluginMethod
    fun stopCamera(call: PluginCall) {
        camera2Source?.close()
        camera2Source = null
        call.resolve(JSObject().apply { put("ok", true) })
    }

    @PluginMethod
    fun captureFrameCamera(call: PluginCall) {
        val src = camera2Source
        if (src == null) {
            call.resolve(err("camera_not_open", "Call startCamera first"))
            return
        }
        bridge.execute {
            try {
                val b64 = src.captureJpegBase64()
                call.resolve(JSObject().apply {
                    put("ok", true)
                    put("data", JSObject().apply { put("jpegBase64", b64) })
                })
            } catch (e: Exception) {
                call.resolve(err("internal_error", e.message ?: "captureFrameCamera failed"))
            }
        }
    }

    // ── Probe ────────────────────────────────────────────────────────────────

    @PluginMethod
    fun probe(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("ok", true)
            put("data", JSObject().apply {
                put("platform", "android")
                put("osVersion", Build.VERSION.RELEASE ?: "")
                put("sdkInt", Build.VERSION.SDK_INT)
                put("capabilities", JSObject().apply {
                    put("mediaProjection", hasMediaProjectionCapability())
                    put("accessibilityService", MiladyAccessibilityService.instance != null)
                    put("usageStats", UsageStatsHelper.hasUsageStatsPermission(context))
                    put("camera", hasCameraCapability())
                    put("aospPrivileged", AospPrivilegedBridge.createIfAvailable() != null)
                })
            })
        })
    }

    // ── AOSP privileged path skeleton (consumer build — disabled) ─────────────
    // See docs/AOSP_SYSTEM_APP.md for the privileged path using
    // SurfaceControl.captureDisplay() and InputManager.injectInputEvent().
    // In the consumer build flavor these are never called.

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun hasMediaProjectionCapability(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return false
        val service = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
        return service is MediaProjectionManager
    }

    private fun hasCameraCapability(): Boolean {
        val pm = context.packageManager
        if (!pm.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) return false
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return try {
            val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            manager.cameraIdList.isNotEmpty()
        } catch (_: CameraAccessException) {
            false
        } catch (_: RuntimeException) {
            false
        }
    }

    private fun err(code: String, message: String): JSObject = JSObject().apply {
        put("ok", false)
        put("code", code)
        put("message", message)
    }
}

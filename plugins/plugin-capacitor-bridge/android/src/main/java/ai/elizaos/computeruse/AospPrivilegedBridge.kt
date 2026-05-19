// TODO: validate on device — checklist in ANDROID_CONSTRAINTS.md
//
// AospPrivilegedBridge — AOSP system-app privileged path skeleton.
//
// This file compiles in the standard SDK against hidden-API stubs via the
// `aosp` build flavor. It is never loaded in the `consumer` flavor.
//
// For AOSP deployment see: eliza/plugins/plugin-computeruse/docs/AOSP_SYSTEM_APP.md
//
// Privileged capabilities enabled by this path:
//   1. SurfaceControl.captureDisplay() — READ_FRAME_BUFFER permission
//   2. InputManager.injectInputEvent() — INJECT_EVENTS permission
//   3. IActivityManager direct binder — full process enumeration
//
// These are gated at compile time via the `aosp` build flavor so consumer
// builds ship without any reflection or hidden-API references.

package ai.elizaos.computeruse

/**
 * Marker interface. In the `aosp` flavor this class is replaced by a full
 * implementation. In the `consumer` flavor this stub is loaded but no methods
 * are called — ComputerUsePlugin checks the build flavor at startup.
 *
 * Build flavor check pattern (in ComputerUsePlugin):
 *
 *   if (BuildConfig.FLAVOR == "aosp") {
 *       aospBridge = AospPrivilegedBridge.create(context)
 *   }
 */
interface AospPrivilegedBridge {
    /** Capture the primary display frame buffer synchronously. Returns JPEG bytes. */
    fun captureDisplayFrameBuffer(): ByteArray

    /**
     * Inject a MotionEvent at the InputManager level.
     * Higher fidelity than AccessibilityService gesture dispatch:
     * — Bypasses AccessibilityService gesture description limitations.
     * — Works in cases where the active window excludes accessibility events.
     */
    fun injectMotionEvent(x: Float, y: Float, action: Int, downTimeMs: Long)

    /**
     * Enumerate all running processes via IActivityManager.
     * Returns a list of (pid, processName, packageName) tuples.
     */
    fun listRunningProcesses(): List<ProcessEntry>

    data class ProcessEntry(
        val pid: Int,
        val processName: String,
        val packageName: String,
    )

    companion object {
        /** Returns null in the consumer build flavor — never throws. */
        fun createIfAvailable(): AospPrivilegedBridge? = null
    }
}

// ── Consumer-flavor stub implementation ───────────────────────────────────────
//
// In the aosp flavor, a separate source set (src/aosp/java/...) provides a
// full implementation using:
//   - android.view.SurfaceControl.ScreenshotHardwareBuffer (hidden API, platform sig)
//   - android.hardware.input.InputManager.injectInputEvent (hidden API)
//   - IActivityManager.getRunningAppProcesses (via AIDL binder proxy)
//
// The aosp source set is never shipped to end users.

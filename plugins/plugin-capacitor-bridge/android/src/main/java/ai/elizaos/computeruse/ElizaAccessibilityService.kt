// TODO: validate on device — checklist in ANDROID_CONSTRAINTS.md
//
// MiladyAccessibilityService — cross-app input dispatch + element tree snapshot.
//
// Requires:
//   - AccessibilityService declared in AndroidManifest.xml with BIND_ACCESSIBILITY_SERVICE
//   - accessibility_service_config.xml in res/xml/
//   - User must manually enable in Settings > Accessibility > Milady
//
// MARK: - Contract (mirrors android-bridge.ts getAccessibilityTree / dispatchGesture)
//
// getAccessibilityTree() → JSON array of AxNode:
//   [{ id: string, role: string, label: string|null, bbox: {x,y,w,h}, actions: string[] }]
//
// dispatchGesture({ type: "tap"|"swipe", x, y, x2?, y2?, durationMs? }) → { ok: boolean }
// performGlobalAction({ action: "back"|"home"|"recents"|"notifications" }) → { ok: boolean }

package ai.elizaos.computeruse

import android.accessibilityservice.AccessibilityGestureDescription
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

class MiladyAccessibilityService : AccessibilityService() {

    companion object {
        // Singleton ref — Capacitor plugin reads this to check if the service is running.
        @Volatile
        var instance: MiladyAccessibilityService? = null
            private set
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onServiceConnected() {
        instance = this
        val info = serviceInfo ?: AccessibilityServiceInfo()
        info.eventTypes =
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        // Keep the accessibility feature type for Advanced Protection Mode compatibility.
        info.flags =
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
            AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        info.notificationTimeout = 100L
        serviceInfo = info
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onInterrupt() {
        // Required override — no action needed for our use case.
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // We don't react to events proactively; snapshots are pull-based
        // via the Capacitor bridge calling getAccessibilityTreeJson().
    }

    // ── Accessibility tree snapshot ───────────────────────────────────────────

    /**
     * Walk the active window's node tree and produce a compact JSON array
     * matching the WS6 Scene.ax shape:
     *   [{ id, role, label, bbox, actions }]
     *
     * Called from the Capacitor plugin on the bridge thread; safe because
     * AccessibilityNodeInfo is thread-safe for reads after getRootInActiveWindow().
     */
    fun getAccessibilityTreeJson(): String {
        val root = rootInActiveWindow ?: return "[]"
        return try {
            val array = JSONArray()
            walkNode(root, array, idCounter = intArrayOf(0))
            root.recycle()
            array.toString()
        } catch (e: Exception) {
            "[]"
        }
    }

    private fun walkNode(node: AccessibilityNodeInfo, out: JSONArray, idCounter: IntArray) {
        val id = idCounter[0]++
        val bounds = Rect()
        node.getBoundsInScreen(bounds)

        val actions = JSONArray()
        if (node.isClickable) actions.put("click")
        if (node.isLongClickable) actions.put("longClick")
        if (node.isScrollable) actions.put("scroll")
        if (node.isEditable) actions.put("type")
        if (node.isFocusable) actions.put("focus")

        val obj = JSONObject()
        obj.put("id", id.toString())
        obj.put("role", node.className?.toString() ?: "unknown")
        obj.put("label", node.contentDescription?.toString() ?: node.text?.toString())
        obj.put("bbox", JSONObject().apply {
            put("x", bounds.left)
            put("y", bounds.top)
            put("w", bounds.width())
            put("h", bounds.height())
        })
        obj.put("actions", actions)
        out.put(obj)

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            walkNode(child, out, idCounter)
            child.recycle()
        }
    }

    // ── Gesture dispatch ──────────────────────────────────────────────────────

    /**
     * Dispatch a tap at (x, y) using AccessibilityGestureDescription (API 24+).
     * Returns true if the gesture was dispatched; the native system reports
     * completion asynchronously, which we ignore (fire-and-forget from JS).
     */
    fun dispatchTap(x: Float, y: Float): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val path = Path()
        path.moveTo(x, y)
        val gesture = AccessibilityGestureDescription.Builder()
            .addStroke(
                AccessibilityGestureDescription.GestureStep(
                    path, /* willContinue= */ false
                )
            )
            .build()
        return dispatchGesture(gesture, null, null)
    }

    /**
     * Dispatch a swipe from (x1, y1) to (x2, y2) over durationMs.
     * Minimum duration enforced at 50ms per Android docs.
     */
    fun dispatchSwipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val duration = maxOf(50L, durationMs)
        val path = Path()
        path.moveTo(x1, y1)
        path.lineTo(x2, y2)
        val gesture = AccessibilityGestureDescription.Builder()
            .addStroke(
                AccessibilityGestureDescription.GestureStep(
                    path, /* willContinue= */ false
                )
            )
            .setDuration(duration)
            .build()
        return dispatchGesture(gesture, null, null)
    }

    /**
     * Set text on the focused editable node using the public Accessibility API.
     * This is the consumer-build text-input path; it requires the user-enabled
     * accessibility service but does not need privileged input injection.
     */
    fun setFocusedEditableText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        return try {
            val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            val target =
                if (focused?.isEditable == true) focused else findFocusedEditable(root)
                    ?: return false
            val args = Bundle().apply {
                putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    text,
                )
            }
            target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        } catch (_: Exception) {
            false
        } finally {
            root.recycle()
        }
    }

    private fun findFocusedEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isFocused && node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val match = findFocusedEditable(child)
            if (match != null) return match
            child.recycle()
        }
        return null
    }

    // ── Global actions ────────────────────────────────────────────────────────

    fun doBack(): Boolean = performGlobalAction(GLOBAL_ACTION_BACK)
    fun doHome(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)
    fun doRecents(): Boolean = performGlobalAction(GLOBAL_ACTION_RECENTS)
    fun doNotifications(): Boolean = performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
}

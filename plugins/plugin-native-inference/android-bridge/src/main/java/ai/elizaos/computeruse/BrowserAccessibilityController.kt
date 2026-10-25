/**
 * Controls the foreground Chromium session through snapshot-bound accessibility nodes.
 * Package and window checks prevent a delayed browser command from acting in another app.
 * An accepted accessibility action is a dispatch receipt, never proof of website completion.
 */
package ai.elizaos.computeruse

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import com.getcapacitor.JSObject
import org.json.JSONArray
import java.util.UUID

class BrowserAccessibilityController {
    private val nodes = mutableMapOf<String, AccessibilityNodeInfo>()
    private var snapshotId: String? = null
    private var windowId: Int? = null
    private val packageName = "org.chromium.chrome"

    @Synchronized
    fun execute(service: ElizaAccessibilityService, command: JSObject): JSObject {
        val root = service.rootInActiveWindow
            ?: return failure("SESSION_GONE", "No foreground accessibility window is available.")
        try {
            if (root.packageName?.toString() != packageName) {
                clear()
                return failure("SESSION_GONE", "Chromium is not the foreground app. Open the browser before controlling it.")
            }
            val action = command.optString("subaction")
            if (action == "snapshot") {
                clear()
                snapshotId = UUID.randomUUID().toString()
                windowId = root.windowId
                val elements = JSONArray()
                collect(root, elements)
                return success(JSObject().apply {
                    put("representation", "android-accessibility")
                    put("packageName", packageName)
                    put("snapshotId", snapshotId)
                    put("elements", elements)
                    put("complete", true)
                })
            }
            if (action !in setOf("click", "fill", "scroll", "back"))
                return failure("UNSUPPORTED", "Supported Chromium commands: snapshot, click, fill, scroll, back.")
            val expected = command.optString("selector").substringBefore(":")
            if (expected.isEmpty() || expected != snapshotId || windowId != root.windowId)
                return failure("STALE_REF", "Read a fresh Chromium snapshot before acting.")
            val node = if (action == "back") null else nodes[command.optString("selector")]
            if (action != "back" && (node == null || !node.refresh() || node.packageName?.toString() != packageName || node.windowId != root.windowId)) {
                clear()
                return failure("STALE_REF", "The browser element changed; read a fresh snapshot.")
            }
            if (action == "fill" && (!command.has("text") || command.get("text") !is String))
                return failure("UNSUPPORTED", "fill requires a text string.")
            val accepted = when (action) {
                "click" -> node!!.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                "fill" -> node!!.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, command.getString("text"))
                })
                "scroll" -> node!!.performAction(if (command.optString("direction", "down") in setOf("up", "left")) AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                else -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            }
            clear()
            if (!accepted) return failure("UNCERTAIN_OUTCOME", "Chromium did not confirm accepting the accessibility action. Read the current page before retrying.")
            return success(JSObject().apply {
                put("packageName", packageName)
                put("dispatched", true)
                put("completed", false)
                put("requiresReadback", true)
            })
        } finally {
            root.recycle()
        }
    }

    private fun collect(node: AccessibilityNodeInfo, output: JSONArray) {
        val id = "$snapshotId:ax-${nodes.size}"
        nodes[id] = AccessibilityNodeInfo.obtain(node)
        val actions = JSONArray()
        if (node.isClickable) actions.put("click")
        if (node.isEditable) actions.put("fill")
        if (node.isScrollable) actions.put("scroll")
        output.put(JSObject().apply {
            put("selector", id)
            put("role", node.className?.toString())
            put("label", if (node.isPassword) "Password" else node.contentDescription?.toString() ?: node.text?.toString())
            put("actions", actions)
            put("password", node.isPassword)
        })
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            try { collect(child, output) } finally { child.recycle() }
        }
    }

    @Synchronized
    fun clear() {
        nodes.values.forEach { it.recycle() }
        nodes.clear()
        snapshotId = null
        windowId = null
    }

    private fun success(data: JSObject) = JSObject().apply { put("ok", true); put("data", data) }
    private fun failure(code: String, message: String) = JSObject().apply {
        put("ok", false); put("code", code); put("message", message)
    }
}

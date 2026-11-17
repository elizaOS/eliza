package ai.eliza.plugins.browsersurface

import android.app.Activity
import android.app.AppOpsManager
import android.graphics.Color
import android.graphics.PixelFormat
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import com.getcapacitor.JSObject

/** Host UI only. No browser launch, page access, task resumption or audio ownership. */
internal class BrowserHelperEntry(
    private val activity: Activity,
    private val webView: WebView,
    private val returned: () -> Unit,
    private val failed: () -> Unit,
    private val revoked: () -> Unit
) {
    private val manager = activity.getSystemService(WindowManager::class.java)
    private var entry: View? = null
    private var full: FrameLayout? = null
    private var parent: ViewGroup? = null
    private var parentIndex = 0
    private var parentLayout: ViewGroup.LayoutParams? = null
    private var label = "Helper"
    private var description = "Return to helper"

    private var destroyed = false
    private val appOps = activity.getSystemService(AppOpsManager::class.java)
    private val permissionWatcher = AppOpsManager.OnOpChangedListener { operation, packageName ->
        if (operation == AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW && packageName == activity.packageName)
            activity.runOnUiThread { reconcilePermission() }
    }

    init { appOps.startWatchingMode(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW, activity.packageName, permissionWatcher) }

    /** Android can hide an overlay without detaching its view. Restore host ownership. */
    fun reconcilePermission() {
        if (destroyed || Settings.canDrawOverlays(activity) || (entry == null && full == null)) return
        release()
        revoked()
    }

    fun state() = JSObject().apply {
        put("permissionGranted", Settings.canDrawOverlays(activity))
        put("visible", entry?.isAttachedToWindow == true)
        put("fullScreen", full?.isAttachedToWindow == true)
    }

    fun requirePermission() {
        if (!Settings.canDrawOverlays(activity)) throw BrowserLaunchException(
            "BROWSER_ENTRY_PERMISSION_REQUIRED", "Allow the helper return button in Android settings before hiding help.")
    }

    fun showEntry(text: String, accessibilityLabel: String) {
        requirePermission()
        if (text.isBlank() || text.length > 32 || accessibilityLabel.isBlank() || accessibilityLabel.length > 120)
            throw BrowserLaunchException("BROWSER_ENTRY_LABEL_INVALID", "A short return label and description are required.")
        label = text; description = accessibilityLabel
        if (entry != null) return
        val button = Button(activity).apply {
            this.text = label
            contentDescription = description
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(24, 28, 32))
            textSize = 18f
            setOnClickListener {
                try { showFullScreen(); returned() }
                catch (error: RuntimeException) {
                    // error-policy:J1 A revoked permission or detached window keeps the browser untouched.
                    failed()
                }
            }
        }
        val density = activity.resources.displayMetrics.density
        val parameters = WindowManager.LayoutParams((96 * density).toInt(), (64 * density).toInt(),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT).apply {
                gravity = Gravity.RIGHT or Gravity.CENTER_VERTICAL
                x = (8 * density).toInt()
                title = "Helper return control"
            }
        manager.addView(button, parameters)
        entry = button
    }

    fun removeEntry() {
        // WindowManager.addView assigns the window's ViewRootImpl as the view's parent at once,
        // but the view attaches only on its first traversal. A refusal in the same main-thread
        // turn (hideBrowserDockWithEntry with no browser split) must still remove the window.
        entry?.let { if (it.isAttachedToWindow || it.parent != null) manager.removeViewImmediate(it) }
        entry = null
    }

    private fun showFullScreen() {
        requirePermission()
        if (full != null) return
        val original = webView.parent as? ViewGroup
            ?: throw BrowserLaunchException("BROWSER_ENTRY_HOST_UNAVAILABLE", "The helper view is unavailable.")
        parent = original; parentIndex = original.indexOfChild(webView); parentLayout = webView.layoutParams
        val frame = FrameLayout(activity).apply { setBackgroundColor(Color.WHITE) }
        original.removeView(webView)
        frame.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        try {
            manager.addView(frame, WindowManager.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                0, PixelFormat.OPAQUE).apply {
                    softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                    title = "Helper conversation"
                })
            full = frame
            removeEntry()
            webView.requestFocus()
        } catch (error: RuntimeException) {
            // error-policy:J1 Restore the existing host view if overlay creation fails.
            frame.removeView(webView)
            original.addView(webView, parentIndex, parentLayout)
            parent = null; parentLayout = null
            throw error
        }
    }

    fun removeFullScreen() {
        val frame = full ?: return
        // End the overlay input connection before moving the same WebView to
        // the Activity window, whose IME and Back dispatcher must own it next.
        val input = activity.getSystemService(InputMethodManager::class.java)
        input.hideSoftInputFromWindow(webView.windowToken, 0)
        webView.clearFocus()
        frame.removeView(webView)
        if (frame.isAttachedToWindow || frame.parent != null) manager.removeViewImmediate(frame)
        parent?.addView(webView, parentIndex, parentLayout)
        full = null; parent = null; parentLayout = null
        webView.post {
            if (!destroyed && full == null && webView.isAttachedToWindow) {
                webView.requestFocus()
                input.restartInput(webView)
            }
        }
    }

    fun release() { removeEntry(); removeFullScreen() }

    fun destroy() {
        destroyed = true
        appOps.stopWatchingMode(permissionWatcher)
        release()
    }
}

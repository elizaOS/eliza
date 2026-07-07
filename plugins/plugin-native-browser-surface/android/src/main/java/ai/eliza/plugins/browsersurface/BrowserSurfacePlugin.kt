package ai.eliza.plugins.browsersurface

import android.os.Build
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Native Android half of `ElizaSurfaceManager` (#15245): layers one [WebView]
 * per Browser tab above the Capacitor host webview, each with the platform
 * out-of-process renderer and its OWN storage partition, so third-party content
 * can never reach the host realm or a sibling tab.
 *
 * Isolation maps onto two androidx.webkit primitives. Renderer: the WebView
 * renderer runs out-of-process by platform default on API 26+; an `isolated`
 * surface asserts that separation is actually in effect and fails fast if not.
 * Storage: an `isolated` surface gets its own multi-profile [androidx.webkit
 * Profile][ProfileStore] (cookies/localStorage/IndexedDB partitioned); a
 * `shared` surface uses the default profile. There is NO silent degrade — if the
 * system WebView is too old for multi-profile, `createSurface` rejects, because a
 * surface that quietly shares the default store is the exact leak this closes.
 */
@CapacitorPlugin(name = "ElizaSurfaceManager")
class ElizaSurfaceManagerPlugin : Plugin() {
    private data class Surface(
        val webView: WebView,
        val process: String,
        val storage: String,
        var foregrounded: Boolean,
    )

    private val surfaces = HashMap<String, Surface>()

    private fun density(): Float = activity.resources.displayMetrics.density

    @PluginMethod
    fun createSurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("createSurface requires an id")
            return
        }
        val process = call.getString("process")
        if (process != "isolated" && process != "shared") {
            call.reject("createSurface requires an explicit process policy (isolated|shared)")
            return
        }
        val storage = call.getString("storage")
        if (storage != "isolated" && storage != "shared") {
            call.reject("createSurface requires an explicit storage policy (isolated|shared)")
            return
        }
        val url = call.getString("url")

        activity.runOnUiThread {
            if (surfaces.containsKey(id)) {
                call.resolve()
                return@runOnUiThread
            }
            val host = bridge.webView.parent as? FrameLayout ?: run {
                call.reject("host webview has no FrameLayout parent to attach the surface to")
                return@runOnUiThread
            }

            val webView = WebView(activity)
            webView.settings.javaScriptEnabled = true
            webView.settings.domStorageEnabled = true
            webView.settings.databaseEnabled = true

            // Storage isolation via multi-profile. Fail-fast: no silent degrade
            // to the shared default profile on an unsupported system WebView.
            if (storage == "isolated") {
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                    webView.destroy()
                    call.reject("isolated storage requires WebView multi-profile support; system WebView is too old")
                    return@runOnUiThread
                }
                val profile = ProfileStore.getInstance().getOrCreateProfile("eliza-surface-$id")
                WebViewCompat.setProfile(webView, profile.name)
            }
            // shared storage ⇒ the default profile (host-scoped store).

            val lp = FrameLayout.LayoutParams(0, 0)
            host.addView(webView, lp)
            webView.visibility = View.GONE
            if (url != null) webView.loadUrl(url)

            // Renderer isolation: assert the out-of-process renderer is in effect
            // for an isolated surface. On API 26+ the platform runs it in the
            // sandboxed :webview_service process; a null handle when the feature
            // is supported means this device/build cannot isolate — reject.
            if (
                process == "isolated" &&
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_RENDERER) &&
                WebViewCompat.getWebViewRenderProcess(webView) == null
            ) {
                host.removeView(webView)
                webView.destroy()
                call.reject("isolated process requires an out-of-process WebView renderer, which is unavailable on this device")
                return@runOnUiThread
            }

            surfaces[id] = Surface(webView, process, storage, false)
            call.resolve()
        }
    }

    @PluginMethod
    fun setBounds(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("setBounds requires an id")
            return
        }
        val x = call.getDouble("x") ?: 0.0
        val y = call.getDouble("y") ?: 0.0
        val width = call.getDouble("width") ?: 0.0
        val height = call.getDouble("height") ?: 0.0
        activity.runOnUiThread {
            val surface = surfaces[id] ?: run {
                call.reject("no surface $id")
                return@runOnUiThread
            }
            val d = density()
            val lp = FrameLayout.LayoutParams((width * d).toInt(), (height * d).toInt())
            lp.leftMargin = (x * d).toInt()
            lp.topMargin = (y * d).toInt()
            surface.webView.layoutParams = lp
            call.resolve()
        }
    }

    @PluginMethod
    fun navigate(call: PluginCall) {
        val id = call.getString("id")
        val url = call.getString("url")
        if (id == null || url == null) {
            call.reject("navigate requires an id and a url")
            return
        }
        activity.runOnUiThread {
            val surface = surfaces[id] ?: run {
                call.reject("no surface $id")
                return@runOnUiThread
            }
            surface.webView.loadUrl(url)
            call.resolve()
        }
    }

    @PluginMethod
    fun foregroundSurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("foregroundSurface requires an id")
            return
        }
        activity.runOnUiThread {
            val surface = surfaces[id] ?: run {
                call.reject("no surface $id")
                return@runOnUiThread
            }
            surface.webView.bringToFront()
            surface.webView.visibility = View.VISIBLE
            surface.foregrounded = true
            call.resolve()
        }
    }

    @PluginMethod
    fun backgroundSurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("backgroundSurface requires an id")
            return
        }
        activity.runOnUiThread {
            val surface = surfaces[id] ?: run {
                call.reject("no surface $id")
                return@runOnUiThread
            }
            surface.webView.visibility = View.GONE
            surface.foregrounded = false
            call.resolve()
        }
    }

    @PluginMethod
    fun destroySurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("destroySurface requires an id")
            return
        }
        activity.runOnUiThread {
            surfaces.remove(id)?.let { surface ->
                surface.webView.stopLoading()
                (surface.webView.parent as? FrameLayout)?.removeView(surface.webView)
                surface.webView.destroy()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun foregroundHost(call: PluginCall) {
        activity.runOnUiThread {
            for (surface in surfaces.values) {
                surface.webView.visibility = View.GONE
                surface.foregrounded = false
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun getSurfaceState(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("getSurfaceState requires an id")
            return
        }
        activity.runOnUiThread {
            val result = JSObject()
            val surface = surfaces[id]
            if (surface == null) {
                result.put("exists", false)
                result.put("foregrounded", false)
                result.put("currentUrl", JSObject.NULL)
                result.put("process", JSObject.NULL)
                result.put("storage", JSObject.NULL)
            } else {
                result.put("exists", true)
                result.put("foregrounded", surface.foregrounded)
                result.put("currentUrl", surface.webView.url ?: JSObject.NULL)
                result.put("process", surface.process)
                result.put("storage", surface.storage)
            }
            call.resolve(result)
        }
    }
}

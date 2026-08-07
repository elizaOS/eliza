/**
 * Native Android half of `ElizaSurfaceManager` (#15245): layers one [WebView]
 * per Browser tab above the Capacitor host webview, each with the platform
 * out-of-process renderer and its OWN storage partition. A computed outer clip
 * follows the rounded React host while independent rounded occlusion holes
 * expose host-rendered chrome without resizing or hiding the live page.
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
package ai.eliza.plugins.browsersurface

import android.content.Context
import android.graphics.Canvas
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Region
import android.os.Build
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
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

@CapacitorPlugin(name = "ElizaSurfaceManager")
class ElizaSurfaceManagerPlugin : Plugin() {
    private data class HostOuterClip(
        val x: Double,
        val y: Double,
        val width: Double,
        val height: Double,
        val topLeftRadius: Double,
        val topRightRadius: Double,
        val bottomRightRadius: Double,
        val bottomLeftRadius: Double,
    )

    private data class HostOcclusionRect(
        val x: Double,
        val y: Double,
        val width: Double,
        val height: Double,
        val cornerRadius: Double,
    )

    private data class Surface(
        val container: OccludingSurfaceLayout,
        val webView: WebView,
        val process: String,
        val storage: String,
        var foregrounded: Boolean,
        var x: Double = 0.0,
        var y: Double = 0.0,
        var outerClip: HostOuterClip? = null,
        var occlusions: List<HostOcclusionRect> = emptyList(),
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
            val host = findNearestFrameLayoutAncestor(bridge.webView) ?: run {
                call.reject("host webview has no FrameLayout ancestor to attach the surface to")
                return@runOnUiThread
            }

            val container = OccludingSurfaceLayout(activity)
            val webView = WebView(activity)
            webView.settings.javaScriptEnabled = true
            webView.settings.domStorageEnabled = true
            webView.settings.databaseEnabled = true
            container.addView(
                webView,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )

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
            host.addView(container, lp)
            container.visibility = View.GONE
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
                host.removeView(container)
                webView.destroy()
                call.reject("isolated process requires an out-of-process WebView renderer, which is unavailable on this device")
                return@runOnUiThread
            }

            surfaces[id] = Surface(container, webView, process, storage, false)
            call.resolve()
        }
    }

    @PluginMethod
    fun setBounds(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("setBounds requires an id")
            return
        }
        val x = call.getDouble("x")
        val y = call.getDouble("y")
        val width = call.getDouble("width")
        val height = call.getDouble("height")
        val rawOuterClip = call.getObject("outerClip")
        val rawCornerRadii = rawOuterClip?.optJSONObject("cornerRadii")
        if (x == null || y == null || width == null || height == null || rawOuterClip == null || rawCornerRadii == null) {
            call.reject("setBounds requires page bounds and an outerClip with cornerRadii")
            return
        }
        val outerClip = HostOuterClip(
            x = rawOuterClip.optDouble("x", Double.NaN),
            y = rawOuterClip.optDouble("y", Double.NaN),
            width = rawOuterClip.optDouble("width", Double.NaN),
            height = rawOuterClip.optDouble("height", Double.NaN),
            topLeftRadius = rawCornerRadii.optDouble("topLeft", Double.NaN),
            topRightRadius = rawCornerRadii.optDouble("topRight", Double.NaN),
            bottomRightRadius = rawCornerRadii.optDouble("bottomRight", Double.NaN),
            bottomLeftRadius = rawCornerRadii.optDouble("bottomLeft", Double.NaN),
        )
        if (
            !x.isFinite() || !y.isFinite() || !width.isFinite() || !height.isFinite() ||
            width < 0.0 || height < 0.0 || !outerClip.hasValidGeometry()
        ) {
            call.reject("setBounds has invalid page or outer clip geometry")
            return
        }
        activity.runOnUiThread {
            val surface = surfaces[id] ?: run {
                call.reject("no surface $id")
                return@runOnUiThread
            }
            val d = density()
            val lp = FrameLayout.LayoutParams((width * d).toInt(), (height * d).toInt())
            lp.leftMargin = (x * d).toInt()
            lp.topMargin = (y * d).toInt()
            surface.x = x
            surface.y = y
            surface.outerClip = outerClip
            val current = surface.container.layoutParams as? FrameLayout.LayoutParams
            if (
                current == null || current.width != lp.width || current.height != lp.height ||
                current.leftMargin != lp.leftMargin || current.topMargin != lp.topMargin
            ) {
                surface.container.layoutParams = lp
            }
            applyGeometry(surface, d)
            call.resolve()
        }
    }

    @PluginMethod
    fun setOcclusionRects(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("setOcclusionRects requires an id")
            return
        }
        val rawRects = call.getArray("rects") ?: run {
            call.reject("setOcclusionRects requires a rects array")
            return
        }
        val rects = ArrayList<HostOcclusionRect>(rawRects.length())
        for (index in 0 until rawRects.length()) {
            val raw = rawRects.optJSONObject(index) ?: run {
                call.reject("setOcclusionRects rect $index must be an object")
                return
            }
            val x = raw.optDouble("x", Double.NaN)
            val y = raw.optDouble("y", Double.NaN)
            val width = raw.optDouble("width", Double.NaN)
            val height = raw.optDouble("height", Double.NaN)
            val cornerRadius = raw.optDouble("cornerRadius", 0.0)
            if (
                !x.isFinite() ||
                !y.isFinite() ||
                !width.isFinite() ||
                !height.isFinite() ||
                !cornerRadius.isFinite() ||
                width < 0.0 ||
                height < 0.0 ||
                cornerRadius < 0.0
            ) {
                call.reject("setOcclusionRects rect $index has invalid geometry")
                return
            }
            rects.add(HostOcclusionRect(x, y, width, height, cornerRadius))
        }
        activity.runOnUiThread {
            val surface = surfaces[id] ?: run {
                call.reject("no surface $id")
                return@runOnUiThread
            }
            surface.occlusions = rects
            applyOcclusions(surface, density())
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
            surface.container.bringToFront()
            surface.container.visibility = View.VISIBLE
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
            surface.container.visibility = View.GONE
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
                (surface.container.parent as? ViewGroup)?.removeView(surface.container)
                surface.webView.destroy()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun foregroundHost(call: PluginCall) {
        activity.runOnUiThread {
            for (surface in surfaces.values) {
                surface.container.visibility = View.GONE
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

    private fun HostOuterClip.hasValidGeometry(): Boolean =
        x.isFinite() && y.isFinite() && width.isFinite() && height.isFinite() &&
            topLeftRadius.isFinite() && topRightRadius.isFinite() &&
            bottomRightRadius.isFinite() && bottomLeftRadius.isFinite() &&
            width >= 0.0 && height >= 0.0 && topLeftRadius >= 0.0 &&
            topRightRadius >= 0.0 && bottomRightRadius >= 0.0 && bottomLeftRadius >= 0.0

    private fun applyGeometry(surface: Surface, density: Float) {
        surface.container.setOuterClip(
            surface.outerClip?.let { clip ->
                RoundedOuterClip(
                    left = ((clip.x - surface.x) * density).toFloat(),
                    top = ((clip.y - surface.y) * density).toFloat(),
                    right = ((clip.x - surface.x + clip.width) * density).toFloat(),
                    bottom = ((clip.y - surface.y + clip.height) * density).toFloat(),
                    topLeftRadius = (clip.topLeftRadius * density).toFloat(),
                    topRightRadius = (clip.topRightRadius * density).toFloat(),
                    bottomRightRadius = (clip.bottomRightRadius * density).toFloat(),
                    bottomLeftRadius = (clip.bottomLeftRadius * density).toFloat(),
                )
            },
        )
        applyOcclusions(surface, density)
    }

    private fun applyOcclusions(surface: Surface, density: Float) {
        surface.container.setOcclusions(
            surface.occlusions.map { rect ->
                RoundedOcclusionRect(
                    left = ((rect.x - surface.x) * density).toFloat(),
                    top = ((rect.y - surface.y) * density).toFloat(),
                    right = ((rect.x - surface.x + rect.width) * density).toFloat(),
                    bottom = ((rect.y - surface.y + rect.height) * density).toFloat(),
                    cornerRadius = (rect.cornerRadius * density).toFloat(),
                )
            },
        )
    }
}

internal data class RoundedOuterClip(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
    val topLeftRadius: Float,
    val topRightRadius: Float,
    val bottomRightRadius: Float,
    val bottomLeftRadius: Float,
) {
    private val normalizedRadii: FloatArray = run {
        val raw = floatArrayOf(
            topLeftRadius.coerceAtLeast(0f),
            topRightRadius.coerceAtLeast(0f),
            bottomRightRadius.coerceAtLeast(0f),
            bottomLeftRadius.coerceAtLeast(0f),
        )
        val width = (right - left).coerceAtLeast(0f)
        val height = (bottom - top).coerceAtLeast(0f)
        fun edgeScale(length: Float, first: Float, second: Float): Float {
            val total = first + second
            return if (total > 0f) length / total else 1f
        }
        val scale = minOf(
            1f,
            edgeScale(width, raw[0], raw[1]),
            edgeScale(width, raw[3], raw[2]),
            edgeScale(height, raw[0], raw[3]),
            edgeScale(height, raw[1], raw[2]),
        )
        FloatArray(raw.size) { index -> raw[index] * scale }
    }

    fun pathRadii(): FloatArray = floatArrayOf(
        normalizedRadii[0],
        normalizedRadii[0],
        normalizedRadii[1],
        normalizedRadii[1],
        normalizedRadii[2],
        normalizedRadii[2],
        normalizedRadii[3],
        normalizedRadii[3],
    )

    fun contains(x: Float, y: Float): Boolean {
        if (x < left || x > right || y < top || y > bottom) return false
        val topLeft = normalizedRadii[0]
        val topRight = normalizedRadii[1]
        val bottomRight = normalizedRadii[2]
        val bottomLeft = normalizedRadii[3]
        val (radius, centerX, centerY) = when {
            x < left + topLeft && y < top + topLeft ->
                Triple(topLeft, left + topLeft, top + topLeft)
            x > right - topRight && y < top + topRight ->
                Triple(topRight, right - topRight, top + topRight)
            x > right - bottomRight && y > bottom - bottomRight ->
                Triple(bottomRight, right - bottomRight, bottom - bottomRight)
            x < left + bottomLeft && y > bottom - bottomLeft ->
                Triple(bottomLeft, left + bottomLeft, bottom - bottomLeft)
            else -> return true
        }
        if (radius <= 0f) return true
        val dx = x - centerX
        val dy = y - centerY
        return dx * dx + dy * dy <= radius * radius
    }
}

internal data class RoundedOcclusionRect(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
    val cornerRadius: Float,
) {
    fun contains(x: Float, y: Float): Boolean {
        if (x < left || x > right || y < top || y > bottom) return false
        val radius =
            cornerRadius
                .coerceAtMost((right - left) / 2f)
                .coerceAtMost((bottom - top) / 2f)
        if (
            radius <= 0f ||
            x in (left + radius)..(right - radius) ||
            y in (top + radius)..(bottom - radius)
        ) {
            return true
        }
        val centerX = if (x < left + radius) left + radius else right - radius
        val centerY = if (y < top + radius) top + radius else bottom - radius
        val dx = x - centerX
        val dy = y - centerY
        return dx * dx + dy * dy <= radius * radius
    }
}

/**
 * Clips the native page to its rounded React host, then removes host-rendered
 * chrome while keeping the page full-size and live. Returning false outside
 * that outer clip or inside an occlusion lets the parent continue hit-testing
 * the Capacitor host WebView underneath.
 */
internal class OccludingSurfaceLayout(context: Context) : FrameLayout(context) {
    private var outerClip: RoundedOuterClip? = null
    private var occlusions: List<RoundedOcclusionRect> = emptyList()
    private val clipPath = Path()

    fun setOuterClip(clip: RoundedOuterClip?) {
        if (outerClip == clip) return
        outerClip = clip
        invalidate()
    }

    fun setOcclusions(rects: List<RoundedOcclusionRect>) {
        if (occlusions == rects) return
        occlusions = rects
        invalidate()
    }

    override fun dispatchDraw(canvas: Canvas) {
        if (outerClip == null && occlusions.isEmpty()) {
            super.dispatchDraw(canvas)
            return
        }
        val saveCount = canvas.save()
        outerClip?.let { clip ->
            clipPath.reset()
            clipPath.addRoundRect(
                RectF(clip.left, clip.top, clip.right, clip.bottom),
                clip.pathRadii(),
                Path.Direction.CW,
            )
            canvas.clipPath(clipPath)
        }
        for (rect in occlusions) {
            clipPath.reset()
            clipPath.addRoundRect(
                RectF(rect.left, rect.top, rect.right, rect.bottom),
                rect.cornerRadius,
                rect.cornerRadius,
                Path.Direction.CW,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                canvas.clipOutPath(clipPath)
            } else {
                @Suppress("DEPRECATION")
                canvas.clipPath(clipPath, Region.Op.DIFFERENCE)
            }
        }
        super.dispatchDraw(canvas)
        canvas.restoreToCount(saveCount)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (
            event.actionMasked == MotionEvent.ACTION_DOWN &&
            (outerClip?.contains(event.x, event.y) == false ||
                occlusions.any { it.contains(event.x, event.y) })
        ) {
            return false
        }
        return super.dispatchTouchEvent(event)
    }
}

internal fun findNearestFrameLayoutAncestor(view: View): FrameLayout? {
    var current = view.parent
    while (current is View) {
        if (current is FrameLayout) return current
        current = current.parent
    }
    return null
}

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
import java.security.MessageDigest

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
        val owner: String,
        val session: String,
        val profileName: String?,
        var foregrounded: Boolean,
        var disposed: Boolean = false,
        var x: Double = 0.0,
        var y: Double = 0.0,
        var outerClip: HostOuterClip? = null,
        var occlusions: List<HostOcclusionRect> = emptyList(),
    )

    private val surfaces = HashMap<String, Surface>()

    private fun density(): Float = activity.resources.displayMetrics.density

    private fun requireIdentity(call: PluginCall, operation: String): Pair<String, String>? {
        val owner = call.getString("owner")
        val session = call.getString("session")
        if (owner.isNullOrBlank() || session.isNullOrBlank()) {
            call.reject("$operation requires owner and session")
            return null
        }
        return Pair(owner, session)
    }

    private fun ownedSurface(
        call: PluginCall,
        id: String,
        owner: String,
        session: String,
        operation: String,
    ): Surface? {
        val surface = surfaces[id]
        if (surface == null) {
            call.reject("no surface $id")
            return null
        }
        if (surface.disposed) {
            call.reject("$operation cannot use surface $id while native teardown is incomplete")
            return null
        }
        if (surface.owner != owner || surface.session != session) {
            call.reject("$operation cannot mutate surface $id owned by another renderer session")
            return null
        }
        return surface
    }

    private fun digest(value: String): String = MessageDigest
        .getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun profileOwnerPrefix(owner: String): String =
        "eliza-browser-${digest(owner).take(16)}-"

    private fun profileName(owner: String, session: String, id: String): String =
        "${profileOwnerPrefix(owner)}${digest("$session\u0000$id").take(32)}"

    private fun disposeSurface(surface: Surface) {
        if (!surface.disposed) {
            surface.container.visibility = View.GONE
            surface.foregrounded = false
            surface.webView.stopLoading()
            (surface.container.parent as? ViewGroup)?.removeView(surface.container)
            surface.container.removeView(surface.webView)
            surface.webView.destroy()
            surface.disposed = true
        }
        surface.profileName?.let { name ->
            check(ProfileStore.getInstance().deleteProfile(name)) {
                "isolated Browser profile $name is still in use"
            }
        }
    }

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
        val identity = requireIdentity(call, "createSurface") ?: return
        val (owner, session) = identity
        val url = call.getString("url")

        activity.runOnUiThread {
            val existing = surfaces[id]
            if (existing != null) {
                if (existing.disposed) {
                    call.reject("surface $id is awaiting native teardown")
                    return@runOnUiThread
                }
                if (
                    existing.owner != owner || existing.session != session ||
                    existing.process != process || existing.storage != storage
                ) {
                    call.reject("surface $id already exists with different owner/session/policy")
                    return@runOnUiThread
                }
                if (url != null && existing.webView.url != url) existing.webView.loadUrl(url)
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
            var profileName: String? = null
            if (storage == "isolated") {
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                    webView.destroy()
                    call.reject("isolated storage requires WebView multi-profile support; system WebView is too old")
                    return@runOnUiThread
                }
                profileName = profileName(owner, session, id)
                val profile = ProfileStore.getInstance().getOrCreateProfile(profileName)
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
                try {
                    profileName?.let { name -> ProfileStore.getInstance().deleteProfile(name) }
                    call.reject("isolated process requires an out-of-process WebView renderer, which is unavailable on this device")
                } catch (error: RuntimeException) {
                    call.reject("isolated renderer creation failed and its profile could not be released", error)
                }
                return@runOnUiThread
            }

            surfaces[id] = Surface(
                container,
                webView,
                process,
                storage,
                owner,
                session,
                profileName,
                false,
            )
            call.resolve()
        }
    }

    @PluginMethod
    fun setBounds(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("setBounds requires an id")
            return
        }
        val identity = requireIdentity(call, "setBounds") ?: return
        val (owner, session) = identity
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
            val surface = ownedSurface(call, id, owner, session, "setBounds")
                ?: return@runOnUiThread
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
        val identity = requireIdentity(call, "setOcclusionRects") ?: return
        val (owner, session) = identity
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
            val surface = ownedSurface(call, id, owner, session, "setOcclusionRects")
                ?: return@runOnUiThread
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
        val identity = requireIdentity(call, "navigate") ?: return
        val (owner, session) = identity
        activity.runOnUiThread {
            val surface = ownedSurface(call, id, owner, session, "navigate")
                ?: return@runOnUiThread
            surface.webView.loadUrl(url)
            call.resolve()
        }
    }

    @PluginMethod
    fun reloadSurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("reloadSurface requires an id")
            return
        }
        val identity = requireIdentity(call, "reloadSurface") ?: return
        val (owner, session) = identity
        activity.runOnUiThread {
            val surface = ownedSurface(call, id, owner, session, "reloadSurface")
                ?: return@runOnUiThread
            surface.webView.reload()
            call.resolve()
        }
    }

    @PluginMethod
    fun presentSurface(call: PluginCall) {
        val identity = requireIdentity(call, "presentSurface") ?: return
        val (owner, session) = identity
        val id = call.getString("id")
        activity.runOnUiThread {
            val selected = id?.let {
                ownedSurface(call, it, owner, session, "presentSurface")
                    ?: return@runOnUiThread
            }
            for (surface in surfaces.values) {
                if (surface.owner == owner && surface.session == session) {
                    surface.container.visibility = View.GONE
                    surface.foregrounded = false
                }
            }
            selected?.let { surface ->
                surface.container.bringToFront()
                surface.container.visibility = View.VISIBLE
                surface.foregrounded = true
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun destroySurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("destroySurface requires an id")
            return
        }
        val identity = requireIdentity(call, "destroySurface") ?: return
        val (owner, session) = identity
        activity.runOnUiThread {
            val surface = surfaces[id]
            if (surface == null) {
                call.resolve()
                return@runOnUiThread
            }
            if (surface.owner != owner || surface.session != session) {
                call.reject("destroySurface cannot mutate surface $id owned by another renderer session")
                return@runOnUiThread
            }
            try {
                disposeSurface(surface)
                surfaces.remove(id)
                call.resolve()
            } catch (error: RuntimeException) {
                call.reject("destroySurface could not release surface $id", error)
            }
        }
    }

    @PluginMethod
    fun getSurfaceState(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("getSurfaceState requires an id")
            return
        }
        val identity = requireIdentity(call, "getSurfaceState") ?: return
        val (owner, session) = identity
        activity.runOnUiThread {
            val result = JSObject()
            val surface = surfaces[id]
            if (surface == null || surface.owner != owner || surface.session != session) {
                result.put("exists", false)
                result.put("foregrounded", false)
                result.put("currentUrl", JSObject.NULL)
                result.put("process", JSObject.NULL)
                result.put("storage", JSObject.NULL)
                result.put("owner", JSObject.NULL)
                result.put("session", JSObject.NULL)
            } else {
                result.put("exists", true)
                result.put("foregrounded", surface.foregrounded)
                result.put("currentUrl", surface.webView.url ?: JSObject.NULL)
                result.put("process", surface.process)
                result.put("storage", surface.storage)
                result.put("owner", surface.owner)
                result.put("session", surface.session)
            }
            call.resolve(result)
        }
    }

    @PluginMethod
    fun listSurfaceStates(call: PluginCall) {
        val identity = requireIdentity(call, "listSurfaceStates") ?: return
        val (owner, session) = identity
        activity.runOnUiThread {
            val surfacesResult = com.getcapacitor.JSArray()
            for ((id, surface) in surfaces) {
                if (surface.owner != owner || surface.session != session) continue
                surfacesResult.put(surfaceState(id, surface))
            }
            val result = JSObject()
            result.put("surfaces", surfacesResult)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun reconcileOwner(call: PluginCall) {
        val identity = requireIdentity(call, "reconcileOwner") ?: return
        val (owner, session) = identity
        val desiredArray = call.getArray("desiredIds") ?: run {
            call.reject("reconcileOwner requires desiredIds")
            return
        }
        val desiredIds = HashSet<String>()
        for (index in 0 until desiredArray.length()) {
            val id = desiredArray.optString(index, "")
            if (id.isBlank()) {
                call.reject("reconcileOwner desiredIds must contain strings")
                return
            }
            desiredIds.add(id)
        }
        activity.runOnUiThread {
            try {
                val staleIds = surfaces.entries
                    .filter { entry ->
                        val surface = entry.value
                        surface.owner == owner &&
                            (surface.session != session || !desiredIds.contains(entry.key))
                    }
                    .map { it.key }
                for (id in staleIds) {
                    val surface = surfaces.getValue(id)
                    disposeSurface(surface)
                    surfaces.remove(id)
                }
                if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                    val keepProfiles = desiredIds.mapTo(HashSet()) { id ->
                        profileName(owner, session, id)
                    }
                    val store = ProfileStore.getInstance()
                    val prefix = profileOwnerPrefix(owner)
                    for (name in store.allProfileNames) {
                        if (name.startsWith(prefix) && !keepProfiles.contains(name)) {
                            store.deleteProfile(name)
                        }
                    }
                }
                call.resolve()
            } catch (error: RuntimeException) {
                call.reject("reconcileOwner could not release stale Browser surfaces", error)
            }
        }
    }

    private fun surfaceState(id: String, surface: Surface): JSObject = JSObject().apply {
        put("id", id)
        put("exists", true)
        put("foregrounded", surface.foregrounded)
        put("currentUrl", surface.webView.url ?: JSObject.NULL)
        put("process", surface.process)
        put("storage", surface.storage)
        put("owner", surface.owner)
        put("session", surface.session)
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

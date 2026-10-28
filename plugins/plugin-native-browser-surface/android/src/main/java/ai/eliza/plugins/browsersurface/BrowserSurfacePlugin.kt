/**
 * Native Android half of `ElizaSurfaceManager` (#15245): layers one [WebView]
 * per Browser tab above the Capacitor host webview, each with a platform-managed
 * out-of-app renderer and its OWN storage partition. A computed outer clip
 * follows the rounded React host while independent rounded occlusion holes
 * expose host-rendered chrome without resizing or hiding the live page.
 *
 * Isolation maps onto two androidx.webkit primitives. Renderer: the WebView
 * renderer runs out-of-process by platform default on API 26+; Android may
 * reuse that sandboxed process across sibling WebViews, so `isolated` means
 * isolated from the app/host renderer rather than a guaranteed per-tab process.
 * The surface fails fast if even that platform boundary is unavailable.
 * Storage: an `isolated` surface gets its own multi-profile [androidx.webkit
 * Profile][ProfileStore] (cookies/localStorage/IndexedDB partitioned); a
 * `shared` surface uses the default profile. There is NO silent degrade — if the
 * system WebView is too old for multi-profile, `createSurface` rejects, because a
 * surface that quietly shares the default store is the exact leak this closes.
 * Android keeps a loaded profile in use after its WebView is destroyed, so a
 * retired profile is never reused: its cookies and storage are cleared at once,
 * deletion is retried until Android releases it, and anything left is purged
 * at the next process start. A `profileKey` selects one persistent profile per
 * owner and key instead, kept until `purgeProfiles` ([BrowserProfilePolicy]).
 *
 * A website never acts for the person through this layer: JavaScript dialogs,
 * new windows, downloads, other-app links and sign-in pages that refuse embedded
 * WebViews are reported to the host as events ([BrowserPageHandoffs]); nothing is
 * accepted, opened or started by itself. A crashed or killed page renderer
 * closes only its surface (`surfaceCrashed`), never the host activity.
 */
package ai.eliza.plugins.browsersurface

import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Region
import android.os.Build
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

internal data class NativeOwnerIdentity(
    val owner: String,
    val session: String,
    val epoch: Long,
)

internal class ActiveOwnerRegistry {
    private data class Lease(val session: String, val epoch: Long)

    private val leases = HashMap<String, Lease>()

    fun claim(identity: NativeOwnerIdentity): Boolean {
        val current = leases[identity.owner]
        if (
            current != null &&
            (identity.epoch < current.epoch ||
                (identity.epoch == current.epoch && identity.session != current.session))
        ) {
            return false
        }
        if (current == null || identity.epoch > current.epoch) {
            leases[identity.owner] = Lease(identity.session, identity.epoch)
        }
        return true
    }

    fun isActive(identity: NativeOwnerIdentity): Boolean {
        val current = leases[identity.owner] ?: return false
        return current.session == identity.session && current.epoch == identity.epoch
    }
}

internal fun supportsIsolatedRenderer(
    apiLevel: Int,
    rendererFeatureSupported: Boolean,
    rendererHandlePresent: Boolean,
): Boolean =
    apiLevel >= Build.VERSION_CODES.O && rendererFeatureSupported && rendererHandlePresent

internal fun supportsIsolatedStorage(multiProfileFeatureSupported: Boolean): Boolean =
    multiProfileFeatureSupported

@CapacitorPlugin(name = "ElizaSurfaceManager")
class ElizaSurfaceManagerPlugin : Plugin() {
    private var helperEntry: BrowserHelperEntry? = null
    private fun entry(): BrowserHelperEntry = helperEntry ?: BrowserHelperEntry(activity, bridge.webView,
        { notifyListeners("browserHelperReturned", JSObject().apply { put("presentation", "full-screen") }) },
        { notifyListeners("browserHelperReturnFailed", JSObject().apply { put("code", "BROWSER_ENTRY_UNAVAILABLE") }) },
        {
            notifyListeners("browserHelperWindowClosed", JSObject().apply { put("reason", "permission-revoked") })
            dockScope.launch {
                try { BrowserDockController.setVisible(activity, true) }
                catch (error: kotlinx.coroutines.CancellationException) { throw error }
                catch (error: RuntimeException) {
                    // error-policy:J1 A changed split cannot be recreated by replaying navigation.
                    notifyListeners("browserHelperReturnFailed", JSObject().apply { put("code", "BROWSER_DOCK_RESTORE_UNAVAILABLE") })
                }
            }
        }
    ).also { helperEntry = it }

    @PluginMethod
    fun getBrowserHelperEntryState(call: PluginCall) {
        activity.runOnUiThread { call.resolve(entry().state()) }
    }

    @PluginMethod
    fun requestBrowserHelperEntryPermission(call: PluginCall) {
        activity.runOnUiThread {
            try {
                activity.startActivity(android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + activity.packageName)))
                call.resolve(JSObject().apply { put("status", "dispatched") })
            } catch (error: android.content.ActivityNotFoundException) {
                // error-policy:J1 Managed devices may omit the permission screen.
                call.reject("Android overlay settings are unavailable.", "BROWSER_ENTRY_SETTINGS_UNAVAILABLE", error)
            }
        }
    }

    @PluginMethod
    fun hideBrowserDockWithEntry(call: PluginCall) {
        val label = call.getString("label") ?: "Helper"
        val description = call.getString("description") ?: "Return to helper"
        dockScope.launch {
            try {
                val control = entry()
                control.showEntry(label, description)
                BrowserDockController.setVisible(activity, false)
                control.removeFullScreen()
                call.resolve(JSObject().apply { put("status", "requested") })
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: RuntimeException) {
                // error-policy:J1 Never hide the host when a return control cannot be installed.
                helperEntry?.removeEntry()
                call.reject("The helper could not be hidden with a return control.",
                    (error as? BrowserLaunchException)?.code ?: "BROWSER_ENTRY_UNAVAILABLE", error)
            }
        }
    }

    @PluginMethod
    fun restoreBrowserDockFromEntry(call: PluginCall) {
        dockScope.launch {
            try {
                BrowserDockController.setVisible(activity, true)
                helperEntry?.removeFullScreen()
                helperEntry?.removeEntry()
                call.resolve(JSObject().apply { put("status", "requested") })
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: RuntimeException) {
                // error-policy:J1 Leave full-screen help visible if its browser split cannot return.
                call.reject("The browser split could not be restored.",
                    (error as? BrowserLaunchException)?.code ?: "BROWSER_DOCK_RESIZE_UNAVAILABLE", error)
            }
        }
    }

    private val dockScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun handleOnResume() {
        super.handleOnResume()
        helperEntry?.reconcilePermission()
    }

    override fun handleOnPause() {
        surfaces.values.forEach {
            it.historyObservation = null
            it.control?.interrupt("The browser host was paused")
        }
        super.handleOnPause()
    }

    override fun handleOnDestroy() {
        keyboardListener?.let { activity.window.decorView.viewTreeObserver.removeOnGlobalLayoutListener(it) }
        keyboardListener = null
        surfaces.values.forEach(::disposeSurface)
        surfaces.clear()
        dockScope.cancel()
        helperEntry?.destroy()
        helperEntry = null
        BrowserDockController.release(activity)
        super.handleOnDestroy()
    }

    @PluginMethod
    fun setBrowserDockVisible(call: PluginCall) {
        val visible = call.getBoolean("visible") ?: run { call.reject("Visibility is required.", "BROWSER_DOCK_VISIBILITY_INVALID"); return }
        dockScope.launch {
            try {
                BrowserDockController.setVisible(activity, visible)
                call.resolve(JSObject().apply { put("status", "requested") })
            } catch (error: BrowserLaunchException) {
                // error-policy:J1 Unsupported or changed sessions must not navigate as a fallback.
                call.reject(error.message, error.code, error)
            } catch (error: UnsupportedOperationException) {
                // error-policy:J1 Runtime extension support may differ from advertised capability.
                call.reject("Android cannot resize this split.", "BROWSER_DOCK_RESIZE_UNAVAILABLE", error)
            } catch (error: SecurityException) {
                // error-policy:J1 Keep Android's cross-application window boundary intact.
                call.reject("Android denied resizing this split.", "BROWSER_DOCK_RESIZE_DENIED", error)
            }
        }
    }

    @PluginMethod
    fun getBrowserDockState(call: PluginCall) {
        activity.runOnUiThread { call.resolve(BrowserDockController.state(activity)) }
    }

    @PluginMethod
    fun openDockedBrowser(call: PluginCall) {
        val url = call.getString("url") ?: run { call.reject("URL is required.", "BROWSER_URL_INVALID"); return }
        val width = call.getInt("panelWidthDp", 400) ?: 400
        activity.runOnUiThread {
            try {
                BrowserDockController.open(activity, url, width)
                helperEntry?.release()
                notifyListeners("browserHelperWindowClosed", JSObject().apply { put("reason", "website-opened") })
                call.resolve(JSObject().apply { put("packageName", ChromiumBrowserLauncher.PACKAGE_NAME); put("status", "dispatched") })
            } catch (error: BrowserLaunchException) {
                // error-policy:J1 Host support, identity or size can prevent docking.
                call.reject(error.message, error.code, error)
            } catch (error: android.content.ActivityNotFoundException) {
                // error-policy:J1 Installation can change between validation and dispatch.
                call.reject("Chromium is unavailable.", "BROWSER_UNAVAILABLE", error)
            } catch (error: SecurityException) {
                // error-policy:J1 Never broaden permissions to force a dock.
                call.reject("Android prevented browser docking.", "BROWSER_LAUNCH_DENIED", error)
            }
        }
    }

    @PluginMethod
    fun presentBrowser(call: PluginCall) {
        activity.runOnUiThread {
            try {
                BrowserDockController.present(activity)
                call.resolve(JSObject().apply { put("packageName", ChromiumBrowserLauncher.PACKAGE_NAME) })
            } catch (error: BrowserLaunchException) {
                // error-policy:J1 Presentation is denied when provisioned identity is unavailable.
                call.reject(error.message, error.code, error)
            } catch (error: android.content.ActivityNotFoundException) {
                // error-policy:J1 The verified activity may disappear before dispatch.
                call.reject("Chromium is unavailable.", "BROWSER_UNAVAILABLE", error)
            } catch (error: SecurityException) {
                // error-policy:J1 Never broaden permissions to force foreground presentation.
                call.reject("Android prevented browser presentation.", "BROWSER_LAUNCH_DENIED", error)
            }
        }
    }

    @PluginMethod
    fun openBrowser(call: PluginCall) {
        val url = call.getString("url") ?: run {
            call.reject("openBrowser requires a website address", "INVALID_BROWSER_URL")
            return
        }
        activity.runOnUiThread {
            try {
                ChromiumBrowserLauncher.launch(activity, url)
                call.resolve(JSObject().apply {
                    put("packageName", ChromiumBrowserLauncher.PACKAGE_NAME)
                    put("engine", "chromium")
                    put("surface", "custom-tab")
                })
            } catch (error: BrowserLaunchException) {
                // error-policy:J1 Native dispatch failures become explicit bridge errors.
                call.reject(error.message, error.code, error)
            } catch (error: android.content.ActivityNotFoundException) {
                // error-policy:J1 The provider may disappear between resolution and launch.
                call.reject("Chromium is unavailable. Repair the system browser and try again.", "BROWSER_UNAVAILABLE", error)
            } catch (error: SecurityException) {
                // error-policy:J1 Android policy may forbid the selected browser activity.
                call.reject("Android prevented Chromium from opening this website.", "BROWSER_LAUNCH_DENIED", error)
            }
        }
    }

    private companion object {
        const val TAG = "ElizaSurfaceManager"
        const val PROFILE_PREFS = "eliza_browser_surface_profiles"
    }

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
        val epoch: Long,
        val profileName: String?,
        var foregrounded: Boolean,
        var control: SurfaceControlChannel? = null,
        var disposed: Boolean = false,
        var pageRevision: Long = 0,
        var historyObservation: HistoryObservation? = null,
        var pageError: String? = null,
        var x: Double = 0.0,
        var y: Double = 0.0,
        var outerClip: HostOuterClip? = null,
        var occlusions: List<HostOcclusionRect> = emptyList(),
        /** Cross-origin main-frame navigations wait for the host (BrowserNavigationPolicy). */
        val interceptNavigation: Boolean = false,
        /** Page dialogs waiting for the host's answer; dismissed whenever nobody can answer. */
        val dialogs: BrowserPageHandoffs.Dialogs<JsResult> = BrowserPageHandoffs.Dialogs(),
        /** The one other-app link the page asked for with a tap; `openExternalLink` may open only it. */
        var pendingExternalLink: String? = null,
        /** Main-frame requests WebView sends without asking shouldOverrideUrlLoading (POST, history). */
        val gate: BrowserMainFrameGate = BrowserMainFrameGate(),
        /** Set for a persistent keyed profile, which outlives the surface. */
        val profileKey: String? = null,
    )

    private data class HistoryObservation(
        val reference: String,
        val revision: Long,
        val index: Int,
        val urls: List<Pair<String?, String?>>,
        val expiresAt: Long,
    )

    private fun historyUrls(view: WebView): List<Pair<String?, String?>> {
        val history = view.copyBackForwardList()
        return (0 until history.size).map {
            history.getItemAtIndex(it).let { entry -> entry.url to entry.originalUrl }
        }
    }

    private fun historyReady(surface: Surface): Boolean =
        !surface.disposed && surface.foregrounded && surface.pageError == null &&
        surface.webView.progress == 100 &&
        activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

    private val surfaces = HashMap<String, Surface>()
    private var keyboardListener: ViewTreeObserver.OnGlobalLayoutListener? = null
    private var keyboardVisible = false
    private val activeOwners = ActiveOwnerRegistry()
    private val retiredProfiles = HashSet<String>()
    private val profileProcessNonce = UUID.randomUUID().toString()
    private var profileSerial = 0L
    private val pageReader by lazy {
        context.assets.open("read-page.js").bufferedReader().use { it.readText() }
    }
    private val pageControl by lazy {
        context.assets.open("control-channel.js").bufferedReader().use { it.readText() }
    }
    private val captureMask by lazy {
        context.assets.open("capture-mask.js").bufferedReader().use { it.readText() }
    }
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
    /** Last use of each keyed profile ("used:<name>") and purges still to finish ("purge:<name>"). */
    private val profilePrefs by lazy { context.getSharedPreferences(PROFILE_PREFS, Context.MODE_PRIVATE) }

    override fun load() {
        super.load()
        // Observe the root insets instead of installing an insets listener, which would
        // replace the host's own. The host moves its controls above the keyboard.
        activity.runOnUiThread {
            val decor = activity.window.decorView
            keyboardListener = ViewTreeObserver.OnGlobalLayoutListener {
                val insets = ViewCompat.getRootWindowInsets(decor) ?: return@OnGlobalLayoutListener
                val visible = insets.isVisible(WindowInsetsCompat.Type.ime())
                if (visible == keyboardVisible) return@OnGlobalLayoutListener
                keyboardVisible = visible
                val height = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom / density()
                notifyListeners("keyboardChanged", JSObject().apply {
                    put("visible", visible)
                    put("height", if (visible) height.toDouble() else 0.0)
                })
            }.also { decor.viewTreeObserver.addOnGlobalLayoutListener(it) }
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        val store = ProfileStore.getInstance()
        for (name in store.allProfileNames) {
            val purge = BrowserProfilePolicy.ephemeral(name) ||
                (BrowserProfilePolicy.keyed(name) && profilePrefs.getBoolean("purge:$name", false))
            if (!purge) continue
            try {
                store.deleteProfile(name)
                profilePrefs.edit().remove("purge:$name").apply()
            } catch (error: RuntimeException) {
                Log.w(TAG, "Could not purge retired Browser profile", error)
            }
        }
    }

    private fun density(): Float = activity.resources.displayMetrics.density

    private fun requireIdentity(call: PluginCall, operation: String): NativeOwnerIdentity? {
        val owner = call.getString("owner")
        val session = call.getString("session")
        // JSON encodes small JavaScript integers as Integer, while Capacitor's
        // getLong accepts only Long. Validate the numeric boundary explicitly.
        val number = call.data.opt("epoch") as? Number
        val numericEpoch = number?.toDouble()
        val epoch = if (numericEpoch != null && numericEpoch.isFinite() &&
            numericEpoch >= 1.0 && numericEpoch <= 9_007_199_254_740_991.0 &&
            numericEpoch == kotlin.math.floor(numericEpoch)) numericEpoch.toLong() else null
        if (owner.isNullOrBlank() || session.isNullOrBlank() || epoch == null || epoch <= 0L) {
            call.reject("$operation requires owner, session, and a positive epoch")
            return null
        }
        return NativeOwnerIdentity(owner, session, epoch)
    }

    private fun requireActiveIdentity(call: PluginCall, operation: String): NativeOwnerIdentity? {
        val identity = requireIdentity(call, operation) ?: return null
        if (!activeOwners.isActive(identity)) {
            call.reject("$operation rejected a retired or unclaimed renderer session")
            return null
        }
        return identity
    }

    private fun ownedSurface(
        call: PluginCall,
        id: String,
        identity: NativeOwnerIdentity,
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
        if (
            surface.owner != identity.owner ||
            surface.session != identity.session ||
            surface.epoch != identity.epoch
        ) {
            call.reject("$operation cannot mutate surface $id owned by another renderer session")
            return null
        }
        return surface
    }

    private fun digest(value: String): String = MessageDigest
        .getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun profileName(owner: String, session: String, epoch: Long, id: String): String {
        profileSerial += 1
        return "${BrowserProfilePolicy.EPHEMERAL_PREFIX}${digest("$profileProcessNonce\u0000$owner\u0000$session\u0000$epoch\u0000$id\u0000$profileSerial").take(48)}"
    }

    /** The same owner and key always name the same profile; the key itself is never stored. */
    private fun keyedProfileName(owner: String, key: String): String =
        "${BrowserProfilePolicy.KEYED_PREFIX}${digest("keyed\u0000$owner\u0000$key").take(48)}"

    private fun touchProfile(name: String) {
        profilePrefs.edit().putLong("used:$name", System.currentTimeMillis()).apply()
    }

    /** Signs the profile out of every website now; the directory goes once Android releases it. */
    private fun clearProfileData(name: String, done: (() -> Unit)? = null) {
        val profile = try {
            ProfileStore.getInstance().getProfile(name)
        } catch (error: RuntimeException) {
            // error-policy:J1 A profile that cannot be opened is left to the start-up purge.
            Log.w(TAG, "Could not open a Browser profile to clear it", error)
            null
        }
        if (profile == null) {
            done?.invoke()
            return
        }
        profile.webStorage.deleteAllData()
        profile.geolocationPermissions.clearAll()
        profile.cookieManager.removeAllCookies { profile.cookieManager.flush(); done?.invoke() }
    }

    private fun retireProfile(name: String) {
        retiredProfiles.add(name)
        clearProfileData(name)
        deleteWhenReleased(name, 0)
    }

    private fun deleteWhenReleased(name: String, attempt: Int) {
        mainHandler.postDelayed({
            // A keyed profile opened again since its purge is in use and already empty.
            if (surfaces.values.any { it.profileName == name && !it.disposed }) return@postDelayed
            val deleted = try {
                ProfileStore.getInstance().deleteProfile(name)
                true
            } catch (error: IllegalStateException) {
                false // Android has not released it yet.
            } catch (error: RuntimeException) {
                // error-policy:J1 Left for the start-up purge; its data is already cleared.
                Log.w(TAG, "Could not delete a retired Browser profile", error)
                return@postDelayed
            }
            if (deleted) {
                retiredProfiles.remove(name)
                profilePrefs.edit().remove("purge:$name").remove("used:$name").apply()
            } else if (attempt + 1 < BrowserProfilePolicy.DELETE_RETRY_MS.size) {
                deleteWhenReleased(name, attempt + 1)
            }
        }, BrowserProfilePolicy.DELETE_RETRY_MS[attempt])
    }

    /** Ephemeral profiles go now; keyed ones stay for the next opening. */
    private fun releaseProfile(surface: Surface) {
        val name = surface.profileName ?: return
        if (surface.profileKey == null) retireProfile(name) else touchProfile(name)
    }

    private fun purgeKeyedProfile(name: String) {
        profilePrefs.edit().putBoolean("purge:$name", true).remove("used:$name").apply()
        retireProfile(name)
    }

    private fun isLive(surface: Surface): Boolean =
        !surface.disposed && activeOwners.isActive(NativeOwnerIdentity(surface.owner, surface.session, surface.epoch))

    private fun surfaceEvent(id: String, surface: Surface): JSObject = JSObject().apply {
        put("id", id)
        put("owner", surface.owner)
        put("session", surface.session)
        put("epoch", surface.epoch)
    }

    /** A dialog nobody will answer is dismissed: alert/confirm/prompt cancel, never accept. */
    private fun dismissDialogs(surface: Surface) {
        surface.dialogs.drain().forEach { it.cancel() }
    }

    /**
     * Main-frame addresses this surface never loads: other-app links and sign-in pages that
     * refuse embedded WebViews. Each is reported once for the host to handle; returns true when
     * the navigation must be cancelled.
     */
    private fun handOff(id: String, surface: Surface, target: String, userGesture: Boolean): Boolean {
        BrowserPageHandoffs.identityProvider(target)?.let { provider ->
            if (isLive(surface)) {
                notifyListeners("identityProviderRequested", surfaceEvent(id, surface).apply {
                    put("provider", provider)
                    put("url", target)
                })
            }
            return true
        }
        if (!BrowserExternalLinkPolicy.external(target)) return false
        var action: String? = null
        var dataScheme: String? = null
        var targetPackage: String? = null
        var fallback: String? = null
        if (target.regionMatches(0, "intent:", 0, 7, ignoreCase = true)) {
            try {
                val parsed = Intent.parseUri(target, Intent.URI_INTENT_SCHEME)
                action = parsed.action
                dataScheme = parsed.data?.scheme
                targetPackage = parsed.`package`
                fallback = BrowserExternalLinkPolicy.fallback(parsed.getStringExtra("browser_fallback_url"))
            } catch (error: java.net.URISyntaxException) {
                // error-policy:J1 A malformed intent link is refused, never guessed at.
                action = "invalid"
            }
        }
        val handoff = BrowserExternalLinkPolicy.decide(target, userGesture, action, dataScheme,
            targetPackage, activity.packageName, setOf("capacitor"))
        surface.pendingExternalLink = if (handoff == BrowserExternalLinkPolicy.Handoff.REFUSE) null else target
        // A script's attempt to leave for another app is dropped without a word.
        if (userGesture && isLive(surface)) {
            notifyListeners("externalLinkRequested", surfaceEvent(id, surface).apply {
                put("url", target)
                put("handoff", handoff.name.lowercase().replace('_', '-'))
                put("fallbackUrl", fallback ?: JSObject.NULL)
            })
        }
        return true
    }

    /** Holds a page dialog for an intercepting host's answer, or dismisses it when nobody can answer. */
    private fun holdDialog(
        id: String,
        view: WebView,
        kind: BrowserPageHandoffs.DialogKind,
        message: String?,
        defaultValue: String?,
        result: JsResult,
    ): Boolean {
        val surface = surfaces[id]
        // Only an intercepting host answers dialogs; any other surface dismisses them as before.
        if (surface == null || surface.webView !== view || !surface.interceptNavigation ||
            !BrowserPageHandoffs.dialogMayWait(isLive(surface), surface.foregrounded, surface.dialogs.size())) {
            result.cancel()
            return true
        }
        val dialogId = surface.dialogs.open(result)
        notifyListeners("dialogRequested", surfaceEvent(id, surface).apply {
            put("dialogId", dialogId)
            put("kind", kind.wire)
            put("message", BrowserPageHandoffs.text(message))
            if (kind == BrowserPageHandoffs.DialogKind.PROMPT) put("defaultText", BrowserPageHandoffs.text(defaultValue))
            put("url", view.url ?: JSObject.NULL)
        })
        return true
    }

    private fun disposeSurface(surface: Surface) {
        dismissDialogs(surface)
        surface.pendingExternalLink = null
        if (!surface.disposed) {
            surface.historyObservation = null
            surface.control?.interrupt("The native page was closed", navigation = true)
            surface.container.visibility = View.GONE
            surface.foregrounded = false
            surface.webView.stopLoading()
            (surface.container.parent as? ViewGroup)?.removeView(surface.container)
            surface.container.removeView(surface.webView)
            surface.webView.destroy()
            surface.disposed = true
        }
        releaseProfile(surface)
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
        val url = call.getString("url")
        val interceptNavigation = call.getBoolean("interceptNavigation", false) ?: false
        val profileKey = call.getString("profileKey")
        if (profileKey != null && (storage != "isolated" || !BrowserProfilePolicy.validKey(profileKey))) {
            call.reject("createSurface profileKey needs isolated storage and 1 to 128 plain characters")
            return
        }

        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "createSurface") ?: return@runOnUiThread
            val owner = identity.owner
            val session = identity.session
            val existing = surfaces[id]
            if (existing != null) {
                if (existing.disposed) {
                    call.reject("surface $id is awaiting native teardown")
                    return@runOnUiThread
                }
                if (
                    existing.owner != owner || existing.session != session ||
                    existing.epoch != identity.epoch ||
                    existing.process != process || existing.storage != storage ||
                    existing.interceptNavigation != interceptNavigation ||
                    existing.profileKey != profileKey
                ) {
                    call.reject("surface $id already exists with different owner/session/policy")
                    return@runOnUiThread
                }
                if (url != null && existing.webView.url != url) {
                    existing.gate.approve(url)
                    existing.webView.loadUrl(url)
                }
                call.resolve()
                return@runOnUiThread
            }
            val host = findNearestFrameLayoutAncestor(bridge.webView) ?: run {
                call.reject("host webview has no FrameLayout ancestor to attach the surface to")
                return@runOnUiThread
            }

            val container = OccludingSurfaceLayout(activity)
            val webView = WebView(activity)
            val gate = BrowserMainFrameGate()
            webView.webViewClient = object : WebViewClient() {
                // loadUrl() (the host's navigate) never reaches this callback, so an approved
                // address is not intercepted again. POST form submissions do not reach it either;
                // shouldInterceptRequest holds those. A server redirect does: one that continues
                // the host's approved navigation goes on; any other is decided like a link, and a
                // held redirect ends that approval (BrowserMainFrameGate).
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val surface = surfaces[id]
                    if (surface == null || surface.webView !== view) return false
                    val target = request.url.toString()
                    if (request.isForMainFrame && handOff(id, surface, target, request.hasGesture())) return true
                    if (!surface.interceptNavigation) return false
                    val redirect = request.isRedirect && request.isForMainFrame
                    if (redirect && surface.gate.redirect(target)) return false
                    return when (BrowserNavigationPolicy.decide(view.url, target, request.isForMainFrame, surface.gate.taskOrigins())) {
                        BrowserNavigationPolicy.Decision.ALLOW -> false
                        BrowserNavigationPolicy.Decision.BLOCK -> {
                            if (redirect) surface.gate.settle(null)
                            true
                        }
                        BrowserNavigationPolicy.Decision.REQUEST -> {
                            if (redirect) surface.gate.settle(null)
                            if (isLive(surface)) {
                                notifyListeners("navigationRequested", surfaceEvent(id, surface).apply {
                                    put("url", target)
                                    put("redirect", request.isRedirect)
                                    put("userGesture", request.hasGesture())
                                    put("method", "GET")
                                })
                            }
                            true
                        }
                    }
                }

                // Network thread. A main-frame request to an origin the host has not approved
                // gets a local empty 204, which ends the navigation without sending anything.
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    if (!interceptNavigation || !request.isForMainFrame) return null
                    val target = request.url.toString()
                    if (gate.admit(target)) return null
                    val method = request.method ?: "GET"
                    val gesture = request.hasGesture()
                    view.post {
                        val surface = surfaces[id]
                        if (surface != null && surface.webView === view && isLive(surface)) {
                            notifyListeners("navigationRequested", surfaceEvent(id, surface).apply {
                                put("url", target)
                                put("redirect", false)
                                put("userGesture", gesture)
                                // A held POST is not replayed: navigate() loads the address with GET.
                                put("method", method.uppercase())
                            })
                        }
                    }
                    return WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(),
                        ByteArrayInputStream(ByteArray(0)))
                }

                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                    surfaces.values.firstOrNull { it.webView === view }?.let {
                        it.control?.interrupt("The native page navigated", navigation = true)
                        it.historyObservation = null
                        it.pageRevision += 1
                        it.pageError = null
                        dismissDialogs(it)
                        it.pendingExternalLink = null
                    }
                    gate.commit(url)
                }

                // History traversal must never silently resubmit a payment/form POST.
                override fun onFormResubmission(view: WebView, dontResend: android.os.Message, resend: android.os.Message) {
                    dontResend.sendToTarget()
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) {
                        surfaces.values.firstOrNull { it.webView === view }?.pageError = error.description.toString()
                    }
                }

                override fun onPageFinished(view: WebView, url: String) {
                    gate.settle(url)
                    val surface = surfaces[id] ?: return
                    if (surface.webView !== view || surface.disposed || view.url != url) return
                    if (!isLive(surface)) return
                    notifyListeners("navigationChanged", surfaceEvent(id, surface))
                }

                // Same-document moves (pushState, fragments) change the address and history
                // without a page load; the host re-reads state as it does after a load.
                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                    val surface = surfaces[id] ?: return
                    if (surface.webView !== view) return
                    surface.historyObservation = null
                    surface.pageRevision += 1
                    if (isReload || !isLive(surface) || view.progress < 100) return
                    gate.commit(url)
                    notifyListeners("navigationChanged", surfaceEvent(id, surface))
                }

                // Returning true keeps the host activity alive when this page's renderer crashes or
                // Android reclaims it. The WebView is unusable afterwards, so only its surface closes.
                // Android calls this only on API 26+, where RenderProcessGoneDetail exists.
                @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    val surface = surfaces[id]
                    if (surface == null || surface.webView !== view) {
                        (view.parent as? ViewGroup)?.removeView(view)
                        view.destroy()
                        return true
                    }
                    val url = view.url
                    val live = isLive(surface)
                    try {
                        disposeSurface(surface)
                    } catch (error: RuntimeException) {
                        // error-policy:J1 A dead renderer must never take the host down with it.
                        Log.w(TAG, "Could not release crashed Browser surface", error)
                    }
                    surfaces.remove(id)
                    if (live) {
                        notifyListeners("surfaceCrashed", surfaceEvent(id, surface).apply {
                            put("didCrash", detail.didCrash())
                            put("url", url ?: JSObject.NULL)
                        })
                    }
                    return true
                }
            }
            webView.webChromeClient = object : WebChromeClient() {
                override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult) =
                    holdDialog(id, view, BrowserPageHandoffs.DialogKind.ALERT, message, null, result)

                override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult) =
                    holdDialog(id, view, BrowserPageHandoffs.DialogKind.CONFIRM, message, null, result)

                override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult) =
                    holdDialog(id, view, BrowserPageHandoffs.DialogKind.PROMPT, message, defaultValue, result)

                override fun onJsBeforeUnload(view: WebView, url: String?, message: String?, result: JsResult) =
                    holdDialog(id, view, BrowserPageHandoffs.DialogKind.BEFORE_UNLOAD, message, null, result)

                // A new window never opens by itself. A tapped window's address is caught by a
                // throwaway WebView that never loads it, then reported for the host to check.
                override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                    val surface = surfaces[id] ?: return false
                    if (surface.webView !== view || !isLive(surface) || !isUserGesture) return false
                    val catcher = WebView(activity)
                    surface.profileName?.let { WebViewCompat.setProfile(catcher, it) }
                    catcher.settings.javaScriptEnabled = false
                    var settled = false
                    fun settle(target: String?) {
                        if (settled) return
                        settled = true
                        catcher.post { catcher.stopLoading(); catcher.destroy() }
                        val current = surfaces[id]
                        if (target == null || current !== surface || !isLive(surface)) return
                        if (handOff(id, surface, target, true)) return
                        if (BrowserPageHandoffs.window(true, target) != BrowserPageHandoffs.WindowDecision.REQUEST) return
                        if (surface.interceptNavigation) {
                            notifyListeners("navigationRequested", surfaceEvent(id, surface).apply {
                                put("url", target)
                                put("redirect", false)
                                put("userGesture", true)
                                put("method", "GET")
                                put("newWindow", true)
                            })
                        } else {
                            // Without interception a tapped window opened in place before, so it still does.
                            surface.gate.approve(target)
                            surface.webView.loadUrl(target)
                        }
                    }
                    catcher.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                            settle(request.url.toString())
                            return true
                        }

                        override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? {
                            if (!request.isForMainFrame) return null
                            val target = request.url.toString()
                            v.post { settle(target) }
                            return WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(),
                                ByteArrayInputStream(ByteArray(0)))
                        }

                        @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
                        override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                            settle(null)
                            return true
                        }
                    }
                    // about:blank windows written by script never name an address; drop them.
                    catcher.postDelayed({ settle(null) }, 3000)
                    (resultMsg.obj as WebView.WebViewTransport).webView = catcher
                    resultMsg.sendToTarget()
                    return true
                }
            }
            webView.setDownloadListener { downloadUrl, _, contentDisposition, mimeType, contentLength ->
                val surface = surfaces[id]
                if (surface == null || surface.webView !== webView || !isLive(surface)) return@setDownloadListener
                val download = BrowserPageHandoffs.Download(downloadUrl,
                    URLUtil.guessFileName(downloadUrl, contentDisposition, mimeType), mimeType, contentLength)
                notifyListeners("downloadRequested", surfaceEvent(id, surface).apply {
                    put("url", download.url ?: JSObject.NULL)
                    put("fileName", download.fileName)
                    put("mimeType", download.mimeType)
                    put("contentLength", download.contentLength)
                    put("pdf", download.pdf)
                })
            }
            webView.settings.setSupportMultipleWindows(true)
            webView.settings.javaScriptCanOpenWindowsAutomatically = false
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
                if (
                    !supportsIsolatedStorage(
                        WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
                    )
                ) {
                    webView.destroy()
                    call.reject("isolated storage requires WebView multi-profile support; system WebView is too old")
                    return@runOnUiThread
                }
                profileName = if (profileKey == null) profileName(owner, session, identity.epoch, id)
                    else keyedProfileName(owner, profileKey).also {
                        // A purge that could not delete it yet already cleared it; it starts a new life.
                        retiredProfiles.remove(it)
                        profilePrefs.edit().remove("purge:$it").apply()
                        touchProfile(it)
                    }
                val profile = ProfileStore.getInstance().getOrCreateProfile(profileName)
                WebViewCompat.setProfile(webView, profile.name)
            }
            // shared storage ⇒ the default profile (host-scoped store).

            val lp = FrameLayout.LayoutParams(0, 0)
            host.addView(container, lp)
            container.visibility = View.GONE
            val control = try {
                if (SurfaceControlChannel.supported()) SurfaceControlChannel(webView, pageControl) else null
            } catch (error: Exception) {
                host.removeView(container)
                webView.destroy()
                if (profileKey == null) profileName?.let(::retireProfile)
                call.reject("Could not install isolated browser control", error)
                return@runOnUiThread
            }
            if (url != null) {
                gate.approve(url)
                webView.loadUrl(url)
            }

            // The renderer handle proves separation from the app process, which
            // is the strongest Android WebView guarantee. Android may reuse the
            // sandboxed renderer between WebViews, so this does not claim a
            // permanent per-tab crash boundary.
            val rendererFeatureSupported =
                WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_RENDERER)
            val rendererHandlePresent = rendererFeatureSupported &&
                WebViewCompat.getWebViewRenderProcess(webView) != null
            if (
                process == "isolated" &&
                !supportsIsolatedRenderer(
                    Build.VERSION.SDK_INT,
                    rendererFeatureSupported,
                    rendererHandlePresent,
                )
            ) {
                host.removeView(container)
                webView.destroy()
                try {
                    if (profileKey == null) profileName?.let(::retireProfile)
                    call.reject("isolated process policy requires an out-of-app WebView renderer, which is unavailable on this device")
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
                identity.epoch,
                profileName,
                false,
                control,
                interceptNavigation = interceptNavigation,
                gate = gate,
                profileKey = profileKey,
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
            val identity = requireActiveIdentity(call, "setBounds") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "setBounds")
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
            val identity = requireActiveIdentity(call, "setOcclusionRects") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "setOcclusionRects")
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
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "navigate") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "navigate")
                ?: return@runOnUiThread
            // A sign-in page that refuses WebViews is reported instead of showing its error page.
            if (BrowserPageHandoffs.identityProvider(url) == null) {
                surface.historyObservation = null
                surface.gate.approve(url)
                surface.webView.loadUrl(url)
            } else {
                handOff(id, surface, url, true)
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun reloadSurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("reloadSurface requires an id")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "reloadSurface") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "reloadSurface")
                ?: return@runOnUiThread
            surface.historyObservation = null
            surface.webView.reload()
            call.resolve()
        }
    }

    @PluginMethod
    fun goBack(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("goBack requires an id")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "goBack") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "goBack") ?: return@runOnUiThread
            if (surface.webView.canGoBack()) {
                surface.historyObservation = null
                approveHistoryStep(surface, -1)
                surface.webView.goBack()
            }
            call.resolve()
        }
    }

    /** Trusted host primitive; task authorization and preview belong to the caller. */
    @PluginMethod
    fun observeHistory(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("observeHistory requires an id", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "observeHistory") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "observeHistory") ?: return@runOnUiThread
            surface.historyObservation = null
            if (!historyReady(surface)) {
                call.reject("The native page is unavailable for history observation", "UNAVAILABLE")
                return@runOnUiThread
            }
            val history = surface.webView.copyBackForwardList()
            val observation = HistoryObservation(UUID.randomUUID().toString(), surface.pageRevision,
                history.currentIndex, historyUrls(surface.webView), android.os.SystemClock.elapsedRealtime() + 30_000)
            surface.historyObservation = observation
            val destinations = org.json.JSONArray()
            for ((direction, offset) in listOf("back" to -1, "forward" to 1)) {
                val index = history.currentIndex + offset
                if (index < 0 || index >= history.size) continue
                val entry = history.getItemAtIndex(index)
                if (!BrowserWebOrigin.sameOrigin(surface.webView.url, entry.url)) continue
                destinations.put(JSObject().apply {
                    put("reference", "${observation.reference}:$direction")
                    put("direction", direction)
                    put("url", entry.url)
                    put("title", entry.title ?: "")
                })
            }
            call.resolve(JSObject().apply { put("destinations", destinations) })
        }
    }

    @PluginMethod
    fun navigateHistory(call: PluginCall) {
        val id = call.getString("id")
        val reference = call.getString("reference")
        if (id == null || reference == null) {
            call.reject("navigateHistory requires an observed reference", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "navigateHistory") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "navigateHistory") ?: return@runOnUiThread
            val observed = surface.historyObservation
            val history = surface.webView.copyBackForwardList()
            val offset = when (reference) {
                "${observed?.reference}:back" -> -1
                "${observed?.reference}:forward" -> 1
                else -> 0
            }
            if (observed == null || offset == 0 || !historyReady(surface) ||
                observed.expiresAt < android.os.SystemClock.elapsedRealtime() ||
                observed.revision != surface.pageRevision || observed.index != history.currentIndex ||
                observed.urls != historyUrls(surface.webView) ||
                observed.index + offset !in 0 until history.size ||
                !BrowserWebOrigin.sameOrigin(surface.webView.url, history.getItemAtIndex(observed.index + offset).url)) {
                surface.historyObservation = null
                call.reject("Native history changed or is unavailable; observe again", "STALE_REF")
                return@runOnUiThread
            }
            // Consume before dispatch: even a lost reply cannot repeat this effect.
            surface.historyObservation = null
            val control = surface.control ?: run {
                call.reject("Exact history navigation requires isolated page control", "UNSUPPORTED")
                return@runOnUiThread
            }
            val revision = surface.pageRevision
            val url = surface.webView.url
            // WebView.goBackOrForward skips entries without activation. The isolated
            // world's History API traverses the observed adjacent entry exactly.
            control.execute(call, JSObject().apply {
                put("subaction", "native-history")
                put("offset", offset)
                put("url", url)
                put("length", history.size)
            }, null) {
                activeOwners.isActive(identity) && surfaces[id] === surface && historyReady(surface) &&
                    surface.pageRevision == revision && surface.webView.url == url
            }
        }
    }

    @PluginMethod
    fun answerDialog(call: PluginCall) {
        val id = call.getString("id")
        val dialogId = call.getString("dialogId")
        val accept = call.getBoolean("accept")
        val text = call.getString("text")
        if (id == null || dialogId == null || accept == null) {
            call.reject("answerDialog requires an id, a dialogId and accept", "INVALID_REQUEST")
            return
        }
        if (text != null && text.length > BrowserPageHandoffs.MAX_TEXT) {
            call.reject("answerDialog text is too long", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "answerDialog") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "answerDialog") ?: return@runOnUiThread
            val result = surface.dialogs.take(dialogId) ?: run {
                call.reject("This dialog is no longer open", "DIALOG_CLOSED")
                return@runOnUiThread
            }
            when {
                !accept -> result.cancel()
                result is JsPromptResult -> result.confirm(text ?: "")
                else -> result.confirm()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun openExternalLink(call: PluginCall) {
        val id = call.getString("id")
        val url = call.getString("url")
        if (id == null || url == null) {
            call.reject("openExternalLink requires an id and a url", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "openExternalLink") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "openExternalLink") ?: return@runOnUiThread
            if (surface.pendingExternalLink != url) {
                call.reject("Only the link the person just tapped can open another app", "EXTERNAL_LINK_NOT_PENDING")
                return@runOnUiThread
            }
            surface.pendingExternalLink = null
            // A fresh implicit Intent: never the page's component, selector, flags or extras.
            val intent = try {
                val uri = android.net.Uri.parse(url)
                when (uri.scheme?.lowercase()) {
                    "mailto" -> Intent(Intent.ACTION_SENDTO, uri)
                    "tel" -> Intent(Intent.ACTION_DIAL, uri)
                    "market" -> Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
                    else -> {
                        val parsed = Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                        Intent(Intent.ACTION_VIEW, parsed.data).addCategory(Intent.CATEGORY_BROWSABLE).apply {
                            parsed.`package`?.let { setPackage(it) }
                        }
                    }
                }
            } catch (error: java.net.URISyntaxException) {
                // error-policy:J1 A malformed link never opens anything.
                call.reject("This link cannot open another app", "EXTERNAL_LINK_INVALID", error)
                return@runOnUiThread
            }
            val resolved = intent.resolveActivity(activity.packageManager)
            if (resolved == null || resolved.packageName == activity.packageName) {
                call.reject("No app on this device opens this link", "EXTERNAL_APP_UNAVAILABLE")
                return@runOnUiThread
            }
            try {
                activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.resolve(JSObject().apply { put("status", "dispatched") })
            } catch (error: android.content.ActivityNotFoundException) {
                // error-policy:J1 The app may disappear between resolution and launch.
                call.reject("No app on this device opens this link", "EXTERNAL_APP_UNAVAILABLE", error)
            } catch (error: SecurityException) {
                // error-policy:J1 Never broaden permissions to reach another app.
                call.reject("Android prevented opening this link", "EXTERNAL_LINK_DENIED", error)
            }
        }
    }

    /**
     * The host extended (or narrowed) its running task to these exact HTTPS origins after its own
     * safety check. An intercepting page may then move between them without a held navigation.
     * An empty list ends the extension; nothing is ever added without this call.
     */
    @PluginMethod
    fun setTaskOrigins(call: PluginCall) {
        val id = call.getString("id")
        val list = call.getArray("origins")
        val origins = ArrayList<String>()
        for (index in 0 until (list?.length() ?: 0)) {
            val origin = list?.opt(index) as? String
            if (origin == null || index >= 16) {
                call.reject("setTaskOrigins requires at most 16 HTTPS origins", "INVALID_REQUEST")
                return
            }
            origins.add(origin)
        }
        if (id == null || list == null) {
            call.reject("setTaskOrigins requires an id and origins", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "setTaskOrigins") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "setTaskOrigins") ?: return@runOnUiThread
            if (!surface.interceptNavigation) {
                call.reject("setTaskOrigins requires a surface created with interceptNavigation", "UNSUPPORTED")
                return@runOnUiThread
            }
            if (!surface.gate.setTaskOrigins(origins)) {
                call.reject("setTaskOrigins accepts exact HTTPS origins only", "INVALID_REQUEST")
                return@runOnUiThread
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun setTextZoom(call: PluginCall) {
        val id = call.getString("id")
        val percent = call.getInt("percent")
        if (id == null || percent == null || !BrowserPageHandoffs.validTextZoom(percent)) {
            call.reject("setTextZoom requires an id and a percent from 50 to 300", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "setTextZoom") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "setTextZoom") ?: return@runOnUiThread
            surface.webView.settings.textZoom = percent
            call.resolve()
        }
    }

    @PluginMethod
    fun goForward(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("goForward requires an id")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "goForward") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "goForward") ?: return@runOnUiThread
            if (surface.webView.canGoForward()) {
                surface.historyObservation = null
                approveHistoryStep(surface, 1)
                surface.webView.goForward()
            }
            call.resolve()
        }
    }

    /** A history move the host asked for may reload its entry from the network. */
    private fun approveHistoryStep(surface: Surface, step: Int) {
        val history = surface.webView.copyBackForwardList()
        history.getItemAtIndex(history.currentIndex + step)?.url?.let(surface.gate::approve)
    }

    @PluginMethod
    fun clearSurfaceStorage(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("clearSurfaceStorage requires an id")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "clearSurfaceStorage") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "clearSurfaceStorage") ?: return@runOnUiThread
            val name = surface.profileName ?: run {
                // Shared storage is the host's own store; clearing it here would sign the host out.
                call.reject("Only isolated storage can be cleared here", "SHARED_STORAGE")
                return@runOnUiThread
            }
            surface.webView.clearCache(true)
            clearProfileData(name) { call.resolve() }
        }
    }

    /**
     * Purges keyed profiles: one key at once (sign-out), or every keyed profile idle for at
     * least `idleMs` that no open surface uses. Surfaces on a purged key close first.
     */
    @PluginMethod
    fun purgeProfiles(call: PluginCall) {
        val key = call.getString("profileKey")
        val idle = (call.data.opt("idleMs") as? Number)?.toDouble()
        if ((key == null) == (idle == null) ||
            (key != null && !BrowserProfilePolicy.validKey(key)) ||
            (idle != null && (!idle.isFinite() || !BrowserProfilePolicy.validIdle(idle.toLong())))) {
            call.reject("purgeProfiles requires either a profileKey or an idleMs of at least one hour", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "purgeProfiles") ?: return@runOnUiThread
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                call.resolve(JSObject().apply { put("purged", 0) })
                return@runOnUiThread
            }
            var purged = 0
            if (key != null) {
                val name = keyedProfileName(identity.owner, key)
                for ((id, surface) in surfaces.entries.filter { it.value.profileName == name }) {
                    val live = isLive(surface)
                    dismissDialogs(surface)
                    surface.control?.interrupt("The website sign-ins were removed", navigation = true)
                    surface.container.visibility = View.GONE
                    surface.foregrounded = false
                    surface.webView.stopLoading()
                    (surface.container.parent as? ViewGroup)?.removeView(surface.container)
                    surface.container.removeView(surface.webView)
                    surface.webView.destroy()
                    surface.disposed = true
                    surfaces.remove(id)
                    if (live) notifyListeners("surfaceClosed", surfaceEvent(id, surface).apply { put("reason", "profile-purged") })
                }
                if (ProfileStore.getInstance().allProfileNames.contains(name)) {
                    purgeKeyedProfile(name)
                    purged = 1
                }
            } else {
                val now = System.currentTimeMillis()
                for (name in ProfileStore.getInstance().allProfileNames) {
                    if (!BrowserProfilePolicy.keyed(name) || surfaces.values.any { it.profileName == name }) continue
                    val used = if (profilePrefs.contains("used:$name")) profilePrefs.getLong("used:$name", 0) else null
                    if (!BrowserProfilePolicy.expired(used, now, idle!!.toLong())) continue
                    purgeKeyedProfile(name)
                    purged += 1
                }
            }
            call.resolve(JSObject().apply { put("purged", purged) })
        }
    }

    /**
     * A masked JPEG of the visible page for a vision fallback. Secret fields and unreadable
     * frames are covered before the pixels are copied and uncovered right after; host chrome
     * showing through the page is painted over. Any doubt rejects; nothing unmasked is returned.
     */
    @PluginMethod
    fun captureSurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("captureSurface requires an id")
            return
        }
        val maxEdge = call.getInt("maxEdge", BrowserCapturePolicy.DEFAULT_MAX_EDGE) ?: BrowserCapturePolicy.DEFAULT_MAX_EDGE
        val quality = call.getInt("quality", BrowserCapturePolicy.DEFAULT_QUALITY) ?: BrowserCapturePolicy.DEFAULT_QUALITY
        val rawSelectors = call.getArray("maskSelectors")
        val selectors = org.json.JSONArray()
        for (index in 0 until (rawSelectors?.length() ?: 0)) {
            val selector = rawSelectors?.opt(index) as? String
            if (selector.isNullOrBlank() || selector.length > 512 || index >= 32) {
                call.reject("captureSurface maskSelectors must be up to 32 CSS selectors", "INVALID_REQUEST")
                return
            }
            selectors.put(selector)
        }
        if (!BrowserCapturePolicy.validMaxEdge(maxEdge) || !BrowserCapturePolicy.validQuality(quality)) {
            call.reject("captureSurface maxEdge must be 256 to 2048 and quality 30 to 90", "INVALID_REQUEST")
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.VISUAL_STATE_CALLBACK)) {
            call.reject("This device cannot capture a masked page", "UNSUPPORTED")
            return
        }
        val maskFrames = call.getBoolean("maskFrames", true) ?: true
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "captureSurface") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "captureSurface") ?: return@runOnUiThread
            if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) || !surface.foregrounded ||
                surface.webView.progress < 100 || surface.pageError != null ||
                surface.container.width <= 0 || surface.container.height <= 0) {
                call.reject(surface.pageError ?: "The native page is hidden or still loading", "CAPTURE_UNAVAILABLE")
                return@runOnUiThread
            }
            val webView = surface.webView
            val revision = surface.pageRevision
            val url = webView.url
            val token = UUID.randomUUID().toString()
            val unchanged = {
                isLive(surface) && surfaces[id] === surface && surface.foregrounded &&
                    surface.pageRevision == revision && webView.url == url
            }
            var settled = false
            var masked: JSONObject? = null
            val restore = {
                val command = JSONObject().put("action", "restore").put("token", token)
                if (!surface.disposed) webView.evaluateJavascript("($captureMask)($command)", null)
            }
            lateinit var timeout: Runnable
            val fail = { message: String, code: String ->
                if (!settled) {
                    settled = true
                    webView.removeCallbacks(timeout)
                    restore()
                    call.reject(message, code)
                }
            }
            timeout = Runnable { fail("The page capture timed out", "CAPTURE_TIMEOUT") }
            webView.postDelayed(timeout, 5000)
            val copy = copy@{
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@copy
                val origin = IntArray(2)
                surface.container.getLocationInWindow(origin)
                val width = surface.container.width
                val height = surface.container.height
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                PixelCopy.request(activity.window, Rect(origin[0], origin[1], origin[0] + width, origin[1] + height), bitmap, { status ->
                    // Uncover the page as soon as its pixels are copied.
                    restore()
                    if (settled) return@request
                    if (status != PixelCopy.SUCCESS) return@request fail("The page could not be captured", "CAPTURE_FAILED")
                    if (!unchanged()) return@request fail("The page changed while capturing; capture again", "CAPTURE_STALE")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) surface.container.maskHostRegions(Canvas(bitmap))
                    val (scaledWidth, scaledHeight) = BrowserCapturePolicy.scaled(width, height, maxEdge).let { it[0] to it[1] }
                    val image = if (scaledWidth == width) bitmap else Bitmap.createScaledBitmap(bitmap, scaledWidth, scaledHeight, true)
                    val bytes = java.io.ByteArrayOutputStream()
                    image.compress(Bitmap.CompressFormat.JPEG, quality, bytes)
                    if (image !== bitmap) image.recycle()
                    bitmap.recycle()
                    settled = true
                    webView.removeCallbacks(timeout)
                    call.resolve(JSObject().apply {
                        put("mimeType", "image/jpeg")
                        put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                        put("width", scaledWidth)
                        put("height", scaledHeight)
                        put("maskedFields", masked?.optInt("fields") ?: 0)
                        put("maskedFrames", masked?.optInt("frames") ?: 0)
                        put("url", url ?: JSObject.NULL)
                    })
                }, mainHandler)
            }
            val command = JSONObject().put("action", "mask").put("token", token)
                .put("selectors", selectors).put("frames", maskFrames)
            try {
                webView.evaluateJavascript("($captureMask)($command)") { raw ->
                    if (settled) return@evaluateJavascript
                    val result = try {
                        JSONObject(raw)
                    } catch (error: org.json.JSONException) {
                        // error-policy:J1 No mask report means no capture.
                        return@evaluateJavascript fail("The page could not be masked", "CAPTURE_MASK_FAILED")
                    }
                    if (result.has("error")) return@evaluateJavascript fail(result.optString("error"), "CAPTURE_MASK_FAILED")
                    if (!unchanged()) return@evaluateJavascript fail("The page changed while capturing; capture again", "CAPTURE_STALE")
                    masked = result
                    // Copy only once the covers are on screen: the visual state callback fires
                    // when this DOM state is ready to draw, and the copy waits one more frame.
                    WebViewCompat.postVisualStateCallback(webView, revision) {
                        if (settled) return@postVisualStateCallback
                        if (!unchanged()) return@postVisualStateCallback fail("The page changed while capturing; capture again", "CAPTURE_STALE")
                        webView.postOnAnimation { if (!settled) copy() }
                    }
                }
            } catch (error: RuntimeException) {
                fail("The page could not be masked", "CAPTURE_MASK_FAILED")
            }
        }
    }

    @PluginMethod
    fun readPage(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("readPage requires an id")
            return
        }
        val selector = call.getString("selector") ?: "body"
        if (selector.isBlank() || selector.length > 2048) {
            call.reject("readPage requires a nonempty selector of at most 2048 characters")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "readPage") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "readPage") ?: return@runOnUiThread
            if (!surface.foregrounded || surface.webView.progress < 100 || surface.pageError != null) {
                call.reject(surface.pageError ?: "The native page is hidden or still loading")
                return@runOnUiThread
            }
            val revision = surface.pageRevision
            val url = surface.webView.url
            var settled = false
            val timeout = Runnable {
                if (!settled) {
                    settled = true
                    call.reject("Native page read timed out")
                }
            }
            surface.webView.postDelayed(timeout, 5000)
            try {
                surface.webView.evaluateJavascript("($pageReader)(${JSONObject.quote(selector)})") { raw ->
                    if (settled) return@evaluateJavascript
                    settled = true
                    surface.webView.removeCallbacks(timeout)
                    if (!activeOwners.isActive(identity) || surfaces[id] !== surface || surface.disposed ||
                        !surface.foregrounded || surface.pageRevision != revision || surface.webView.url != url) {
                        call.reject("Native page changed while reading; discard this result")
                        return@evaluateJavascript
                    }
                    try {
                        val result = JSObject(raw)
                        if (result.has("error")) call.reject(result.getString("error"))
                        else call.resolve(result)
                    } catch (error: Exception) {
                        call.reject("Native page returned an invalid read result", error)
                    }
                }
            } catch (error: Exception) {
                settled = true
                surface.webView.removeCallbacks(timeout)
                call.reject("Native page read failed", error)
            }
        }
    }

    @PluginMethod
    fun controlPage(call: PluginCall) {
        val id = call.getString("id")
        val command = call.getObject("command")
        if (id == null || command == null || command.optString("subaction") !in setOf("snapshot", "click", "fill", "select", "scroll", "follow", "guide")) {
            call.reject("controlPage requires a surface and a fixed page command", "INVALID_REQUEST")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "controlPage") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "controlPage") ?: return@runOnUiThread
            val control = surface.control ?: run {
                call.reject("This WebView provider does not support isolated page control", "UNSUPPORTED")
                return@runOnUiThread
            }
            val revision = surface.pageRevision
            val url = surface.webView.url
            // Removing host annotations remains possible after Home or Pause.
            // This exception never admits page reads, input or new guidance.
            val cleanup = command.optString("subaction") == "guide" &&
                command.optJSONObject("guidance")?.optString("kind") in setOf("hide", "pause")
            control.execute(call, command, call.getString("documentId")) {
                activeOwners.isActive(identity) && surfaces[id] === surface && !surface.disposed &&
                    (cleanup || (activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
                    surface.foregrounded && surface.webView.progress == 100 && surface.pageError == null)) &&
                    surface.pageRevision == revision && surface.webView.url == url
            }
        }
    }

    @PluginMethod
    fun presentSurface(call: PluginCall) {
        val id = call.getString("id")
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "presentSurface") ?: return@runOnUiThread
            val owner = identity.owner
            val selected = id?.let {
                ownedSurface(call, it, identity, "presentSurface")
                    ?: return@runOnUiThread
            }
            for (surface in surfaces.values) {
                if (surface.owner == owner) {
                    if (surface !== selected) {
                        surface.control?.interrupt("The native page was hidden")
                        dismissDialogs(surface)
                        surface.historyObservation = null
                    }
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
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "destroySurface") ?: return@runOnUiThread
            val surface = surfaces[id]
            if (surface == null) {
                call.resolve()
                return@runOnUiThread
            }
            if (
                surface.owner != identity.owner ||
                surface.session != identity.session ||
                surface.epoch != identity.epoch
            ) {
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
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "getSurfaceState") ?: return@runOnUiThread
            val owner = identity.owner
            val session = identity.session
            val result = JSObject()
            val surface = surfaces[id]
            if (
                surface == null || surface.owner != owner || surface.session != session ||
                surface.epoch != identity.epoch
            ) {
                result.put("exists", false)
                result.put("foregrounded", false)
                result.put("currentUrl", JSObject.NULL)
                result.put("process", JSObject.NULL)
                result.put("storage", JSObject.NULL)
                result.put("owner", JSObject.NULL)
                result.put("session", JSObject.NULL)
                result.put("epoch", JSObject.NULL)
                result.put("title", JSObject.NULL)
                result.put("canGoBack", false)
                result.put("canGoForward", false)
                result.put("progress", 0)
                result.put("pageError", JSObject.NULL)
                result.put("textZoom", JSObject.NULL)
                call.resolve(result)
            } else {
                call.resolve(surfaceState(id, surface))
            }
        }
    }

    @PluginMethod
    fun listSurfaceStates(call: PluginCall) {
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "listSurfaceStates") ?: return@runOnUiThread
            val owner = identity.owner
            val session = identity.session
            val surfacesResult = com.getcapacitor.JSArray()
            for ((id, surface) in surfaces) {
                if (
                    surface.owner != owner || surface.session != session ||
                    surface.epoch != identity.epoch
                ) continue
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
        val owner = identity.owner
        val session = identity.session
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
            if (!activeOwners.claim(identity)) {
                call.reject("reconcileOwner rejected a retired renderer session")
                return@runOnUiThread
            }
            // Presentation is fenced before fallible cleanup so a stale page
            // cannot remain visible or interactive after its realm is retired.
            for (surface in surfaces.values) {
                if (surface.owner == owner) {
                    surface.historyObservation = null
                    surface.control?.interrupt("The native owner was reconciled")
                    surface.container.visibility = View.GONE
                    surface.foregrounded = false
                }
            }
            try {
                val staleIds = surfaces.entries
                    .filter { entry ->
                        val surface = entry.value
                        surface.owner == owner &&
                            (surface.session != session ||
                                surface.epoch != identity.epoch ||
                                !desiredIds.contains(entry.key))
                    }
                    .map { it.key }
                for (id in staleIds) {
                    val surface = surfaces.getValue(id)
                    disposeSurface(surface)
                    surfaces.remove(id)
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
        put("epoch", surface.epoch)
        put("title", surface.webView.title?.let(BrowserPageHandoffs::text) ?: JSObject.NULL)
        put("canGoBack", surface.webView.canGoBack())
        put("canGoForward", surface.webView.canGoForward())
        put("progress", surface.webView.progress)
        put("pageError", surface.pageError ?: JSObject.NULL)
        put("textZoom", surface.webView.settings.textZoom)
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

    /**
     * Paints over everything a capture of this layout's window rectangle shows that is not the
     * page: the area outside the rounded outer clip and every occlusion, where host chrome shows.
     */
    @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
    fun maskHostRegions(canvas: Canvas) {
        val paint = Paint().apply { color = 0xFF5F6368.toInt() }
        outerClip?.let { clip ->
            val saveCount = canvas.save()
            clipPath.reset()
            clipPath.addRoundRect(RectF(clip.left, clip.top, clip.right, clip.bottom), clip.pathRadii(), Path.Direction.CW)
            canvas.clipOutPath(clipPath)
            canvas.drawPaint(paint)
            canvas.restoreToCount(saveCount)
        }
        for (rect in occlusions) {
            clipPath.reset()
            clipPath.addRoundRect(RectF(rect.left, rect.top, rect.right, rect.bottom), rect.cornerRadius, rect.cornerRadius, Path.Direction.CW)
            canvas.drawPath(clipPath, paint)
        }
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

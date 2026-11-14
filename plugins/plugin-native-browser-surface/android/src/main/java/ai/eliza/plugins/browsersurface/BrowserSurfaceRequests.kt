/**
 * Decisions for what a website asks of the device through a surface: files to upload,
 * the camera, microphone or location, and how its pinch zoom is reported. The surface
 * reports each request to the host and holds it until the host answers; these rules decide
 * what is reported and what an answer may deliver. Pure JVM; no Android types.
 */
package ai.eliza.plugins.browsersurface

import java.util.UUID

object BrowserSurfaceRequests {
    /** Most files one answered chooser may deliver, as in the tab host. */
    const val MAX_FILES = 16

    /** `PermissionRequest.RESOURCE_*` values for the kinds a site may ask for. */
    const val VIDEO_CAPTURE = "android.webkit.resource.VIDEO_CAPTURE"
    const val AUDIO_CAPTURE = "android.webkit.resource.AUDIO_CAPTURE"

    private val MIME = Regex("[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+*-]+")

    /** The page's `accept` MIME types, lowercased and deduplicated; extensions and junk are dropped. */
    fun acceptTypes(raw: Array<String?>?): List<String> =
        raw.orEmpty().mapNotNull { it?.trim()?.lowercase() }.filter { MIME.matches(it) }.distinct()

    /** Whether picked documents may go to the page: content URIs only, and no more than it allows. */
    fun pickedFiles(schemes: List<String?>, multiple: Boolean): Boolean =
        schemes.isNotEmpty() && schemes.size <= (if (multiple) MAX_FILES else 1) &&
            schemes.all { it == "content" }

    /** The camera and microphone kinds of a media request; any other resource is never offered. */
    fun mediaKinds(resources: Array<String?>?): List<String> = resources.orEmpty().mapNotNull {
        when (it) {
            VIDEO_CAPTURE -> BrowserSitePrompt.CAMERA
            AUDIO_CAPTURE -> BrowserSitePrompt.MICROPHONE
            else -> null
        }
    }.distinct()

    /** The media resources a grant of [kinds] delivers. */
    fun mediaResources(kinds: Collection<String>): List<String> = kinds.mapNotNull {
        when (it) {
            BrowserSitePrompt.CAMERA -> VIDEO_CAPTURE
            BrowserSitePrompt.MICROPHONE -> AUDIO_CAPTURE
            else -> null
        }
    }

    /**
     * The Android runtime permissions the host app must still be granted before a site may use
     * [kind]: empty when it already holds one, null when it declares none, so a site can never
     * have that kind in this app.
     */
    fun androidPermissionsToAsk(kind: String, declared: (String) -> Boolean, granted: (String) -> Boolean): List<String>? {
        val held = BrowserSitePrompt.androidPermissions(kind).filter(declared)
        return when {
            held.isEmpty() -> null
            held.any(granted) -> emptyList()
            else -> held
        }
    }

    /**
     * Why `answerSitePermission` resolved as it did: `ended` when the request was no longer held
     * or the page left its origin, or when a missing Android permission could not be asked
     * ([androidAnswered] false: no dialog, or Android returned no answer because another request
     * was showing); `denied` when the host said no; `android-refused` only when Android was asked
     * and some permission is still missing; else `granted`.
     */
    fun sitePermissionOutcome(held: Boolean, grant: Boolean, samePage: Boolean, missing: Boolean, androidAnswered: Boolean): String =
        when {
            !held -> "ended"
            !grant -> "denied"
            !samePage -> "ended"
            !missing -> "granted"
            androidAnswered -> "android-refused"
            else -> "ended"
        }

    /**
     * Why `navigateHistory` refuses before dispatching, or null to dispatch: `DIALOG_OPEN` while the
     * page holds a dialog, which freezes it, so the isolated world could take the traversal only after
     * the dialog is answered, past the command's timeout, as an effect nobody awaits; else
     * `STALE_REF` unless the reference is the current observation's adjacent same-origin entry.
     */
    fun historyRefusal(dialogHeld: Boolean, current: Boolean): String? = when {
        dialogHeld -> "DIALOG_OPEN"
        !current -> "STALE_REF"
        else -> null
    }

    /** A grant of [kinds] lets the page play media without a gesture, as Chrome does while it captures. */
    fun capturesMedia(kinds: Collection<String>): Boolean =
        BrowserSitePrompt.CAMERA in kinds || BrowserSitePrompt.MICROPHONE in kinds

    /**
     * The page's zoom as CSS pixels per device-independent pixel, to two places: 1 is the
     * page's own mobile size, below 1 a wide page shown whole, above 1 pinched in.
     */
    fun pageScale(scale: Float, density: Float): Double =
        if (scale <= 0f || density <= 0f) 1.0 else Math.round(scale / density * 100.0) / 100.0

    /**
     * The browser that opens a refused sign-in page: the person's default when it is a browser
     * other than this app, else the first other browser. Never this app, so the page cannot come
     * back into the host; null when there is no other browser. [defaultPackage] is the package
     * Android resolves the address to (`android` when it would ask the person).
     */
    fun identityBrowser(own: String, defaultPackage: String?, browsers: List<String>): String? {
        val others = browsers.filter { it != own }
        return defaultPackage?.takeIf { it in others } ?: others.firstOrNull()
    }
}

/**
 * What one surface's page waits on from its host: one file input, site permission requests and
 * the last download it asked for. Each is named by an unguessable request id, so a stale or
 * repeated answer finds nothing. UI thread only; the caller answers, with nothing, whatever
 * [close] hands back.
 */
class SurfaceHolds<F : Any, P : Any, D : Any> {
    private var file: Pair<String, F>? = null
    private var download: Pair<String, D>? = null
    val permissions = BrowserPageHandoffs.Dialogs<P>()

    /** What [close] ended: the file input and the site permission requests by request id. */
    class Closed<F, P>(val file: F?, val permissions: Map<String, P>)

    /** Holds a file input; returns its request id and the input it replaced, which gets no files. */
    fun holdFile(value: F): Pair<String, F?> {
        val replaced = file?.second
        val requestId = UUID.randomUUID().toString()
        file = requestId to value
        return requestId to replaced
    }

    /** The held file input named [requestId], left held while the picker is open. */
    fun file(requestId: String?): F? = file?.takeIf { it.first == requestId }?.second

    fun takeFile(requestId: String?): F? = file(requestId)?.also { file = null }

    /** Holds the download the page asked for, replacing an earlier one; returns its request id. */
    fun holdDownload(value: D): String = UUID.randomUUID().toString().also { download = it to value }

    fun takeDownload(requestId: String?): D? =
        download?.takeIf { it.first == requestId }?.second?.also { download = null }

    /** Ends everything held, for a page that navigated, was hidden or closed. */
    fun close(): Closed<F, P> {
        val closed = Closed(file?.second, permissions.withdraw { true })
        file = null
        download = null
        return closed
    }
}

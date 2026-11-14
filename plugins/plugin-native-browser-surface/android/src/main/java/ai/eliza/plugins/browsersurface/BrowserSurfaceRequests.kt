/**
 * Decisions for what a website asks of the device through a surface: files to upload,
 * the camera, microphone or location, and how its pinch zoom is reported. The surface
 * reports each request to the host and holds it until the host answers; these rules decide
 * what is reported and what an answer may deliver. Pure JVM; no Android types.
 */
package ai.eliza.plugins.browsersurface

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
     * The page's zoom as CSS pixels per device-independent pixel, to two places: 1 is the
     * page's own mobile size, below 1 a wide page shown whole, above 1 pinched in.
     */
    fun pageScale(scale: Float, density: Float): Double =
        if (scale <= 0f || density <= 0f) 1.0 else Math.round(scale / density * 100.0) / 100.0
}

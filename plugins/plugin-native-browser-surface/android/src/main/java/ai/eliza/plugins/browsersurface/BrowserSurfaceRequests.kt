/**
 * Decisions for what a website asks of the device through a surface, starting with how its
 * pinch zoom is reported. Pure JVM; no Android types.
 */
package ai.eliza.plugins.browsersurface

object BrowserSurfaceRequests {
    /**
     * The page's zoom as CSS pixels per device-independent pixel, to two places: 1 is the
     * page's own mobile size, below 1 a wide page shown whole, above 1 pinched in.
     */
    fun pageScale(scale: Float, density: Float): Double =
        if (scale <= 0f || density <= 0f) 1.0 else Math.round(scale / density * 100.0) / 100.0
}

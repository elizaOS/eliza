/** Verifies what a surface reports and delivers for file inputs, site permissions and zoom. */
package ai.eliza.plugins.browsersurface

import org.junit.Assert.assertEquals
import org.junit.Test

class BrowserSurfaceRequestsTest {
    @Test
    fun pageScaleIsCssPixelsPerDensityIndependentPixel() {
        assertEquals(1.0, BrowserSurfaceRequests.pageScale(2.625f, 2.625f), 0.0)
        assertEquals(0.4, BrowserSurfaceRequests.pageScale(1.05f, 2.625f), 0.0)
        assertEquals(2.5, BrowserSurfaceRequests.pageScale(6.5625f, 2.625f), 0.0)
        assertEquals(1.0, BrowserSurfaceRequests.pageScale(0f, 2.625f), 0.0)
    }
}

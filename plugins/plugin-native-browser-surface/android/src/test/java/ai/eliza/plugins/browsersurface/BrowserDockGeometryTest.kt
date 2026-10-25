package ai.eliza.plugins.browsersurface

import org.junit.Assert.*
import org.junit.Test

class BrowserDockGeometryTest {
    @Test fun reservesTheRequestedPanelAndMinimumBrowserWidth() {
        assertEquals(0.3125f, BrowserDockController.ratio(1280f, 400), 0.0001f)
        assertEquals(0.4f, BrowserDockController.ratio(800f, 320), 0.0001f)
        assertEquals(640f / 1120f, BrowserDockController.ratio(1120f, 640), 0.0001f)
    }
    @Test fun refusesClippedOrInvalidPanesBeforeLaunching() {
        for ((width, panel) in listOf(799f to 320, 1280f to 319, 1600f to 641, Float.NaN to 400, Float.POSITIVE_INFINITY to 400, -1f to 400)) {
            val error = assertThrows(BrowserLaunchException::class.java) { BrowserDockController.ratio(width, panel) }
            assertEquals("BROWSER_DOCK_SIZE_UNAVAILABLE", error.code)
        }
    }
}

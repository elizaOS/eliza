/** Checks the below-host layer's input ownership and child order without a device. */
package ai.eliza.plugins.browsersurface

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BelowHostLayerTest {
    private val clip = RoundedOuterClip(0f, 0f, 200f, 100f, 20f, 20f, 20f, 20f)
    private val tab = RoundedOcclusionRect(150f, 0f, 200f, 40f, 10f)

    private fun owns(x: Float, y: Float, rects: List<RoundedOcclusionRect> = listOf(tab), outer: RoundedOuterClip? = clip) =
        pageOwnsPoint(x, y, 200, 100, outer, rects)

    @Test
    fun onlyAShownUnpausedBelowHostPageTakesInput() {
        assertTrue(takesPageInput(SurfaceLayer.BELOW_HOST, foregrounded = true, paused = false, disposed = false))
        assertFalse(takesPageInput(SurfaceLayer.BELOW_HOST, foregrounded = true, paused = true, disposed = false))
        assertFalse(takesPageInput(SurfaceLayer.BELOW_HOST, foregrounded = false, paused = false, disposed = false))
        assertFalse(takesPageInput(SurfaceLayer.BELOW_HOST, foregrounded = true, paused = false, disposed = true))
        assertFalse(takesPageInput(SurfaceLayer.ABOVE_HOST, foregrounded = true, paused = false, disposed = false))
    }

    @Test
    fun thePageOwnsItsRectOutsideHostRects() {
        assertTrue(owns(100f, 50f))
        assertTrue(owns(0f, 50f))
        assertFalse(owns(170f, 20f))
        assertTrue(owns(170f, 60f))
    }

    @Test
    fun theHostOwnsEverythingOutsideThePageRect() {
        assertFalse(owns(-1f, 50f))
        assertFalse(owns(200f, 50f))
        assertFalse(owns(100f, 100f))
        assertFalse(owns(1f, 1f))
        assertTrue(owns(1f, 1f, outer = null))
    }

    @Test
    fun theHostOwnsTheUnionOfOverlappingRects() {
        val rects = listOf(RoundedOcclusionRect(20f, 20f, 60f, 70f, 0f), RoundedOcclusionRect(40f, 30f, 80f, 80f, 0f))
        assertFalse(owns(30f, 40f, rects))
        assertFalse(owns(70f, 40f, rects))
        assertTrue(owns(90f, 50f, rects))
    }

    @Test
    fun aBelowHostSurfaceGoesUnderTheHostAndAnAboveHostOneOnTop() {
        assertEquals(2, surfaceInsertIndex(SurfaceLayer.BELOW_HOST, 2))
        assertEquals(-1, surfaceInsertIndex(SurfaceLayer.ABOVE_HOST, 2))
    }

    @Test
    fun theLayerDefaultsToAboveHostAndRejectsUnknownValues() {
        assertEquals(SurfaceLayer.ABOVE_HOST, SurfaceLayer.parse(null))
        assertEquals(SurfaceLayer.ABOVE_HOST, SurfaceLayer.parse("above-host"))
        assertEquals(SurfaceLayer.BELOW_HOST, SurfaceLayer.parse("below-host"))
        assertNull(SurfaceLayer.parse("below"))
    }

    @Test
    fun aLayerThatIsNotAStringIsRejectedNotDefaulted() {
        assertNull(SurfaceLayer.parse(true))
        assertNull(SurfaceLayer.parse(1))
        assertNull(SurfaceLayer.parse(mapOf("layer" to "below-host")))
        assertNull(SurfaceLayer.parse(""))
    }
}

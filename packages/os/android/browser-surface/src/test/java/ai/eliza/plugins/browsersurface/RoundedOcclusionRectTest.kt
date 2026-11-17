/** Verifies rounded native occlusion hit geometry without a device runtime. */
package ai.eliza.plugins.browsersurface

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoundedOcclusionRectTest {
    private val rounded = RoundedOcclusionRect(10f, 20f, 110f, 80f, 20f)

    @Test
    fun centerAndEdgesYieldWhileRoundedCornersStayOnThePage() {
        assertTrue(rounded.contains(60f, 50f))
        assertTrue(rounded.contains(10f, 40f))
        assertFalse(rounded.contains(10f, 20f))
        assertFalse(rounded.contains(111f, 50f))
    }

    @Test
    fun outerClipRejectsOnlyPixelsOutsideItsComputedRoundedCorners() {
        val clip = RoundedOuterClip(0f, 0f, 100f, 80f, 20f, 16f, 12f, 8f)

        assertFalse(clip.contains(0f, 0f))
        assertFalse(clip.contains(99f, 0f))
        assertTrue(clip.contains(20f, 0f))
        assertTrue(clip.contains(50f, 40f))
        assertFalse(clip.contains(100f, 80f))
    }

    @Test
    fun oversizedRadiiUseTheSameCssNormalizationForPaintAndHitTesting() {
        val clip = RoundedOuterClip(0f, 0f, 100f, 80f, 200f, 200f, 200f, 200f)

        assertTrue(clip.pathRadii().all { it == 40f })
        assertFalse(clip.contains(0f, 0f))
        assertTrue(clip.contains(40f, 0f))
        assertTrue(clip.contains(50f, 40f))
    }

    @Test
    fun asymmetricCornerHitTestingUsesTheSelectedCornersOwnCenter() {
        val clip = RoundedOuterClip(0f, 0f, 100f, 100f, 0f, 80f, 0f, 0f)

        assertTrue(clip.contains(30f, 10f))
        assertFalse(clip.contains(99f, 1f))
    }
}

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
}

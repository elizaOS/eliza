package ai.eliza.plugins.mobilesignals

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BatteryChangeFilterTest {
    @Test
    fun ignoresABroadcastWithUnchangedLevelAndPlugState() {
        val filter = BatteryChangeFilter()
        assertTrue(filter.changed(level = 80, plugged = 0))
        assertFalse(filter.changed(level = 80, plugged = 0))
        assertTrue(filter.changed(level = 79, plugged = 0))
        assertTrue(filter.changed(level = 79, plugged = 2))
        assertFalse(filter.changed(level = 79, plugged = 2))
    }

    @Test
    fun resetLetsTheNextBroadcastThrough() {
        val filter = BatteryChangeFilter()
        filter.changed(level = 50, plugged = 1)
        filter.reset()
        assertTrue(filter.changed(level = 50, plugged = 1))
    }
}

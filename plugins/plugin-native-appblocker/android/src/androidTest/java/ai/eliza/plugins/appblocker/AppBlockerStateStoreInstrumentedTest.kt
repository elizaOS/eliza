package ai.eliza.plugins.appblocker

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for `@elizaos/capacitor-appblocker`'s persisted
 * block state (#9967).
 *
 * Drives [AppBlockerStateStore] against the device's real `SharedPreferences` —
 * the persistence + time-based expiry that decides whether an app is actually
 * blocked. This is exactly the native side-effect a mocked Capacitor bridge in
 * desktop Chromium cannot exercise; the block-correctness logic ran on no test,
 * on no device. Each test isolates by clearing the store before and after.
 */
@RunWith(AndroidJUnit4::class)
class AppBlockerStateStoreInstrumentedTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun clearBefore() = AppBlockerStateStore.clear(context)

    @After
    fun clearAfter() = AppBlockerStateStore.clear(context)

    @Test
    fun saveThenLoad_roundTripsSortedPackagesAndExpiry() {
        val endsAt = System.currentTimeMillis() + 3_600_000L
        AppBlockerStateStore.save(context, listOf("com.example.b", "com.example.a"), endsAt)

        val saved = AppBlockerStateStore.load(context)
        assertEquals(listOf("com.example.a", "com.example.b"), saved?.packageNames)
        assertEquals(endsAt, saved?.endsAtEpochMs)
    }

    @Test
    fun save_withNoExpiry_persistsIndefiniteBlock() {
        AppBlockerStateStore.save(context, listOf("com.example.app"), null)

        val saved = AppBlockerStateStore.load(context)
        assertEquals(listOf("com.example.app"), saved?.packageNames)
        assertNull("an indefinite block has no expiry", saved?.endsAtEpochMs)
    }

    @Test
    fun load_returnsNullAndClearsWhenExpired() {
        // A block whose window has already elapsed must not keep blocking — load
        // detects the past expiry, clears the store, and reports no active block.
        val past = System.currentTimeMillis() - 1_000L
        AppBlockerStateStore.save(context, listOf("com.example.app"), past)

        assertNull("expired block is inactive", AppBlockerStateStore.load(context))
        // and it was actually cleared, not merely filtered on read
        assertFalse(AppBlockerStateStore.isBlocked(context, "com.example.app"))
    }

    @Test
    fun isBlocked_reflectsTheSavedSetThenClears() {
        AppBlockerStateStore.save(
            context,
            listOf("com.example.a", "com.example.b"),
            System.currentTimeMillis() + 3_600_000L,
        )
        assertTrue(AppBlockerStateStore.isBlocked(context, "com.example.a"))
        assertTrue(AppBlockerStateStore.isBlocked(context, "com.example.b"))
        assertFalse(AppBlockerStateStore.isBlocked(context, "com.example.c"))

        AppBlockerStateStore.clear(context)
        assertFalse("clearing lifts every block", AppBlockerStateStore.isBlocked(context, "com.example.a"))
    }

    @Test
    fun load_returnsNullWhenNothingSaved() {
        assertNull(AppBlockerStateStore.load(context))
        assertFalse(AppBlockerStateStore.isBlocked(context, "com.example.app"))
    }
}

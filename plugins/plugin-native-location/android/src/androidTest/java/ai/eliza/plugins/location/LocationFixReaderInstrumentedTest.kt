package ai.eliza.plugins.location

import android.Manifest
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.google.android.gms.location.Priority
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device read test for the fused current-location fetch (issue #9967).
 *
 * Drives the real Play Services `FusedLocationProviderClient.getCurrentLocation`
 * via [LocationFixReader] — the same path [LocationPlugin.getCurrentPosition]
 * uses — and asserts a well-formed [android.location.Location] is read back.
 *
 * The fix is injected host-side on an **emulator** (`adb -s <emulator> emu geo
 * fix <lon> <lat>`, with `settings put secure location_mode 3`) before the run,
 * so the test is orchestrated, not dependent on a real GPS lock. It `Assume`-
 * skips when no fix arrives (e.g. a device with no geo orchestration / location
 * off), so it never hard-fails on an environment it can't control.
 */
@RunWith(AndroidJUnit4::class)
class LocationFixReaderInstrumentedTest {

    @get:Rule
    val permissionRule: GrantPermissionRule =
        GrantPermissionRule.grant(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun mapAccuracyToPriority_coversEveryTier() {
        // Pure mapping the plugin delegates here — exact, no device needed.
        val reader = LocationFixReader(context)
        assertEquals(Priority.PRIORITY_HIGH_ACCURACY, reader.mapAccuracyToPriority("best"))
        assertEquals(Priority.PRIORITY_HIGH_ACCURACY, reader.mapAccuracyToPriority("high"))
        assertEquals(Priority.PRIORITY_BALANCED_POWER_ACCURACY, reader.mapAccuracyToPriority("medium"))
        assertEquals(Priority.PRIORITY_LOW_POWER, reader.mapAccuracyToPriority("low"))
        assertEquals(Priority.PRIORITY_PASSIVE, reader.mapAccuracyToPriority("passive"))
        assertEquals(Priority.PRIORITY_HIGH_ACCURACY, reader.mapAccuracyToPriority("unknown"))
    }

    @Test
    fun awaitNextLocation_readsBackAFusedFix() {
        val reader = LocationFixReader(context)
        // Keep the fused provider actively warm (requestLocationUpdates) until a
        // fix arrives — the path an emulator's injected `geo fix` actually
        // delivers on, and the same continuous API the plugin's watchPosition
        // uses. 20s window so a slow GPS/network settle still lands.
        val location = reader.awaitNextLocation(accuracy = "high", timeoutMs = 20000)

        // Skip (don't fail) when no fix arrived — meaningful only where a fix is
        // obtainable: a real device with a GPS/network lock, or an emulator with
        // a continuously-injected `geo fix`. Never a hard fail on an environment
        // whose GPS/network the test can't control.
        assumeTrue(
            "no location fix obtainable in this environment (no GPS lock / connectivity / emulator geo fix)",
            location != null,
        )

        val fix = location!!
        assertTrue("latitude ${fix.latitude} in [-90,90]", fix.latitude in -90.0..90.0)
        assertTrue("longitude ${fix.longitude} in [-180,180]", fix.longitude in -180.0..180.0)
        assertTrue("a real fix has a monotonic timestamp", fix.elapsedRealtimeNanos > 0)
        // Not the null-island default the emulator reports before any geo fix.
        assertTrue(
            "fix is not (0,0) — a geo fix was actually applied",
            fix.latitude != 0.0 || fix.longitude != 0.0,
        )
    }
}

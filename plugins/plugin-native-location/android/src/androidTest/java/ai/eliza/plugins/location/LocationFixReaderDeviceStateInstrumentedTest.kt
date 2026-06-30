package ai.eliza.plugins.location

import android.Manifest
import android.content.Context
import android.location.Location
import android.location.LocationManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the Location native plugin (issue #9967).
 *
 * Drives [LocationFixReader] against the real Android `LocationManager` and
 * permission state on a device/emulator. This proves the native Kotlin path the
 * launcher depends on is no longer only exercised through desktop Chromium's
 * mocked Capacitor bridge.
 *
 * Run: `./gradlew :elizaos-capacitor-location:connectedDebugAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class LocationFixReaderDeviceStateInstrumentedTest {

    @get:Rule
    val permissionRule: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    )

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun readPermissionStatus_reflectsGrantedForegroundLocation() {
        val reader = LocationFixReader(context)

        assertTrue("foreground location permission must be granted", reader.hasForegroundPermission())
        assertTrue(
            "background status must be a known permission state",
            reader.readBackgroundPermissionStatus("granted") in setOf("granted", "prompt", "denied"),
        )
    }

    /**
     * The foreground status is a tri-state (`granted | denied | prompt`), not a
     * boolean: a never-requested permission must report `prompt` so the app
     * shows the OS prompt instead of deep-linking to settings. With fine+coarse
     * granted by the rule, the Activity-scoped read must report `"granted"`
     * (and never `"denied"`). The `readForegroundPermissionStatus` read needs a
     * real [android.app.Activity], so drive it through a launched Activity.
     */
    @Test
    fun readForegroundPermissionStatus_returnsTriStateGranted() {
        ActivityScenario.launch(LocationReaderShowcaseActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val reader = LocationFixReader(activity)
                val status = reader.readForegroundPermissionStatus(activity)

                assertEquals(
                    "fine+coarse granted (by rule) must map to the contract value \"granted\"",
                    "granted",
                    status,
                )
                assertTrue(
                    "tri-state must be one of the JS LocationPermissionStatus values",
                    status in setOf("granted", "denied", "prompt"),
                )
            }
        }
    }

    @Test
    fun readProviderStatus_matchesRealLocationManagerProviders() {
        val reader = LocationFixReader(context)
        val status = reader.readProviderStatus()
        val locationManager =
            context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val enabledProviders = locationManager.getProviders(true).sorted()

        // Cross-check against an independent LocationManager read so this can't
        // pass via a fixed web/mock bridge value.
        assertEquals(enabledProviders, status.enabledProviders)
        assertEquals(LocationManager.GPS_PROVIDER in enabledProviders, status.gpsEnabled)
        assertEquals(LocationManager.NETWORK_PROVIDER in enabledProviders, status.networkEnabled)
        assertEquals(LocationManager.PASSIVE_PROVIDER in enabledProviders, status.passiveEnabled)

        assertTrue(
            "a phone/emulator should expose at least one enabled location provider",
            status.enabledProviders.isNotEmpty(),
        )
    }

    @Test
    fun buildPositionResult_preservesAndroidLocationFields() {
        val location = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = 37.7749
            longitude = -122.4194
            altitude = 14.5
            accuracy = 3.25f
            speed = 1.5f
            bearing = 42.0f
            time = 1_723_456_789_000L
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                verticalAccuracyMeters = 2.5f
            }
        }

        val result = LocationFixReader(context).buildPositionResult(location, cached = true)

        assertTrue(result.cached)
        assertEquals(37.7749, result.coords.latitude, 0.000001)
        assertEquals(-122.4194, result.coords.longitude, 0.000001)
        assertEquals(14.5, requireNotNull(result.coords.altitude), 0.000001)
        assertEquals(3.25, result.coords.accuracy, 0.000001)
        assertEquals(1.5, requireNotNull(result.coords.speed), 0.000001)
        assertEquals(42.0, requireNotNull(result.coords.heading), 0.000001)
        assertEquals(1_723_456_789_000L, result.coords.timestamp)
        assertNotNull(result.coords.altitudeAccuracy)
    }

}

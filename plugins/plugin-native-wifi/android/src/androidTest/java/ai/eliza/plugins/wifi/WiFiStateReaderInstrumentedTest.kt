package ai.eliza.plugins.wifi

import android.content.Context
import android.net.wifi.WifiManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the Wi-Fi state read (issue #9967).
 *
 * Drives the real `WifiManager` via [WiFiStateReader] on a device/emulator and
 * asserts a real native side-effect (the live radio state) — not a mocked
 * `Capacitor.Plugins` bridge.
 *
 * Run: `./gradlew :elizaos-capacitor-wifi:connectedDebugAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class WiFiStateReaderInstrumentedTest {

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun readWifiState_reflectsLiveRadioState() {
        val state = WiFiStateReader(context).readWifiState()

        // `enabled` is read straight off the live WifiManager — assert it matches
        // an independent read (the real device side-effect, not a stub default).
        val manager = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as WifiManager
        assertEquals(manager.isWifiEnabled, state.enabled)

        // RSSI is present iff connected, and a plausible dBm value when present.
        if (state.connected) {
            val rssi = state.rssi
            assertTrue("connected state must carry an RSSI", rssi != null)
            assertTrue(
                "rssi $rssi must be a plausible dBm value",
                rssi!! in -120..0,
            )
        } else {
            assertEquals(null, state.rssi)
        }
    }
}

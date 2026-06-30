package ai.eliza.plugins.wifi

import android.provider.Settings
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the `@elizaos/capacitor-wifi` plugin's state
 * read + scan parsing (#9967).
 *
 * Drives the bridge-free [WifiState] against the device's real `WifiManager` —
 * no mocked `Capacitor.Plugins` bridge in desktop Chromium. Runs in isolation
 * (only this plugin library + capacitor-android + androidx.test), so it does
 * not require the full launcher APK build.
 */
@RunWith(AndroidJUnit4::class)
class WifiStateInstrumentedTest {

    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun read_returnsStateWithRequiredKeysFromRealWifiManager() {
        val s = WifiState.read(ctx)
        assertNotNull("device exposes a WifiManager", s)
        requireNotNull(s)
        assertTrue("has enabled", s.has("enabled"))
        assertTrue("has connected", s.has("connected"))
        assertTrue("has rssi", s.has("rssi"))

        // `enabled` is read live from the WifiManager. Cross-check it against an
        // independent device source (the global WIFI_ON setting) when available,
        // proving the read returns real state, not a stub.
        val enabled = s.getBoolean("enabled")
        @Suppress("DEPRECATION")
        val wifiOn = Settings.Global.getInt(ctx.contentResolver, Settings.Global.WIFI_ON, -1)
        if (wifiOn == 0 || wifiOn == 1) {
            assertEquals(
                "WifiState.enabled matches Settings.Global.WIFI_ON",
                wifiOn == 1,
                enabled,
            )
        }
    }

    @Test
    fun read_connectedImpliesIntegerRssi() {
        val s = WifiState.read(ctx)
        requireNotNull(s)
        // When connected the rssi must be a real integer (dBm), never the NULL
        // sentinel; when not connected it is the sentinel. Either way the shape
        // is exactly what `getWifiState` returns to the view layer.
        if (s.getBoolean("connected")) {
            assertTrue("connected → rssi is a number", s.get("rssi") is Int)
        }
    }

    @Test
    fun isSecured_classifiesRealScanCapabilityStrings() {
        // The exact capability strings Android's scan results carry.
        assertTrue("WPA2-PSK", WifiState.isSecured("[WPA2-PSK-CCMP][ESS]"))
        assertTrue("WPA3-SAE", WifiState.isSecured("[RSN-SAE-CCMP][ESS]"))
        assertTrue("WEP", WifiState.isSecured("[WEP][ESS]"))
        assertTrue("WPA-EAP", WifiState.isSecured("[WPA-EAP-CCMP][ESS]"))
        assertFalse("open network reports only [ESS]", WifiState.isSecured("[ESS]"))
        assertFalse("empty capabilities", WifiState.isSecured(""))
    }

    @Test
    fun trimQuotes_stripsWifiInfoSsidQuoting() {
        assertEquals("home-wifi", WifiState.trimQuotes("\"home-wifi\""))
        assertEquals("unquoted stays unchanged", "unquoted", WifiState.trimQuotes("unquoted"))
        assertEquals("null → empty", "", WifiState.trimQuotes(null))
        assertEquals("bare quote pair → empty", "", WifiState.trimQuotes("\"\""))
    }
}

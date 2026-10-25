/** Exercises repeated production suggestions against the real Android Wi-Fi service. */
package ai.eliza.plugins.wifi

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WiFiConnectionRequestsInstrumentedTest {
    @Test
    fun repeatedSuggestionsUpdateOneNetworkAndInvalidPasswordAddsNothing() {
        check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) { "Suggestion fixture requires Android 11+" }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val ssid = "eliza-test-${System.nanoTime()}"
        try {
            assertTrue(WiFiConnectionRequests.suggest(manager, ssid, "test-password", false))
            assertTrue(WiFiConnectionRequests.suggest(manager, ssid, "replacement-password", false))
            assertEquals(1, manager.networkSuggestions.count { it.ssid == ssid })
            assertThrows(IllegalArgumentException::class.java) {
                WiFiConnectionRequests.suggest(manager, "$ssid-invalid", "short", false)
            }
            assertFalse(manager.networkSuggestions.any { it.ssid == "$ssid-invalid" })
        } finally {
            val fixtures = manager.networkSuggestions.filter { it.ssid == ssid }
            assertEquals(WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS, manager.removeNetworkSuggestions(fixtures))
        }
    }
}

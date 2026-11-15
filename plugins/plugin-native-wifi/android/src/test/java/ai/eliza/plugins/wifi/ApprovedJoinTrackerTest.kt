package ai.eliza.plugins.wifi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** JVM tests for the `addNetworkWithApproval` outcome: run with `./gradlew :elizaos-plugin-native-wifi:testDebugUnitTest`. */
class ApprovedJoinTrackerTest {

    @Test
    fun unnamedValidatedNetwork_isNeverConnected() {
        // Location off: home Wi-Fi rejoins (new Network handle) after the requested join failed.
        val tracker = ApprovedJoinTracker("cafe")
        assertNull(tracker.observe(networkSsid = null, validated = true, captivePortal = false))
        assertEquals("unverified", tracker.timeoutStatus())
    }

    @Test
    fun unnamedCaptivePortal_isNeverCaptivePortal() {
        val tracker = ApprovedJoinTracker("cafe")
        assertNull(tracker.observe(networkSsid = null, validated = false, captivePortal = true))
        assertEquals("unverified", tracker.timeoutStatus())
    }

    @Test
    fun otherNamedNetwork_isIgnored() {
        // STA+STA or a switch: the validated network's own name is not the requested one.
        val tracker = ApprovedJoinTracker("cafe")
        assertNull(tracker.observe(networkSsid = "home", validated = true, captivePortal = false))
        assertEquals("notConnected", tracker.timeoutStatus())
    }

    @Test
    fun matchingValidatedNetwork_isConnected() {
        val tracker = ApprovedJoinTracker("cafe")
        assertNull(tracker.observe(networkSsid = "home", validated = true, captivePortal = false))
        assertEquals("connected", tracker.observe(networkSsid = "cafe", validated = true, captivePortal = false))
    }

    @Test
    fun matchingCaptivePortal_isCaptivePortal() {
        val tracker = ApprovedJoinTracker("cafe")
        assertEquals("captivePortal", tracker.observe(networkSsid = "cafe", validated = false, captivePortal = true))
    }

    @Test
    fun matchingAfterUnnamed_isConnected() {
        val tracker = ApprovedJoinTracker("cafe")
        assertNull(tracker.observe(networkSsid = null, validated = true, captivePortal = false))
        assertEquals("connected", tracker.observe(networkSsid = "cafe", validated = true, captivePortal = false))
    }

    @Test
    fun matchingButNotYetUsable_keepsWaiting() {
        val tracker = ApprovedJoinTracker("cafe")
        assertNull(tracker.observe(networkSsid = "cafe", validated = false, captivePortal = false))
        assertEquals("notConnected", tracker.timeoutStatus())
    }

    @Test
    fun nothingReported_timesOutNotConnected() {
        assertEquals("notConnected", ApprovedJoinTracker("cafe").timeoutStatus())
    }

    @Test
    fun disclosedSsid_rejectsHiddenPlaceholders() {
        assertEquals("cafe", WiFiStateReader.disclosedSsid("\"cafe\""))
        assertNull(WiFiStateReader.disclosedSsid("<unknown ssid>"))
        assertNull(WiFiStateReader.disclosedSsid(""))
        assertNull(WiFiStateReader.disclosedSsid(null))
        // A hidden network in a scan reports its name as NUL bytes.
        assertNull(WiFiStateReader.disclosedSsid("\u0000\u0000\u0000"))
    }

    @Test
    fun authenticationError_isWrongPasswordOnlyForSecuredJoin() {
        assertEquals("wrongPassword", ApprovedJoinTracker("cafe", secured = true).authenticationFailed())
        // An open or Enhanced Open join has no password to get wrong; keep waiting for the network.
        val open = ApprovedJoinTracker("cafe", secured = false)
        assertNull(open.authenticationFailed())
        assertEquals("connected", open.observe(networkSsid = "cafe", validated = true, captivePortal = false))
    }

    @Test
    fun securityType_namesWhatAJoinNeeds() {
        assertEquals("open", WiFiStateReader.securityType("[ESS]"))
        assertEquals("open", WiFiStateReader.securityType("[ESS][OWE_TRANSITION]"))
        assertEquals("owe", WiFiStateReader.securityType("[RSN-OWE-CCMP][ESS]"))
        assertEquals("wpa2", WiFiStateReader.securityType("[WPA2-PSK-CCMP][ESS]"))
        // WPA2/WPA3 transition mode joins as WPA2, which every Android 10+ device supports.
        assertEquals("wpa2", WiFiStateReader.securityType("[RSN-PSK+SAE-CCMP][ESS]"))
        assertEquals("wpa3", WiFiStateReader.securityType("[RSN-SAE-CCMP][ESS]"))
        assertEquals("eap", WiFiStateReader.securityType("[WPA2-EAP/SHA1-CCMP][RSN-EAP/SHA1-CCMP][ESS]"))
        assertEquals("wep", WiFiStateReader.securityType("[WEP][ESS]"))
        assertFalse(WiFiStateReader.joinable("eap"))
        assertFalse(WiFiStateReader.joinable("wep"))
        assertTrue(WiFiStateReader.joinable("wpa3"))
    }

    @Test
    fun joinSecurity_keepsTheOldDefaultAndChecksTheRequestedType() {
        // Without a security type: WPA2 with a password, open without one.
        assertEquals("wpa2", WiFiConnectionRequests.security("cafe-secret", null))
        assertEquals("open", WiFiConnectionRequests.security(null, null))
        assertEquals("owe", WiFiConnectionRequests.security(null, "owe"))
        assertEquals("wpa3", WiFiConnectionRequests.security("short", "wpa3"))
        rejects { WiFiConnectionRequests.security("short", null) }
        rejects { WiFiConnectionRequests.security("cafe-secret", "open") }
        rejects { WiFiConnectionRequests.security("cafe-secret", "owe") }
        rejects { WiFiConnectionRequests.security(null, "wpa3") }
        rejects { WiFiConnectionRequests.security("cafe-secret", "eap") }
        rejects { WiFiConnectionRequests.security("cafe-secret", "wep") }
    }

    private fun rejects(body: () -> Unit) {
        try {
            body()
        } catch (expected: IllegalArgumentException) {
            return
        }
        throw AssertionError("Expected IllegalArgumentException")
    }
}

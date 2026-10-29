package ai.eliza.plugins.wifi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    }
}

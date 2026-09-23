package ai.eliza.plugins.mobileagentbridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for `@elizaos/capacitor-mobile-agent-bridge`'s URL
 * transforms (#9967). These drive the device's real `android.net.Uri` parser —
 * the security allowlist + scheme upgrade that decide what the bridge connects
 * to — which a mocked Capacitor bridge in Chromium never exercised.
 */
@RunWith(AndroidJUnit4::class)
class MobileAgentBridgeUrlsInstrumentedTest {

    private val sentinel = "eliza-local-agent://ipc"

    // --- normalizeLocalAgentApiBase: the loopback-only SSRF allowlist ---

    @Test
    fun normalize_acceptsTheSentinelAndLoopbackEmulatorHttpHosts() {
        assertEquals(sentinel, MobileAgentBridgeUrls.normalizeLocalAgentApiBase(sentinel, sentinel))
        assertEquals(sentinel, MobileAgentBridgeUrls.normalizeLocalAgentApiBase("http://127.0.0.1:31337", sentinel))
        assertEquals(sentinel, MobileAgentBridgeUrls.normalizeLocalAgentApiBase("http://localhost:8080", sentinel))
        assertEquals(sentinel, MobileAgentBridgeUrls.normalizeLocalAgentApiBase("http://10.0.2.2:31337", sentinel))
    }

    @Test
    fun normalize_rejectsRemoteHostsHttpsAndGarbage() {
        assertNull("remote host", MobileAgentBridgeUrls.normalizeLocalAgentApiBase("http://evil.example.com", sentinel))
        assertNull("public IP", MobileAgentBridgeUrls.normalizeLocalAgentApiBase("http://8.8.8.8:80", sentinel))
        assertNull("https is not http", MobileAgentBridgeUrls.normalizeLocalAgentApiBase("https://127.0.0.1", sentinel))
        assertNull("unparseable", MobileAgentBridgeUrls.normalizeLocalAgentApiBase("not a url", sentinel))
    }

    // --- buildRelayUrl: scheme upgrade + identity injection ---

    @Test
    fun buildRelayUrl_upgradesSchemeAndInjectsDeviceId() {
        val wss = MobileAgentBridgeUrls.buildRelayUrl("https://relay.example.com/ws", "dev-1", null)
        assertTrue("https → wss", wss != null && wss.startsWith("wss://relay.example.com/ws"))
        assertTrue("deviceId injected", wss!!.contains("deviceId=dev-1"))

        val ws = MobileAgentBridgeUrls.buildRelayUrl("http://r.local/x", "d", null)
        assertTrue("http → ws", ws != null && ws.startsWith("ws://"))
    }

    @Test
    fun buildRelayUrl_appendsFreshTokenAndDropsStaleAuthButKeepsOtherQuery() {
        val url = MobileAgentBridgeUrls.buildRelayUrl(
            "wss://r.example/ws?room=42&deviceId=old&token=stale",
            "dev-2",
            "secret",
        )
        requireNotNull(url)
        assertTrue("keeps unrelated query", url.contains("room=42"))
        assertTrue("fresh deviceId", url.contains("deviceId=dev-2"))
        assertFalse("drops stale deviceId", url.contains("deviceId=old"))
        assertTrue("fresh token", url.contains("token=secret"))
        assertFalse("drops stale token", url.contains("token=stale"))
    }

    @Test
    fun buildRelayUrl_rejectsUnsupportedSchemes() {
        assertNull(MobileAgentBridgeUrls.buildRelayUrl("ftp://x/y", "d", null))
        assertNull(MobileAgentBridgeUrls.buildRelayUrl("garbage", "d", null))
    }
}

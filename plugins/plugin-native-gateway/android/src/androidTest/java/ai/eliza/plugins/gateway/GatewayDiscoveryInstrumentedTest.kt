package ai.eliza.plugins.gateway

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.getcapacitor.JSObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the gateway-discovery result shape (#9967).
 *
 * Drives [GatewayDiscovery.buildDiscoveryResult] on the device's real `JSObject`
 * runtime — the case-insensitive ordering + status the discovery UI renders —
 * which a mocked Capacitor bridge in Chromium never exercised.
 */
@RunWith(AndroidJUnit4::class)
class GatewayDiscoveryInstrumentedTest {

    private fun gateway(name: String) = JSObject().apply { put("name", name) }

    @Test
    fun buildDiscoveryResult_sortsGatewaysByNameCaseInsensitively() {
        val result = GatewayDiscovery.buildDiscoveryResult(
            listOf(gateway("Zeta"), gateway("alpha"), gateway("Beta")),
            isDiscovering = true,
        )
        val gateways = result.getJSONArray("gateways")
        assertEquals(3, gateways.length())
        assertEquals("alpha", gateways.getJSONObject(0).getString("name"))
        assertEquals("Beta", gateways.getJSONObject(1).getString("name"))
        assertEquals("Zeta", gateways.getJSONObject(2).getString("name"))
    }

    @Test
    fun buildDiscoveryResult_statusReflectsTheDiscoveryFlag() {
        assertEquals(
            "Discovering...",
            GatewayDiscovery.buildDiscoveryResult(emptyList(), isDiscovering = true).getString("status"),
        )
        assertEquals(
            "Discovery stopped",
            GatewayDiscovery.buildDiscoveryResult(emptyList(), isDiscovering = false).getString("status"),
        )
    }

    @Test
    fun buildDiscoveryResult_emptyDiscoverySetYieldsEmptyArray() {
        val result = GatewayDiscovery.buildDiscoveryResult(emptyList(), isDiscovering = false)
        assertEquals(0, result.getJSONArray("gateways").length())
    }
}

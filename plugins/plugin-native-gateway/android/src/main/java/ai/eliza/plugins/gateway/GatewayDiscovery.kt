package ai.eliza.plugins.gateway

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject

/**
 * Pure, Bridge-free shaping of the gateway-discovery result (#9967).
 *
 * Extracted out of [GatewayPlugin] so the discovered-gateway ordering + status
 * shape the discovery UI consumes can be exercised by an on-device instrumented
 * test without a live NSD session. The plugin passes its current discovered set
 * + flag and delegates here, so behavior is unchanged.
 */
object GatewayDiscovery {
    /**
     * `{ gateways: [...], status }` — gateways sorted by `name` (case-insensitive,
     * for a stable UI list), and a human status string driven by the flag.
     */
    fun buildDiscoveryResult(gateways: Collection<JSObject>, isDiscovering: Boolean): JSObject {
        val sorted = JSArray()
        for (gateway in gateways.sortedBy { it.getString("name")?.lowercase() }) {
            sorted.put(gateway)
        }
        return JSObject().apply {
            put("gateways", sorted)
            put("status", if (isDiscovering) "Discovering..." else "Discovery stopped")
        }
    }
}

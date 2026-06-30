package ai.eliza.plugins.wifi

import android.content.Context
import android.net.wifi.WifiManager
import com.getcapacitor.JSObject

/**
 * Pure, Bridge-free reads + parsing of the device's Wi-Fi state.
 *
 * Extracted out of [WiFiPlugin] so the actual Android-API logic (the
 * `WifiManager` read and the capability/SSID parsing) can be exercised by an
 * on-device instrumented test (#9967) without a mocked Capacitor bridge.
 * [WiFiPlugin] delegates here, so behavior is unchanged.
 */
object WifiState {
    /**
     * Reads the current Wi-Fi state from the real [WifiManager]. Returns
     * `{ enabled, connected, rssi }`, or `null` when the device exposes no
     * Wi-Fi service (the caller rejects in that case — matching the original).
     */
    fun read(context: Context): JSObject? {
        val manager = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager
            ?: return null
        @Suppress("DEPRECATION")
        val info = manager.connectionInfo
        val connected = info != null && info.networkId != -1
        val result = JSObject()
        result.put("enabled", manager.isWifiEnabled)
        result.put("connected", connected)
        if (connected && info != null) {
            result.put("rssi", info.rssi)
        } else {
            result.put("rssi", JSObject.NULL)
        }
        return result
    }

    /**
     * `WifiInfo.getSsid()` returns the SSID wrapped in quotes
     * (e.g. `"home-wifi"`). Strip them for display.
     */
    fun trimQuotes(ssid: String?): String {
        if (ssid.isNullOrEmpty()) return ""
        if (ssid.length >= 2 && ssid.startsWith("\"") && ssid.endsWith("\"")) {
            return ssid.substring(1, ssid.length - 1)
        }
        return ssid
    }

    /**
     * Treat any capability string mentioning a security suite as "secured".
     * Open networks report capabilities like "[ESS]" with no auth marker.
     */
    fun isSecured(capabilities: String): Boolean {
        if (capabilities.isEmpty()) return false
        val upper = capabilities.uppercase()
        return upper.contains("WPA") ||
            upper.contains("WEP") ||
            upper.contains("PSK") ||
            upper.contains("EAP") ||
            upper.contains("SAE")
    }
}

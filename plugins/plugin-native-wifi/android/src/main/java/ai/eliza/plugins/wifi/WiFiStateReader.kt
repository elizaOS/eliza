package ai.eliza.plugins.wifi

import android.content.Context
import android.net.wifi.WifiManager

/**
 * Pure, [Context]-backed reader for the basic Wi-Fi radio state that
 * [WiFiPlugin.getWifiState] exposes (enabled / connected / active RSSI).
 *
 * Extracted from the Capacitor plugin so the real `WifiManager` read can be
 * exercised by an instrumented `androidTest` on a real device, without a
 * Capacitor `Bridge`/WebView (issue #9967). This read needs only
 * `ACCESS_WIFI_STATE` (declared in the plugin manifest) and works regardless of
 * keyguard, so it is the device-verifiable layer for this plugin. The
 * scan/connect paths stay in [WiFiPlugin] (they require location + write perms).
 */
class WiFiStateReader(private val context: Context) {

    data class WifiState(
        val enabled: Boolean,
        val connected: Boolean,
        /** Active-connection RSSI in dBm, or null when not connected. */
        val rssi: Int?,
    )

    private val wifiManager: WifiManager?
        get() = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager

    /** @throws IllegalStateException if the Wi-Fi service is unavailable (matches
     *  the plugin's reject on a null manager). */
    fun readWifiState(): WifiState {
        val manager = wifiManager
            ?: throw IllegalStateException("Wi-Fi service is unavailable on this device")
        @Suppress("DEPRECATION")
        val info = manager.connectionInfo
        val connected = info != null && info.networkId != -1
        return WifiState(
            enabled = manager.isWifiEnabled,
            connected = connected,
            rssi = if (connected && info != null) info.rssi else null,
        )
    }

    /**
     * Pure parsing of scan-result fields, shared with [WiFiPlugin]'s scan path.
     * These need no permissions or `Context`, so they are exercised directly by
     * the instrumented test even though the scan call itself stays in the plugin
     * (it requires location). Keeping them here keeps one definition of "what is
     * a secured network" / "what is the display SSID" (issue #9967).
     */
    companion object {
        /**
         * `WifiInfo.getSsid()` / some scan results wrap the SSID in quotes
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
}

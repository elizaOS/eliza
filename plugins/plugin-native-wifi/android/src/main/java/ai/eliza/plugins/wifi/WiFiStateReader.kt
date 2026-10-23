package ai.eliza.plugins.wifi

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build

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

    /** Internet reachability of the active network, as Android's own validation reports it. */
    data class Connectivity(
        /** The active network offers Internet access. */
        val online: Boolean,
        /** Android confirmed that the active network reaches the Internet. */
        val validated: Boolean,
        /** The active network needs a sign-in page before it reaches the Internet. */
        val captivePortal: Boolean,
        /** Name of the active Wi-Fi network, or null when it is not Wi-Fi or Android hides it. */
        val ssid: String?,
    )

    private val wifiManager: WifiManager?
        get() = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager

    /** @throws IllegalStateException if the connectivity service is unavailable. */
    fun readConnectivity(): Connectivity {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: throw IllegalStateException("Connectivity service is unavailable on this device")
        val caps = manager.activeNetwork?.let { manager.getNetworkCapabilities(it) }
        val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val wifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        return Connectivity(
            online = online,
            validated = online && caps!!.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            captivePortal = online && caps!!.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
            ssid = if (wifi) connectedSsid() else null,
        )
    }

    /** Name of the connected Wi-Fi network, or null when Android does not disclose it. */
    fun connectedSsid(): String? {
        @Suppress("DEPRECATION")
        val ssid = try {
            wifiManager?.connectionInfo?.ssid
        } catch (error: SecurityException) {
            // error-policy:J4 Android hides the name without location access; null means "not disclosed".
            null
        }
        return disclosedSsid(ssid)
    }

    /**
     * Name of the Wi-Fi [network] itself, or null when Android does not disclose
     * it or it cannot be tied to [network].
     *
     * On Android 12+ the name comes from [caps] of that network, which carries a
     * [WifiInfo] when the callback was registered with
     * `FLAG_INCLUDE_LOCATION_INFO` and the app has location access; this stays
     * correct with several concurrent Wi-Fi connections. Earlier Android has one
     * Wi-Fi station only, so `WifiManager.connectionInfo` describes [network]
     * exactly when [network] is the sole Wi-Fi network both before and after
     * the name is read.
     */
    fun networkSsid(manager: ConnectivityManager, network: Network, caps: NetworkCapabilities): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return disclosedSsid((caps.transportInfo as? WifiInfo)?.ssid)
        }
        if (!isSoleWifiNetwork(manager, network)) return null
        val ssid = connectedSsid() ?: return null
        return ssid.takeIf { isSoleWifiNetwork(manager, network) }
    }

    private fun isSoleWifiNetwork(manager: ConnectivityManager, network: Network): Boolean {
        @Suppress("DEPRECATION") // No synchronous replacement; a callback only reports asynchronously.
        val wifi = manager.allNetworks.filter {
            manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        }
        return wifi == listOf(network)
    }

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
        /** `WifiManager.UNKNOWN_SSID` (API 30), returned while Android hides the name. */
        private const val UNKNOWN_SSID = "<unknown ssid>"

        /** [raw] without quotes, or null when it is empty or Android's placeholder for a hidden name. */
        fun disclosedSsid(raw: String?): String? =
            trimQuotes(raw).takeUnless { it.isEmpty() || it == UNKNOWN_SSID }

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

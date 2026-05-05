package ai.eliza.plugins.wifi

import android.Manifest
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkRequest
import android.net.wifi.ScanResult
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Wi-Fi bridge for ElizaOS.
 *
 * Exposes a small set of methods over the standard `WifiManager` /
 * `ConnectivityManager` APIs. The connect path branches on API level:
 *  - API 29+ (Android 10+): `WifiNetworkSuggestion` is the supported way to
 *    request a connection without holding a system-signature permission.
 *    Legacy `WifiConfiguration.addNetwork` is deprecated and returns -1.
 *  - API 23–28: legacy `WifiConfiguration` + `enableNetwork` is still
 *    permitted for system / privileged callers like Eliza.
 */
@CapacitorPlugin(name = "ElizaWiFi")
class WiFiPlugin : Plugin() {
    private val wifiManager: WifiManager?
        get() = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager

    private val connectivityManager: ConnectivityManager?
        get() = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    /** Cache of the last scan completion timestamp for the `maxAge` shortcut. */
    private var lastScanCompletedAtMs: Long = 0L

    @PluginMethod
    fun getWifiState(call: PluginCall) {
        val manager = wifiManager
        if (manager == null) {
            call.reject("Wi-Fi service is unavailable on this device")
            return
        }
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
        call.resolve(result)
    }

    @PluginMethod
    fun getConnectedNetwork(call: PluginCall) {
        if (!hasPermission(Manifest.permission.ACCESS_WIFI_STATE)) {
            call.reject("ACCESS_WIFI_STATE permission is required")
            return
        }
        val manager = wifiManager
        if (manager == null) {
            call.reject("Wi-Fi service is unavailable on this device")
            return
        }
        val info = manager.connectionInfo
        val result = JSObject()
        if (info == null || info.networkId == -1) {
            result.put("network", JSObject.NULL)
            call.resolve(result)
            return
        }
        val network = JSObject()
        network.put("ssid", trimQuotes(info.ssid))
        network.put("bssid", info.bssid ?: "")
        network.put("rssi", info.rssi)
        network.put("frequency", info.frequency)
        network.put("capabilities", "")
        network.put("secured", false)
        result.put("network", network)
        call.resolve(result)
    }

    @PluginMethod
    fun listAvailableNetworks(call: PluginCall) {
        if (!hasPermission(Manifest.permission.ACCESS_WIFI_STATE)) {
            call.reject("ACCESS_WIFI_STATE permission is required")
            return
        }
        // scanResults is gated behind ACCESS_FINE_LOCATION on API 26+. Reject
        // with a clear message rather than letting the platform return an
        // empty list — callers can prompt for location and retry.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        ) {
            call.reject("ACCESS_FINE_LOCATION required for Wi-Fi scans on API 26+")
            return
        }
        val manager = wifiManager
        if (manager == null) {
            call.reject("Wi-Fi service is unavailable on this device")
            return
        }
        val maxAge = call.getInt("maxAge") ?: 30_000
        val limit = call.getInt("limit") ?: 0
        val now = System.currentTimeMillis()
        if (lastScanCompletedAtMs == 0L || now - lastScanCompletedAtMs > maxAge) {
            // startScan is best-effort and rate-limited on modern Android; the
            // returned boolean is informational only.
            manager.startScan()
            lastScanCompletedAtMs = now
        }
        val seenSsids = HashSet<String>()
        val networks = JSArray()
        val scanResults: List<ScanResult> = manager.scanResults ?: emptyList()
        // Sort by signal strength (closest / strongest first) for stable UI ordering.
        val sorted = scanResults.sortedByDescending { it.level }
        for (result in sorted) {
            val ssid = result.SSID ?: ""
            if (ssid.isEmpty()) continue
            if (!seenSsids.add(ssid)) continue
            val capabilities = result.capabilities ?: ""
            val entry = JSObject()
            entry.put("ssid", ssid)
            entry.put("bssid", result.BSSID ?: "")
            entry.put("rssi", result.level)
            entry.put("frequency", result.frequency)
            entry.put("capabilities", capabilities)
            entry.put("secured", isSecured(capabilities))
            networks.put(entry)
            if (limit > 0 && networks.length() >= limit) break
        }
        val response = JSObject()
        response.put("networks", networks)
        call.resolve(response)
    }

    @PluginMethod
    fun connectToNetwork(call: PluginCall) {
        if (!hasPermission(Manifest.permission.CHANGE_WIFI_STATE)) {
            call.reject("CHANGE_WIFI_STATE permission is required")
            return
        }
        val ssid = call.getString("ssid")?.trim()
        if (ssid.isNullOrEmpty()) {
            call.reject("ssid is required")
            return
        }
        val password = call.getString("password")
        val hidden = call.getBoolean("hidden") ?: false
        val manager = wifiManager
        if (manager == null) {
            call.reject("Wi-Fi service is unavailable on this device")
            return
        }
        val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            connectViaSuggestion(manager, ssid, password, hidden)
        } else {
            @Suppress("DEPRECATION")
            connectViaLegacyConfig(manager, ssid, password, hidden)
        }
        val response = JSObject()
        response.put("success", ok)
        if (!ok) {
            response.put("message", "Failed to request connection to $ssid")
        }
        call.resolve(response)
    }

    @PluginMethod
    fun disconnectFromNetwork(call: PluginCall) {
        if (!hasPermission(Manifest.permission.CHANGE_WIFI_STATE)) {
            call.reject("CHANGE_WIFI_STATE permission is required")
            return
        }
        val manager = wifiManager
        if (manager == null) {
            call.reject("Wi-Fi service is unavailable on this device")
            return
        }
        @Suppress("DEPRECATION")
        val ok = manager.disconnect()
        val response = JSObject()
        response.put("success", ok)
        if (!ok) {
            response.put("message", "WifiManager.disconnect() returned false")
        }
        call.resolve(response)
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Modern (API 29+) connect path. Adds a network suggestion plus a
     * matching `NetworkRequest` so the system attempts a connection on our
     * behalf. Returns true when the suggestion was accepted; the actual
     * connection state should be observed via `getConnectedNetwork`.
     */
    private fun connectViaSuggestion(
        manager: WifiManager,
        ssid: String,
        password: String?,
        hidden: Boolean,
    ): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        val suggestionBuilder = WifiNetworkSuggestion.Builder()
            .setSsid(ssid)
            .setIsHiddenSsid(hidden)
        if (!password.isNullOrEmpty()) {
            suggestionBuilder.setWpa2Passphrase(password)
        }
        val suggestion = suggestionBuilder.build()
        // Replace any prior suggestions for the same SSID before re-adding.
        manager.removeNetworkSuggestions(listOf(suggestion))
        val addStatus = manager.addNetworkSuggestions(listOf(suggestion))
        if (addStatus != WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
            return false
        }
        val specifierBuilder = WifiNetworkSpecifier.Builder()
            .setSsid(ssid)
            .setIsHiddenSsid(hidden)
        if (!password.isNullOrEmpty()) {
            specifierBuilder.setWpa2Passphrase(password)
        }
        val request = NetworkRequest.Builder()
            .addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI)
            .setNetworkSpecifier(specifierBuilder.build())
            .build()
        connectivityManager?.requestNetwork(request, NoOpNetworkCallback)
        return true
    }

    /**
     * Legacy connect path for API 23–28. Uses the deprecated
     * `WifiConfiguration` API which still works for system / privileged
     * callers (Eliza ships as a privileged system app).
     */
    @Suppress("DEPRECATION")
    private fun connectViaLegacyConfig(
        manager: WifiManager,
        ssid: String,
        password: String?,
        hidden: Boolean,
    ): Boolean {
        val config = WifiConfiguration()
        config.SSID = "\"$ssid\""
        config.hiddenSSID = hidden
        if (password.isNullOrEmpty()) {
            config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
        } else {
            config.preSharedKey = "\"$password\""
            config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
        }
        val networkId = manager.addNetwork(config)
        if (networkId == -1) return false
        manager.disconnect()
        val enabled = manager.enableNetwork(networkId, true)
        manager.reconnect()
        return enabled
    }

    /**
     * `WifiInfo.getSsid()` returns the SSID wrapped in quotes
     * (e.g. `"home-wifi"`). Strip them for display.
     */
    private fun trimQuotes(ssid: String?): String {
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
    private fun isSecured(capabilities: String): Boolean {
        if (capabilities.isEmpty()) return false
        val upper = capabilities.uppercase()
        return upper.contains("WPA") ||
            upper.contains("WEP") ||
            upper.contains("PSK") ||
            upper.contains("EAP") ||
            upper.contains("SAE")
    }

    /** No-op callback for the `requestNetwork` call — connection state is queried separately. */
    private object NoOpNetworkCallback : ConnectivityManager.NetworkCallback()
}

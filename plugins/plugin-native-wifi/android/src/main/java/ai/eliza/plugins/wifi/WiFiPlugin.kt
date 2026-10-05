/** Exposes Android Wi-Fi state and system-managed connection suggestions to Capacitor. */
package ai.eliza.plugins.wifi

import android.Manifest
import android.content.Context
import android.net.wifi.ScanResult
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
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

    /** Cache of the last scan completion timestamp for the `maxAge` shortcut. */
    private var lastScanCompletedAtMs: Long = 0L

    @PluginMethod
    fun getWifiState(call: PluginCall) {
        // Device read is delegated to WiFiStateReader so it can be exercised by
        // an instrumented androidTest without a Capacitor Bridge (issue #9967);
        // the JS wire shape below is unchanged.
        val state = try {
            WiFiStateReader(context).readWifiState()
        } catch (error: IllegalStateException) {
            call.reject(error.message ?: "Wi-Fi service is unavailable on this device")
            return
        }
        val result = JSObject()
        result.put("enabled", state.enabled)
        result.put("connected", state.connected)
        if (state.rssi != null) {
            result.put("rssi", state.rssi)
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
        network.put("ssid", WiFiStateReader.trimQuotes(info.ssid))
        network.put("bssid", info.bssid ?: "")
        network.put("rssi", info.rssi)
        network.put("frequency", info.frequency)
        network.put("capabilities", "")
        val secured = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            when (info.currentSecurityType) {
                WifiInfo.SECURITY_TYPE_UNKNOWN -> null
                WifiInfo.SECURITY_TYPE_OPEN, WifiInfo.SECURITY_TYPE_OWE -> false
                else -> true
            }
        } else if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            manager.scanResults.firstOrNull { it.BSSID == info.bssid }?.let {
                WiFiStateReader.isSecured(it.capabilities)
            }
        } else null
        if (secured == null) {
            call.reject("Android did not expose security details for the active Wi-Fi network", "NETWORK_SECURITY_UNAVAILABLE")
            return
        }
        network.put("secured", secured)
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
            entry.put("secured", WiFiStateReader.isSecured(capabilities))
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
        val ok = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WiFiConnectionRequests.suggest(manager, ssid, password, hidden)
            } else {
                @Suppress("DEPRECATION")
                connectViaLegacyConfig(manager, ssid, password, hidden)
            }
        } catch (error: IllegalArgumentException) {
            // error-policy:J3 Invalid SSIDs and passphrases reject before a connection is requested.
            call.reject("Invalid Wi-Fi connection options: ${error.message}", "INVALID_ARGUMENT", error)
            return
        } catch (error: SecurityException) {
            // error-policy:J1 Android permission and app-op denials cross the Capacitor boundary explicitly.
            call.reject("Android denied the Wi-Fi connection request", "PERMISSION_DENIED", error)
            return
        } catch (error: IllegalStateException) {
            // error-policy:J1 Service or suggestion replacement failures are not accepted connections.
            call.reject("Wi-Fi connection request failed: ${error.message}", "WIFI_REQUEST_FAILED", error)
            return
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

}

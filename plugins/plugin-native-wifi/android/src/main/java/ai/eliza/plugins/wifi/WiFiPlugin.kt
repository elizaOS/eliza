/** Exposes Android Wi-Fi state and system-managed connection suggestions to Capacitor. */
package ai.eliza.plugins.wifi

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.ScanResult
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.annotation.RequiresApi
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ConcurrentHashMap

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
 *
 * `addNetworkWithApproval` (API 30+) is for ordinary apps: it opens the
 * system "Save this network?" dialog and reports whether a validated or
 * captive-portal Wi-Fi network then appears.
 */
@CapacitorPlugin(name = "ElizaWiFi")
class WiFiPlugin : Plugin() {
    /**
     * Wi-Fi networks that already offered Internet when each approved-join
     * dialog opened, keyed by call id. Android reports these again as soon as
     * the result callback registers, so they must not count as the new join.
     */
    private val approvedJoinBaselines = ConcurrentHashMap<String, Set<Network>>()
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

    @PluginMethod
    fun getConnectivity(call: PluginCall) {
        val state = try {
            WiFiStateReader(context).readConnectivity()
        } catch (error: IllegalStateException) {
            call.reject(error.message ?: "Connectivity service is unavailable on this device")
            return
        }
        val result = JSObject()
        result.put("online", state.online)
        result.put("validated", state.validated)
        result.put("captivePortal", state.captivePortal)
        result.put("ssid", state.ssid ?: JSObject.NULL)
        call.resolve(result)
    }

    @PluginMethod
    fun addNetworkWithApproval(call: PluginCall) {
        val ssid = call.getString("ssid")?.trim()
        val password = call.getString("password")
        // The call stays saved while the system dialog is open; keep the passphrase out of it.
        call.data.remove("password")
        if (ssid.isNullOrEmpty()) {
            call.reject("ssid is required")
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("User-approved Wi-Fi join requires Android 11 or later", "UNSUPPORTED")
            return
        }
        val suggestion = try {
            WiFiConnectionRequests.build(ssid, password, call.getBoolean("hidden") ?: false)
        } catch (error: IllegalArgumentException) {
            // error-policy:J3 Invalid SSIDs and passphrases reject before the system dialog opens.
            call.reject("Invalid Wi-Fi connection options: ${error.message}", "INVALID_ARGUMENT", error)
            return
        }
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (manager == null) {
            call.reject("Connectivity service is unavailable on this device")
            return
        }
        approvedJoinBaselines[call.callbackId] = wifiInternetNetworks(manager)
        val intent = Intent(Settings.ACTION_WIFI_ADD_NETWORKS)
            .putParcelableArrayListExtra(Settings.EXTRA_WIFI_NETWORK_LIST, arrayListOf(suggestion))
        try {
            startActivityForResult(call, intent, "addNetworkResult")
        } catch (error: ActivityNotFoundException) {
            approvedJoinBaselines.remove(call.callbackId)
            // error-policy:J1 Some Android builds (for example Wear OS or TV) ship no add-network dialog.
            call.reject("This device has no system dialog for saving Wi-Fi networks", "UNSUPPORTED", error)
            bridge.releaseCall(call)
        }
    }

    @ActivityCallback
    @RequiresApi(Build.VERSION_CODES.R)
    private fun addNetworkResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        // Null when the app process was recreated while the dialog was open:
        // then no Wi-Fi network is known to be new, and each one needs its name confirmed.
        val baseline = approvedJoinBaselines.remove(call.callbackId)
        if (result.resultCode != Activity.RESULT_OK) {
            finishApprovedJoin(call, "declined")
            return
        }
        // Settings returns one code per submitted network; one network was submitted.
        val code = result.data?.getIntegerArrayListExtra(Settings.EXTRA_WIFI_NETWORK_RESULT_LIST)?.firstOrNull()
        if (code != null && code != Settings.ADD_WIFI_RESULT_SUCCESS && code != Settings.ADD_WIFI_RESULT_ALREADY_EXISTS) {
            call.reject("Android did not save the Wi-Fi network: $code", "WIFI_REQUEST_FAILED")
            bridge.releaseCall(call)
            return
        }
        awaitWifiInternet(call, call.getString("ssid")?.trim(), baseline)
    }

    /** Every Wi-Fi network that currently offers Internet, validated or not. */
    private fun wifiInternetNetworks(manager: ConnectivityManager): Set<Network> {
        @Suppress("DEPRECATION") // No synchronous replacement; a callback only reports asynchronously.
        val networks = manager.allNetworks
        return networks.filterTo(HashSet()) { network ->
            val caps = manager.getNetworkCapabilities(network)
            caps != null &&
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        }
    }

    /**
     * Resolves `connected` when the joined Wi-Fi network validates, `captivePortal`
     * when it needs a sign-in page first (it does not validate by itself), and
     * `notConnected` when neither is confirmed within [APPROVED_JOIN_TIMEOUT_MS].
     *
     * A network in [baseline] (or any network when [baseline] is null) was already
     * up before the dialog opened, so it counts only when Android discloses its
     * name and the name matches [ssid]. A network that appears afterwards counts
     * unless Android discloses a different name.
     */
    private fun awaitWifiInternet(call: PluginCall, ssid: String?, baseline: Set<Network>?) {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (manager == null) {
            call.reject("Connectivity service is unavailable on this device")
            bridge.releaseCall(call)
            return
        }
        val main = Handler(Looper.getMainLooper())
        val reader = WiFiStateReader(context)
        var settled = false
        lateinit var callback: ConnectivityManager.NetworkCallback
        lateinit var timeout: Runnable
        fun settle(status: String) {
            main.post {
                if (settled) return@post
                settled = true
                main.removeCallbacks(timeout)
                manager.unregisterNetworkCallback(callback)
                finishApprovedJoin(call, status)
            }
        }
        callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                val captive = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)
                if (!validated && !captive) return
                val connected = reader.connectedSsid()
                if (connected != null && connected != ssid) return
                val preexisting = baseline == null || network in baseline
                // Android hides the name without location access; an already-joined
                // network with a hidden name may be the old one, so it never counts.
                if (preexisting && connected == null) return
                settle(if (validated) "connected" else "captivePortal")
            }
        }
        timeout = Runnable { settle("notConnected") }
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try {
            manager.registerNetworkCallback(request, callback)
        } catch (error: RuntimeException) {
            // error-policy:J1 Android refused the network watch (for example too many callbacks).
            call.reject("Unable to watch the Wi-Fi network: ${error.message}", "WIFI_REQUEST_FAILED", error)
            bridge.releaseCall(call)
            return
        }
        main.postDelayed(timeout, APPROVED_JOIN_TIMEOUT_MS)
    }

    private fun finishApprovedJoin(call: PluginCall, status: String) {
        val result = JSObject()
        result.put("status", status)
        call.resolve(result)
        bridge.releaseCall(call)
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

    private companion object {
        /** Validation usually follows a join within seconds; a captive portal is reported at once. */
        const val APPROVED_JOIN_TIMEOUT_MS = 30_000L
    }
}

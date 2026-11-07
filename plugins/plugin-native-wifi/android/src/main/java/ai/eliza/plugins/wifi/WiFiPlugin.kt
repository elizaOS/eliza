/** Exposes Android Wi-Fi state and system-managed connection suggestions to Capacitor. */
package ai.eliza.plugins.wifi

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
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
import com.getcapacitor.annotation.Permission

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
 * system "Save this network?" dialog and reports whether the requested
 * network, identified by its own name, then validates or hits a captive portal.
 *
 * A host may register a subclass to limit the bridge: [enabled] is checked by
 * every method, including the permission methods. Capacitor does not inherit
 * the annotation, so the subclass declares its own `@CapacitorPlugin` with a
 * name and the [LOCATION] permission alias.
 */
@CapacitorPlugin(
    name = "ElizaWiFi",
    permissions = [
        // Asked together, as Android 12+ requires; only precise location lets a scan return results.
        Permission(
            alias = WiFiPlugin.LOCATION,
            strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION],
        ),
    ],
)
open class WiFiPlugin : Plugin() {
    private val wifiManager: WifiManager?
        get() = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager

    /** Cache of the last scan completion timestamp for the `maxAge` shortcut. */
    @Volatile
    private var lastScanCompletedAtMs: Long = 0L

    private val main by lazy { Handler(Looper.getMainLooper()) }

    /**
     * Whether this build exposes the Wi-Fi bridge. A host overrides it to
     * refuse every method, for example in a build that must never scan or join.
     */
    protected open fun enabled(): Boolean = true

    /** Rejects [call] with `DISABLED` when the host turned the bridge off. */
    private fun admitted(call: PluginCall): Boolean {
        if (enabled()) return true
        call.reject("Wi-Fi controls are turned off in this app", "DISABLED")
        return false
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        if (admitted(call)) super.checkPermissions(call)
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        if (admitted(call)) super.requestPermissions(call)
    }

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        if (!admitted(call)) return
        val result = JSObject()
        result.put("sdk", Build.VERSION.SDK_INT)
        result.put("approvedJoin", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && wifiManager != null)
        result.put("internetPanel", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        call.resolve(result)
    }

    /** Opens Android's internet panel (API 29+) over the app, where the user can pick any network. */
    @PluginMethod
    fun openInternetPanel(call: PluginCall) {
        if (!admitted(call)) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("The internet panel requires Android 10 or later", "UNSUPPORTED")
            return
        }
        // The bridge context is the activity, so the panel opens over the app.
        val intent = Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY)
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            call.resolve()
        } catch (error: ActivityNotFoundException) {
            // error-policy:J1 Some Android builds (for example Wear OS or TV) ship no internet panel.
            call.reject("This device has no internet panel", "UNSUPPORTED", error)
        }
    }

    @PluginMethod
    fun getWifiState(call: PluginCall) {
        if (!admitted(call)) return
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
        if (!admitted(call)) return
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
        } else if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            // An explicit platform check, so a consuming app's lint sees the guard.
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
        if (!admitted(call)) return
        if (!hasPermission(Manifest.permission.ACCESS_WIFI_STATE)) {
            call.reject("ACCESS_WIFI_STATE permission is required")
            return
        }
        // scanResults is gated behind ACCESS_FINE_LOCATION on API 26+. Reject
        // with a clear message rather than letting the platform return an
        // empty list — callers can request the `location` alias and retry.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        ) {
            call.reject("ACCESS_FINE_LOCATION required for Wi-Fi scans on API 26+", "LOCATION_PERMISSION_REQUIRED")
            return
        }
        val manager = wifiManager
        if (manager == null) {
            call.reject("Wi-Fi service is unavailable on this device")
            return
        }
        // With Location off Android returns no scan results; that is not "no networks".
        if (!locationEnabled()) {
            call.reject("Location is turned off, so Android returns no Wi-Fi scan results", "LOCATION_DISABLED")
            return
        }
        val maxAge = call.getInt("maxAge") ?: 30_000
        val limit = call.getInt("limit") ?: 0
        val joinable = call.getBoolean("joinable") ?: false
        val timeout = (call.getInt("timeout") ?: DEFAULT_SCAN_TIMEOUT_MS.toInt()).coerceIn(0, MAX_SCAN_TIMEOUT_MS.toInt())
        val now = System.currentTimeMillis()
        if (lastScanCompletedAtMs != 0L && now - lastScanCompletedAtMs <= maxAge) {
            resolveNetworks(call, manager, limit, joinable)
            return
        }
        // startScan is rate-limited on modern Android. When it starts, wait for
        // its results (or the timeout); when throttled, the cached results are
        // the best answer now.
        var settled = false
        lateinit var receiver: BroadcastReceiver
        lateinit var deadline: Runnable
        fun finish() {
            if (settled) return
            settled = true
            main.removeCallbacks(deadline)
            try {
                context.unregisterReceiver(receiver)
            } catch (error: IllegalArgumentException) {
                // error-policy:J4 Already unregistered; nothing is left to release.
            }
            lastScanCompletedAtMs = System.currentTimeMillis()
            resolveNetworks(call, manager, limit, joinable)
        }
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                main.post { finish() }
            }
        }
        deadline = Runnable { finish() }
        registerSystemReceiver(receiver, IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION))
        @Suppress("DEPRECATION")
        val started = try {
            manager.startScan()
        } catch (error: SecurityException) {
            // error-policy:J4 A refused scan falls back to the cached results, as a throttled one does.
            false
        }
        if (started) main.postDelayed(deadline, timeout.toLong()) else main.post { finish() }
    }

    private fun resolveNetworks(call: PluginCall, manager: WifiManager, limit: Int, joinable: Boolean) {
        val scanResults: List<ScanResult> = try {
            manager.scanResults ?: emptyList()
        } catch (error: SecurityException) {
            // error-policy:J1 Location access was withdrawn while the scan ran.
            call.reject("Android denied the Wi-Fi scan results", "LOCATION_PERMISSION_REQUIRED", error)
            return
        }
        val seenSsids = HashSet<String>()
        val networks = JSArray()
        // Sort by signal strength (closest / strongest first) for stable UI ordering.
        val sorted = scanResults.sortedByDescending { it.level }
        for (result in sorted) {
            // Hidden networks report an empty or all-NUL name.
            val ssid = WiFiStateReader.disclosedSsid(result.SSID) ?: continue
            val capabilities = result.capabilities ?: ""
            val security = WiFiStateReader.securityType(capabilities)
            if (joinable && !WiFiStateReader.joinable(security)) continue
            if (!seenSsids.add(ssid)) continue
            val entry = JSObject()
            entry.put("ssid", ssid)
            entry.put("bssid", result.BSSID ?: "")
            entry.put("rssi", result.level)
            entry.put("frequency", result.frequency)
            entry.put("capabilities", capabilities)
            entry.put("secured", WiFiStateReader.isSecured(capabilities))
            entry.put("security", security)
            networks.put(entry)
            if (limit > 0 && networks.length() >= limit) break
        }
        val response = JSObject()
        response.put("networks", networks)
        call.resolve(response)
    }

    @PluginMethod
    fun connectToNetwork(call: PluginCall) {
        if (!admitted(call)) return
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
        val security = call.getString("security")
        val manager = wifiManager
        if (manager == null) {
            call.reject("Wi-Fi service is unavailable on this device")
            return
        }
        val ok = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WiFiConnectionRequests.suggest(manager, ssid, password, hidden, security)
            } else {
                @Suppress("DEPRECATION")
                connectViaLegacyConfig(manager, ssid, password, hidden, security)
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
        if (!admitted(call)) return
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
        if (!admitted(call)) return
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
        val password = call.getString("password")
        // The call stays saved while the system dialog is open; keep the passphrase out of it.
        call.data.remove("password")
        if (!admitted(call)) return
        val ssid = call.getString("ssid")?.trim()
        if (ssid.isNullOrEmpty()) {
            call.reject("ssid is required")
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("User-approved Wi-Fi join requires Android 11 or later", "UNSUPPORTED")
            return
        }
        val suggestion = try {
            WiFiConnectionRequests.build(ssid, password, call.getBoolean("hidden") ?: false, call.getString("security"))
        } catch (error: IllegalArgumentException) {
            // error-policy:J3 Invalid SSIDs, passphrases and security types reject before the system dialog opens.
            call.reject("Invalid Wi-Fi connection options: ${error.message}", "INVALID_ARGUMENT", error)
            return
        } catch (error: IllegalStateException) {
            // error-policy:J3 Android's builder refused the combination (for example WPA3 on a device without it).
            call.reject("Invalid Wi-Fi connection options: ${error.message}", "INVALID_ARGUMENT", error)
            return
        }
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (manager == null) {
            call.reject("Connectivity service is unavailable on this device")
            return
        }
        // Only whether a password was given stays with the saved call, for the wrong-password report.
        call.data.put("secured", !password.isNullOrEmpty())
        val intent = Intent(Settings.ACTION_WIFI_ADD_NETWORKS)
            .putParcelableArrayListExtra(Settings.EXTRA_WIFI_NETWORK_LIST, arrayListOf(suggestion))
        try {
            startActivityForResult(call, intent, "addNetworkResult")
        } catch (error: ActivityNotFoundException) {
            // error-policy:J1 Some Android builds (for example Wear OS or TV) ship no add-network dialog.
            call.reject("This device has no system dialog for saving Wi-Fi networks", "UNSUPPORTED", error)
            bridge.releaseCall(call)
        }
    }

    @ActivityCallback
    @RequiresApi(Build.VERSION_CODES.R)
    private fun addNetworkResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) {
            finishApprovedJoin(call, ApprovedJoinTracker.STATUS_DECLINED)
            return
        }
        // Settings returns one code per submitted network; one network was submitted.
        val code = result.data?.getIntegerArrayListExtra(Settings.EXTRA_WIFI_NETWORK_RESULT_LIST)?.firstOrNull()
        if (code != null && code != Settings.ADD_WIFI_RESULT_SUCCESS && code != Settings.ADD_WIFI_RESULT_ALREADY_EXISTS) {
            call.reject("Android did not save the Wi-Fi network: $code", "WIFI_REQUEST_FAILED")
            bridge.releaseCall(call)
            return
        }
        val ssid = call.getString("ssid")?.trim()
        if (ssid.isNullOrEmpty()) {
            call.reject("ssid is required")
            bridge.releaseCall(call)
            return
        }
        awaitWifiInternet(call, ssid, call.getBoolean("secured") ?: false)
    }

    /**
     * Resolves `connected` when the Wi-Fi network named [ssid] validates and
     * `captivePortal` when it needs a sign-in page first. The name is read from
     * each reported network itself (see [WiFiStateReader.networkSsid]), so
     * another Wi-Fi network, such as the one the device was already on, never
     * counts. Without a match within [APPROVED_JOIN_TIMEOUT_MS] it resolves
     * `unverified` when Android reported a working Wi-Fi network whose name it
     * withheld, and `notConnected` otherwise (see [ApprovedJoinTracker]). A
     * supplicant authentication error for a [secured] join resolves
     * `wrongPassword`; that report is best-effort and not sent on every build.
     */
    private fun awaitWifiInternet(call: PluginCall, ssid: String, secured: Boolean) {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (manager == null) {
            call.reject("Connectivity service is unavailable on this device")
            bridge.releaseCall(call)
            return
        }
        val reader = WiFiStateReader(context)
        // Touched only on the main thread.
        val tracker = ApprovedJoinTracker(ssid, secured)
        var settled = false
        lateinit var callback: ConnectivityManager.NetworkCallback
        lateinit var timeout: Runnable
        lateinit var supplicant: BroadcastReceiver
        fun settle(status: String) {
            if (settled) return
            settled = true
            main.removeCallbacks(timeout)
            manager.unregisterNetworkCallback(callback)
            try {
                context.unregisterReceiver(supplicant)
            } catch (error: IllegalArgumentException) {
                // error-policy:J4 Never registered (the network watch failed first).
            }
            finishApprovedJoin(call, status)
        }
        val onCapabilities = { network: Network, caps: NetworkCapabilities ->
            val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val captive = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)
            if (validated || captive) {
                // Read on the callback thread, from this network's own capabilities.
                val networkSsid = reader.networkSsid(manager, network, caps)
                main.post {
                    if (!settled) tracker.observe(networkSsid, validated, captive)?.let { settle(it) }
                }
            }
        }
        callback = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Location info puts the network's own WifiInfo, with its name, in caps.
            object : ConnectivityManager.NetworkCallback(FLAG_INCLUDE_LOCATION_INFO) {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    onCapabilities(network, caps)
                }
            }
        } else {
            object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    onCapabilities(network, caps)
                }
            }
        }
        timeout = Runnable { settle(tracker.timeoutStatus()) }
        supplicant = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                @Suppress("DEPRECATION")
                val failed = intent.getIntExtra(WifiManager.EXTRA_SUPPLICANT_ERROR, 0) == WifiManager.ERROR_AUTHENTICATING
                if (failed) main.post { if (!settled) tracker.authenticationFailed()?.let { settle(it) } }
            }
        }
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
        @Suppress("DEPRECATION")
        registerSystemReceiver(supplicant, IntentFilter(WifiManager.SUPPLICANT_STATE_CHANGED_ACTION))
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

    /** Registers [receiver] for an Android system broadcast; other apps cannot send to it. */
    private fun registerSystemReceiver(receiver: BroadcastReceiver, filter: IntentFilter) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(receiver, filter)
        }
    }

    private fun locationEnabled(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val location = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            return location?.isLocationEnabled == true
        }
        @Suppress("DEPRECATION")
        return Settings.Secure.getInt(context.contentResolver, Settings.Secure.LOCATION_MODE, Settings.Secure.LOCATION_MODE_OFF) !=
            Settings.Secure.LOCATION_MODE_OFF
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
        security: String?,
    ): Boolean {
        // Before Android 10 only WPA2 and open networks can be configured this way.
        val resolved = WiFiConnectionRequests.security(password, security)
        require(resolved == WiFiStateReader.SECURITY_WPA2 || resolved == WiFiStateReader.SECURITY_OPEN) {
            "Wi-Fi security '$resolved' requires Android 10 or later"
        }
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

    companion object {
        /** The permission alias for scans: precise and approximate location, asked together. */
        const val LOCATION = "location"

        /** Validation usually follows a join within seconds; a captive portal is reported at once. */
        private const val APPROVED_JOIN_TIMEOUT_MS = 30_000L

        /** How long a started scan waits for its results before the cached ones are read. */
        private const val DEFAULT_SCAN_TIMEOUT_MS = 10_000L
        private const val MAX_SCAN_TIMEOUT_MS = 30_000L
    }
}

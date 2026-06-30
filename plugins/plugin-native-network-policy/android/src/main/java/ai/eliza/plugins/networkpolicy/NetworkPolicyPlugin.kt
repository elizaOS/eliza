package ai.eliza.plugins.networkpolicy

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Android `metered` hint bridge for the voice-model auto-updater
 * (R5-versioning §4.1).
 *
 * Reads `ConnectivityManager.getNetworkCapabilities(activeNetwork)
 * .hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)`.
 *
 * Android explicitly warns: "Do not assume that cellular means metered.
 * On many devices a tethered Wi-Fi hotspot reports `wifi` as the transport
 * but is metered, and on others a corporate cellular plan reports as
 * not-metered." The metered flag is the only authoritative source.
 *
 * Returned shape (mirrors the TS `MeteredHint` interface):
 *
 *   { metered: true | false | null, source: "android-os" }
 *
 * `null` is returned when there is no active network, when the
 * `NetworkCapabilities` object is unavailable (lock-screen / boot races),
 * or when the system lacks `ACCESS_NETWORK_STATE` permission — the TS
 * side then downgrades to `unknown → ask`.
 */
@CapacitorPlugin(name = "ElizaNetworkPolicy")
class NetworkPolicyPlugin : Plugin() {
    @PluginMethod
    fun getMeteredHint(call: PluginCall) {
        call.resolve(NetworkPolicyReader.readMeteredHint(context))
    }

    @PluginMethod
    fun getPathHints(call: PluginCall) {
        call.resolve(NetworkPolicyReader.readPathHints())
    }
}

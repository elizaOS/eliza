package ai.eliza.plugins.networkpolicy

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.getcapacitor.JSObject
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
    private val connectivityManager: ConnectivityManager?
        get() = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    @PluginMethod
    fun getMeteredHint(call: PluginCall) {
        val response = JSObject()
        response.put("source", "android-os")
        val cm = connectivityManager
        if (cm == null) {
            response.put("metered", JSObject.NULL)
            call.resolve(response)
            return
        }
        val active = try {
            cm.activeNetwork
        } catch (t: Throwable) {
            null
        }
        if (active == null) {
            response.put("metered", JSObject.NULL)
            call.resolve(response)
            return
        }
        val caps: NetworkCapabilities? = try {
            cm.getNetworkCapabilities(active)
        } catch (t: SecurityException) {
            // Missing ACCESS_NETWORK_STATE. Surface as unknown rather than
            // throw — the caller will downgrade to `ask`.
            null
        } catch (t: Throwable) {
            null
        }
        if (caps == null) {
            response.put("metered", JSObject.NULL)
            call.resolve(response)
            return
        }
        // `hasCapability(NET_CAPABILITY_NOT_METERED)` is true when the link
        // is NOT metered. We surface the inverse (whether it IS metered)
        // because that's the field the TS decision rule consumes.
        val notMetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        response.put("metered", !notMetered)
        call.resolve(response)
    }

    /**
     * iOS-only stub on Android. Always resolves with a placeholder shape so
     * the TS bridge can call `getPathHints()` uniformly across platforms;
     * the TS layer treats a never-expensive / never-constrained Android
     * response as "no info" and falls back to `getMeteredHint`.
     */
    @PluginMethod
    fun getPathHints(call: PluginCall) {
        val response = JSObject()
        response.put("isExpensive", false)
        response.put("isConstrained", false)
        response.put("source", "nw-path-monitor")
        call.resolve(response)
    }
}

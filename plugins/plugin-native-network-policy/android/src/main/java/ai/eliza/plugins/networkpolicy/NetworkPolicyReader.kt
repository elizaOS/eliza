package ai.eliza.plugins.networkpolicy

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.getcapacitor.JSObject

/**
 * Pure, Bridge-free reads of the network metered/path hints [NetworkPolicyPlugin]
 * exposes to the voice-model auto-updater.
 *
 * Extracted out of the plugin so the real `ConnectivityManager` metered read
 * can be exercised by an on-device instrumented test (#9967) without a mocked
 * Capacitor bridge. [NetworkPolicyPlugin] delegates here, so behavior — and the
 * `{ metered, source }` / `{ isExpensive, isConstrained, source }` wire shapes —
 * is unchanged.
 */
object NetworkPolicyReader {
    /**
     * `{ metered: true|false|null, source: "android-os" }`. `metered` is null
     * when there is no active network, the capabilities are unavailable
     * (lock-screen / boot races), or `ACCESS_NETWORK_STATE` is missing — the
     * defensive catches surface "unknown" rather than throwing, exactly as the
     * TS decision rule expects.
     */
    fun readMeteredHint(context: Context): JSObject {
        val response = JSObject()
        response.put("source", "android-os")
        val cm = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (cm == null) {
            response.put("metered", JSObject.NULL)
            return response
        }
        val active = try {
            cm.activeNetwork
        } catch (t: Throwable) {
            null
        }
        if (active == null) {
            response.put("metered", JSObject.NULL)
            return response
        }
        val caps: NetworkCapabilities? = try {
            cm.getNetworkCapabilities(active)
        } catch (t: SecurityException) {
            null
        } catch (t: Throwable) {
            null
        }
        if (caps == null) {
            response.put("metered", JSObject.NULL)
            return response
        }
        // hasCapability(NET_CAPABILITY_NOT_METERED) is true when NOT metered; the
        // TS rule consumes the inverse (whether it IS metered).
        val notMetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        response.put("metered", !notMetered)
        return response
    }

    /** iOS-only path hints; on Android always the safe "no info" shape. */
    fun readPathHints(): JSObject {
        val response = JSObject()
        response.put("isExpensive", false)
        response.put("isConstrained", false)
        response.put("source", "nw-path-monitor")
        return response
    }
}

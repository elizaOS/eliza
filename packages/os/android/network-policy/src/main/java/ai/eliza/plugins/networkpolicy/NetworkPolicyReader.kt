package ai.eliza.plugins.networkpolicy

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.getcapacitor.JSObject

/**
 * Bridge-free reads of the active network's cost (spec/os/android/networkPolicy.md):
 * the metered hint [NetworkPolicyPlugin] answers, and the one-snapshot link state an
 * agent's own download admission reads. Every failure is unknown, never an exception.
 */
object NetworkPolicyReader {
    /** One fresh capability snapshot for the detached agent's download admission. */
    fun readNetworkState(context: Context): JSObject {
        val response = JSObject()
        response.put("connectionType", "unknown")
        response.put("metered", JSObject.NULL)
        response.put("source", "android-os")
        val cm = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return response
        try {
            val active = cm.activeNetwork
            if (active == null) {
                response.put("connectionType", "none")
                return response
            }
            val caps = cm.getNetworkCapabilities(active) ?: return response
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
                !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return response
            val transport = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                else -> "unknown"
            }
            response.put("connectionType", transport)
            response.put("metered", !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
        } catch (_: SecurityException) {
        }
        return response
    }

    /** `{ metered: true|false|null, source: "android-os" }`; null when Android did not answer. */
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
        val notMetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        response.put("metered", !notMetered)
        return response
    }
}

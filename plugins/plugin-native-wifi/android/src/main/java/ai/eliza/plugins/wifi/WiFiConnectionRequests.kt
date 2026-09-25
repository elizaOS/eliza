/** Submits Internet Wi-Fi suggestions without retaining local-only network callbacks. */
package ai.eliza.plugins.wifi

import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import android.annotation.TargetApi

@TargetApi(Build.VERSION_CODES.Q)
internal object WiFiConnectionRequests {
    fun suggest(manager: WifiManager, ssid: String, password: String?, hidden: Boolean): Boolean {
        require(ssid.toByteArray(Charsets.UTF_8).size in 1..32) { "SSID must contain 1 to 32 UTF-8 bytes" }
        if (!password.isNullOrEmpty()) {
            require(password.length in 8..63 && password.all { it.code in 32..126 }) {
                "WPA2 passphrase must contain 8 to 63 printable ASCII characters"
            }
        }
        val builder = WifiNetworkSuggestion.Builder().setSsid(ssid).setIsHiddenSsid(hidden)
        if (!password.isNullOrEmpty()) builder.setWpa2Passphrase(password)
        val suggestion = builder.build()
        // Updating a suggestion is supported directly from Android 11. On Android
        // 10 remove the same network identity before replacing its configuration.
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
            val removed = manager.removeNetworkSuggestions(listOf(suggestion))
            check(removed == WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
                "Unable to replace Wi-Fi suggestion: $removed"
            }
        }
        return manager.addNetworkSuggestions(listOf(suggestion)) == WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS
    }
}

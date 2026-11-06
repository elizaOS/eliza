/** Submits Internet Wi-Fi suggestions without retaining local-only network callbacks. */
package ai.eliza.plugins.wifi

import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import android.annotation.TargetApi

@TargetApi(Build.VERSION_CODES.Q)
internal object WiFiConnectionRequests {
    /**
     * The security to join with. Without a [requested] security the network is WPA2 when a
     * [password] is given and open otherwise, as before. Pure and Android-free, so JVM tests
     * cover it.
     *
     * @throws IllegalArgumentException for a security a suggestion cannot join (EAP, WEP or an
     *   unknown name), a password for an open network, or a passphrase Android would refuse.
     */
    fun security(password: String?, requested: String?): String {
        val hasPassword = !password.isNullOrEmpty()
        val security = requested ?: if (hasPassword) WiFiStateReader.SECURITY_WPA2 else WiFiStateReader.SECURITY_OPEN
        when (security) {
            WiFiStateReader.SECURITY_OPEN, WiFiStateReader.SECURITY_OWE ->
                require(!hasPassword) { "An open network takes no password" }
            WiFiStateReader.SECURITY_WPA2 ->
                require(password != null && password.length in 8..63 && printable(password)) {
                    "WPA2 passphrase must contain 8 to 63 printable ASCII characters"
                }
            WiFiStateReader.SECURITY_WPA3 ->
                require(password != null && password.length in 1..63 && printable(password)) {
                    "WPA3 passphrase must contain 1 to 63 printable ASCII characters"
                }
            else -> throw IllegalArgumentException("Wi-Fi security '$security' cannot be joined from an app")
        }
        return security
    }

    private fun printable(value: String) = value.all { it.code in 32..126 }

    /** Builds one validated Internet suggestion; shared by the direct and user-approved paths. */
    fun build(ssid: String, password: String?, hidden: Boolean, security: String? = null): WifiNetworkSuggestion {
        require(ssid.toByteArray(Charsets.UTF_8).size in 1..32) { "SSID must contain 1 to 32 UTF-8 bytes" }
        val builder = WifiNetworkSuggestion.Builder().setSsid(ssid).setIsHiddenSsid(hidden)
        when (security(password, security)) {
            WiFiStateReader.SECURITY_OWE -> builder.setIsEnhancedOpen(true)
            WiFiStateReader.SECURITY_WPA2 -> builder.setWpa2Passphrase(password!!)
            WiFiStateReader.SECURITY_WPA3 -> builder.setWpa3Passphrase(password!!)
        }
        return builder.build()
    }

    fun suggest(manager: WifiManager, ssid: String, password: String?, hidden: Boolean, security: String? = null): Boolean {
        val suggestion = build(ssid, password, hidden, security)
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

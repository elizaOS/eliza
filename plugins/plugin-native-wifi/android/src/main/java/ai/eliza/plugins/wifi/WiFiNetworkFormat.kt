package ai.eliza.plugins.wifi

/**
 * Pure formatting helpers for Android Wi-Fi data, extracted from [WiFiPlugin] so
 * they can be unit-tested without an Android device (see `WiFiNetworkFormatTest`).
 * No Android framework dependencies — string-in, value-out.
 */
object WiFiNetworkFormat {
    /**
     * `WifiInfo.getSsid()` returns the SSID wrapped in quotes
     * (e.g. `"home-wifi"`). Strip them for display.
     */
    fun trimQuotes(ssid: String?): String {
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
    fun isSecured(capabilities: String): Boolean {
        if (capabilities.isEmpty()) return false
        val upper = capabilities.uppercase()
        return upper.contains("WPA") ||
            upper.contains("WEP") ||
            upper.contains("PSK") ||
            upper.contains("EAP") ||
            upper.contains("SAE")
    }
}

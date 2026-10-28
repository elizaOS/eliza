package ai.eliza.plugins.wifi

/**
 * Decides the `addNetworkWithApproval` outcome from what Android reports about
 * each Wi-Fi network after the user saved [requestedSsid].
 *
 * `connected` and `captivePortal` need a positive identity match: the name of
 * the network that validated (or hit a captive portal) must equal
 * [requestedSsid]. A network whose name Android withholds (no location access,
 * Location off, or a name that cannot be tied to that network) never counts as
 * the requested one; it only makes the timeout report `unverified` instead of
 * `notConnected`. A network with a different disclosed name is ignored.
 *
 * Pure and Android-free so the decision runs in JVM unit tests.
 */
internal class ApprovedJoinTracker(private val requestedSsid: String) {
    private var sawUnidentified = false

    /**
     * Records one network report. [networkSsid] is the name of that network
     * itself, or null when Android does not disclose it.
     *
     * @return the status to resolve with now, or null to keep waiting.
     */
    fun observe(networkSsid: String?, validated: Boolean, captivePortal: Boolean): String? {
        if (!validated && !captivePortal) return null
        if (networkSsid == null) {
            sawUnidentified = true
            return null
        }
        if (networkSsid != requestedSsid) return null
        return if (validated) STATUS_CONNECTED else STATUS_CAPTIVE_PORTAL
    }

    /** The status when no network matching [requestedSsid] was confirmed in time. */
    fun timeoutStatus(): String = if (sawUnidentified) STATUS_UNVERIFIED else STATUS_NOT_CONNECTED

    companion object {
        const val STATUS_CONNECTED = "connected"
        const val STATUS_CAPTIVE_PORTAL = "captivePortal"
        const val STATUS_UNVERIFIED = "unverified"
        const val STATUS_NOT_CONNECTED = "notConnected"
        const val STATUS_DECLINED = "declined"
    }
}

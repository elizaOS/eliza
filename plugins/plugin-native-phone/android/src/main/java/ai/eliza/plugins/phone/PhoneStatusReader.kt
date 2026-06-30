package ai.eliza.plugins.phone

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telecom.TelecomManager

/**
 * Pure, [Context]-backed reader for the dialer status that [PhonePlugin.getStatus]
 * exposes (TelecomManager presence, default-dialer ownership, call permission).
 *
 * Extracted from the Capacitor plugin so the real `TelecomManager` read can be
 * exercised by an instrumented `androidTest` on a real device, without a
 * Capacitor `Bridge`/WebView (issue #9967). This is the exact native side-effect
 * that distinguishes a working dialer view from the web stub the issue warns
 * about ("the dialer renders the web stub or errors"): a real default-dialer
 * package vs. nothing. The place-call / open-dialer write paths stay in
 * [PhonePlugin]. `context.checkSelfPermission` matches Capacitor's
 * `Plugin.hasPermission`, so the JS wire shape is unchanged.
 */
class PhoneStatusReader(private val context: Context) {

    data class PhoneStatus(
        val hasTelecom: Boolean,
        val canPlaceCalls: Boolean,
        val defaultDialerPackage: String?,
        val isDefaultDialer: Boolean,
    )

    fun readStatus(): PhoneStatus {
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        val dialer = telecom?.defaultDialerPackage
        return PhoneStatus(
            hasTelecom = telecom != null,
            canPlaceCalls = context.checkSelfPermission(Manifest.permission.CALL_PHONE) ==
                PackageManager.PERMISSION_GRANTED,
            defaultDialerPackage = dialer,
            isDefaultDialer = dialer == context.packageName,
        )
    }
}

package ai.eliza.plugins.phone

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telecom.TelecomManager
import com.getcapacitor.JSObject

/**
 * Pure, Bridge-free read of the device's telecom/dialer status.
 *
 * Extracted out of [PhonePlugin.getStatus] so the `TelecomManager` + dialer-
 * ownership read (which gates the launcher's Phone surface) can be exercised by
 * an on-device instrumented test (#9967) without a mocked Capacitor bridge.
 * [PhonePlugin] delegates here, so behavior is unchanged. The CALL_PHONE check
 * mirrors the plugin's bridge-provided `hasPermission` via the same
 * `checkSelfPermission` the support library calls underneath.
 */
object PhoneStatus {
    /**
     * Reads telecom availability + dialer ownership from the real services.
     * Returns `{ hasTelecom, canPlaceCalls, defaultDialerPackage, isDefaultDialer }`.
     */
    fun read(context: Context): JSObject {
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        val result = JSObject()
        result.put("hasTelecom", telecom != null)
        result.put("canPlaceCalls", hasCallPhonePermission(context))
        result.put("defaultDialerPackage", telecom?.defaultDialerPackage)
        result.put("isDefaultDialer", telecom?.defaultDialerPackage == context.packageName)
        return result
    }

    private fun hasCallPhonePermission(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED
}

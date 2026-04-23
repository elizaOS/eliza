package ai.eliza.plugins.phone

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.telecom.TelecomManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "MiladyPhone")
class PhonePlugin : Plugin() {
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        val result = JSObject()
        result.put("hasTelecom", telecom != null)
        result.put("canPlaceCalls", hasPermission(Manifest.permission.CALL_PHONE))
        result.put("defaultDialerPackage", telecom?.defaultDialerPackage)
        call.resolve(result)
    }

    @PluginMethod
    fun placeCall(call: PluginCall) {
        val number = call.getString("number")?.trim()
        if (number.isNullOrEmpty()) {
            call.reject("number is required")
            return
        }
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        if (telecom == null) {
            call.reject("Telecom service is unavailable")
            return
        }
        try {
            telecom.placeCall(Uri.parse("tel:$number"), Bundle())
            call.resolve()
        } catch (error: SecurityException) {
            call.reject("CALL_PHONE permission is required", error)
        }
    }

    @PluginMethod
    fun openDialer(call: PluginCall) {
        val number = call.getString("number")?.trim()
        val uri = if (number.isNullOrEmpty()) Uri.parse("tel:") else Uri.parse("tel:$number")
        val intent = Intent(Intent.ACTION_DIAL, uri)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }
}

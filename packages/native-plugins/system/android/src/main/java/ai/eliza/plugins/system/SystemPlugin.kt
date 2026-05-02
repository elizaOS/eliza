package ai.eliza.plugins.system

import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.provider.Telephony
import android.telecom.TelecomManager
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "ElizaSystem")
class SystemPlugin : Plugin() {
    private val roleMap = mapOf(
        "home" to RoleManager.ROLE_HOME,
        "dialer" to RoleManager.ROLE_DIALER,
        "sms" to RoleManager.ROLE_SMS,
        "assistant" to RoleManager.ROLE_ASSISTANT
    )

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val result = JSObject()
        val roles = JSArray()
        result.put("packageName", context.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = context.getSystemService(Context.ROLE_SERVICE) as RoleManager
            for ((name, androidRole) in roleMap) {
                val role = JSObject()
                val available = roleManager.isRoleAvailable(androidRole)
                val holders = if (available) roleHolders(name) else emptyList()
                val held = holders.contains(context.packageName)
                role.put("role", name)
                role.put("androidRole", androidRole)
                role.put("available", available)
                role.put("held", held)
                role.put("holders", JSArray(holders))
                roles.put(role)
            }
        }
        result.put("roles", roles)
        call.resolve(result)
    }

    @PluginMethod
    fun requestRole(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Android role requests require Android 10 or newer")
            return
        }

        val roleName = call.getString("role")?.trim()
        val androidRole = roleMap[roleName]
        if (roleName.isNullOrEmpty() || androidRole == null) {
            call.reject("role must be one of ${roleMap.keys.joinToString(", ")}")
            return
        }

        val roleManager = context.getSystemService(Context.ROLE_SERVICE) as RoleManager
        if (!roleManager.isRoleAvailable(androidRole)) {
            call.reject("$androidRole is not available on this device")
            return
        }

        if (roleManager.isRoleHeld(androidRole)) {
            call.resolve(roleRequestResult(roleName, true, 0))
            return
        }

        startActivityForResult(
            call,
            roleManager.createRequestRoleIntent(androidRole),
            "handleRoleRequestResult"
        )
    }

    @ActivityCallback
    private fun handleRoleRequestResult(call: PluginCall, result: ActivityResult) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Android role requests require Android 10 or newer")
            return
        }

        val roleName = call.getString("role")?.trim()
        val androidRole = roleMap[roleName]
        if (roleName.isNullOrEmpty() || androidRole == null) {
            call.reject("role must be one of ${roleMap.keys.joinToString(", ")}")
            return
        }

        val roleManager = context.getSystemService(Context.ROLE_SERVICE) as RoleManager
        call.resolve(roleRequestResult(roleName, roleManager.isRoleHeld(androidRole), result.resultCode))
    }

    private fun roleHolders(name: String): List<String> {
        return when (name) {
            "home" -> listOfNotNull(resolveHomePackage())
            "dialer" -> listOfNotNull(resolveDefaultDialerPackage())
            "sms" -> listOfNotNull(Telephony.Sms.getDefaultSmsPackage(context))
            "assistant" -> listOfNotNull(resolveAssistantPackage())
            else -> emptyList()
        }
    }

    private fun resolveHomePackage(): String? {
        val intent = Intent(Intent.ACTION_MAIN)
        intent.addCategory(Intent.CATEGORY_HOME)
        val resolved = context.packageManager.resolveActivity(intent, 0)
        return resolved?.activityInfo?.packageName
    }

    private fun resolveDefaultDialerPackage(): String? {
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        return telecom?.defaultDialerPackage
    }

    private fun resolveAssistantPackage(): String? {
        val flattened = Settings.Secure.getString(context.contentResolver, "assistant")
        if (flattened.isNullOrBlank()) return null
        return ComponentName.unflattenFromString(flattened)?.packageName
    }

    private fun roleRequestResult(roleName: String, held: Boolean, resultCode: Int): JSObject {
        val result = JSObject()
        result.put("role", roleName)
        result.put("held", held)
        result.put("resultCode", resultCode)
        return result
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }
}

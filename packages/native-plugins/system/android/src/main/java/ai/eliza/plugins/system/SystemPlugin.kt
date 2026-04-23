package ai.eliza.plugins.system

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "MiladySystem")
class SystemPlugin : Plugin() {
    private val roleMap = mapOf(
        "home" to "android.app.role.HOME",
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
                val holders = if (available) roleManager.getRoleHolders(androidRole) else emptyList()
                role.put("role", name)
                role.put("androidRole", androidRole)
                role.put("available", available)
                role.put("held", holders.contains(context.packageName))
                role.put("holders", JSArray(holders))
                roles.put(role)
            }
        }
        result.put("roles", roles)
        call.resolve(result)
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }
}

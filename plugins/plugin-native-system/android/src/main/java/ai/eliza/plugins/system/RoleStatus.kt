package ai.eliza.plugins.system

import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.provider.Telephony
import android.telecom.TelecomManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject

/**
 * Pure, Bridge-free reads of the device's launcher/comms role state.
 *
 * Extracted out of [SystemPlugin.getStatus] so the actual Android-API logic
 * (RoleManager / TelecomManager / Telephony / package resolution) can be
 * exercised by an on-device instrumented test (#9967). Previously every native
 * plugin's Kotlin was coupled to the Capacitor `Plugin`/`Bridge`/`PluginCall`
 * and so ran on no test, on no device; the only "tests" drove the views against
 * a mocked `Capacitor.Plugins` bridge in desktop Chromium. Taking a [Context]
 * parameter (instead of the plugin's bridge-owned `context`) is what makes the
 * read assertable from `androidTest`. `SystemPlugin` simply delegates here, so
 * behavior is unchanged.
 */
object RoleStatus {
    /** App-facing role name → the Android [RoleManager] role constant. */
    val ROLE_MAP: Map<String, String> = mapOf(
        "home" to RoleManager.ROLE_HOME,
        "dialer" to RoleManager.ROLE_DIALER,
        "sms" to RoleManager.ROLE_SMS,
        "assistant" to RoleManager.ROLE_ASSISTANT,
    )

    /**
     * Reads the current launcher/comms role status from real system services.
     * Returns `{ packageName, roles: [{ role, androidRole, available, held, holders }] }`.
     * Roles are only enumerated on Android 10+ (RoleManager); below that, an
     * empty `roles` array is returned (matching the original method).
     */
    fun read(context: Context): JSObject {
        val result = JSObject()
        val roles = JSArray()
        result.put("packageName", context.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = context.getSystemService(Context.ROLE_SERVICE) as RoleManager
            for ((name, androidRole) in ROLE_MAP) {
                val role = JSObject()
                val available = roleManager.isRoleAvailable(androidRole)
                val holders = if (available) roleHolders(context, name) else emptyList()
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
        return result
    }

    private fun roleHolders(context: Context, name: String): List<String> {
        return when (name) {
            "home" -> listOfNotNull(resolveHomePackage(context))
            "dialer" -> listOfNotNull(resolveDefaultDialerPackage(context))
            "sms" -> listOfNotNull(Telephony.Sms.getDefaultSmsPackage(context))
            "assistant" -> listOfNotNull(resolveAssistantPackage(context))
            else -> emptyList()
        }
    }

    private fun resolveHomePackage(context: Context): String? {
        val intent = Intent(Intent.ACTION_MAIN)
        intent.addCategory(Intent.CATEGORY_HOME)
        val resolved = context.packageManager.resolveActivity(intent, 0)
        return resolved?.activityInfo?.packageName
    }

    private fun resolveDefaultDialerPackage(context: Context): String? {
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        return telecom?.defaultDialerPackage
    }

    private fun resolveAssistantPackage(context: Context): String? {
        val flattened = Settings.Secure.getString(context.contentResolver, "assistant")
        if (flattened.isNullOrBlank()) return null
        return ComponentName.unflattenFromString(flattened)?.packageName
    }
}

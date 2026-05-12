package ai.eliza.plugins.system

import android.app.role.RoleManager
import android.media.AudioManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
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
    private val volumeStreamMap = mapOf(
        "music" to AudioManager.STREAM_MUSIC,
        "ring" to AudioManager.STREAM_RING,
        "alarm" to AudioManager.STREAM_ALARM,
        "notification" to AudioManager.STREAM_NOTIFICATION,
        "system" to AudioManager.STREAM_SYSTEM,
        "voiceCall" to AudioManager.STREAM_VOICE_CALL
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

    @PluginMethod
    fun openNetworkSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_WIFI_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun openWriteSettings(call: PluginCall) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${context.packageName}"))
        } else {
            Intent(Settings.ACTION_SETTINGS)
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun openDisplaySettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_DISPLAY_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun openSoundSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_SOUND_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun getDeviceSettings(call: PluginCall) {
        call.resolve(deviceSettingsResult())
    }

    @PluginMethod
    fun setScreenBrightness(call: PluginCall) {
        val brightness = call.getDouble("brightness")
        if (brightness == null || brightness.isNaN()) {
            call.reject("brightness must be a number between 0 and 1")
            return
        }
        val clamped = brightness.coerceIn(0.0, 1.0)
        if (!canWriteSettings()) {
            call.reject("WRITE_SETTINGS permission is required to change system brightness")
            return
        }
        try {
            Settings.System.putInt(
                context.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            Settings.System.putInt(
                context.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS,
                (clamped * 255.0).toInt().coerceIn(0, 255)
            )
            activity?.window?.let { window ->
                val attrs = window.attributes
                attrs.screenBrightness = clamped.toFloat()
                window.attributes = attrs
            }
            call.resolve(deviceSettingsResult())
        } catch (error: RuntimeException) {
            call.reject("Failed to set screen brightness", error)
        }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val streamName = call.getString("stream")?.trim()
        val stream = volumeStreamMap[streamName]
        if (streamName.isNullOrEmpty() || stream == null) {
            call.reject("stream must be one of ${volumeStreamMap.keys.joinToString(", ")}")
            return
        }
        val volume = call.getInt("volume")
        if (volume == null) {
            call.reject("volume is required")
            return
        }
        val showUi = call.getBoolean("showUi") ?: false
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val max = audio.getStreamMaxVolume(stream)
        val clamped = volume.coerceIn(0, max)
        val flags = if (showUi) AudioManager.FLAG_SHOW_UI else 0
        try {
            audio.setStreamVolume(stream, clamped, flags)
            call.resolve(volumeStatus(streamName, stream, audio))
        } catch (error: RuntimeException) {
            call.reject("Failed to set $streamName volume", error)
        }
    }

    private fun canWriteSettings(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.System.canWrite(context)
    }

    private fun deviceSettingsResult(): JSObject {
        val result = JSObject()
        result.put("brightness", readBrightness())
        result.put("brightnessMode", readBrightnessMode())
        result.put("canWriteSettings", canWriteSettings())
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val volumes = JSArray()
        for ((name, stream) in volumeStreamMap) {
            volumes.put(volumeStatus(name, stream, audio))
        }
        result.put("volumes", volumes)
        return result
    }

    private fun readBrightness(): Double {
        return try {
            Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
                .coerceIn(0, 255) / 255.0
        } catch (_: Settings.SettingNotFoundException) {
            val windowBrightness = activity?.window?.attributes?.screenBrightness
            if (windowBrightness != null && windowBrightness >= 0f) {
                windowBrightness.toDouble().coerceIn(0.0, 1.0)
            } else {
                0.75
            }
        }
    }

    private fun readBrightnessMode(): String {
        return try {
            when (Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE)) {
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL -> "manual"
                Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC -> "automatic"
                else -> "unknown"
            }
        } catch (_: Settings.SettingNotFoundException) {
            "unknown"
        }
    }

    private fun volumeStatus(name: String, stream: Int, audio: AudioManager): JSObject {
        val result = JSObject()
        result.put("stream", name)
        result.put("current", audio.getStreamVolume(stream))
        result.put("max", audio.getStreamMaxVolume(stream))
        return result
    }
}

package ai.eliza.plugins.system

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
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
    // Device reads are delegated to a pure, Context-backed reader so they can be
    // exercised by an instrumented androidTest without a Capacitor Bridge / WebView
    // (issue #9967). This plugin stays a thin Capacitor binding: read via the
    // reader, then marshal the result into the unchanged JS wire shape.
    private val reader by lazy { SystemDeviceReader(context) }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(statusToJs(reader.readStatus()))
    }

    @PluginMethod
    fun requestRole(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Android role requests require Android 10 or newer")
            return
        }

        val roleName = call.getString("role")?.trim()
        val androidRole = SystemDeviceReader.ROLE_MAP[roleName]
        if (roleName.isNullOrEmpty() || androidRole == null) {
            call.reject("role must be one of ${SystemDeviceReader.ROLE_MAP.keys.joinToString(", ")}")
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
        val androidRole = SystemDeviceReader.ROLE_MAP[roleName]
        if (roleName.isNullOrEmpty() || androidRole == null) {
            call.reject("role must be one of ${SystemDeviceReader.ROLE_MAP.keys.joinToString(", ")}")
            return
        }

        val roleManager = context.getSystemService(Context.ROLE_SERVICE) as RoleManager
        call.resolve(roleRequestResult(roleName, roleManager.isRoleHeld(androidRole), result.resultCode))
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
        call.resolve(deviceSettingsToJs(reader.readDeviceSettings()))
    }

    @PluginMethod
    fun setScreenBrightness(call: PluginCall) {
        val brightness = call.getDouble("brightness")
        if (brightness == null || brightness.isNaN()) {
            call.reject("brightness must be a number between 0 and 1")
            return
        }
        val clamped = brightness.coerceIn(0.0, 1.0)
        if (!reader.canWriteSettings()) {
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
            call.resolve(deviceSettingsToJs(reader.readDeviceSettings()))
        } catch (error: RuntimeException) {
            call.reject("Failed to set screen brightness", error)
        }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val streamName = call.getString("stream")?.trim()
        val stream = SystemDeviceReader.VOLUME_STREAM_MAP[streamName]
        if (streamName.isNullOrEmpty() || stream == null) {
            call.reject("stream must be one of ${SystemDeviceReader.VOLUME_STREAM_MAP.keys.joinToString(", ")}")
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
            call.resolve(volumeToJs(reader.readVolume(streamName, stream, audio)))
        } catch (error: RuntimeException) {
            call.reject("Failed to set $streamName volume", error)
        }
    }

    private fun statusToJs(status: SystemDeviceReader.SystemStatus): JSObject {
        val result = JSObject()
        result.put("packageName", status.packageName)
        val roles = JSArray()
        for (role in status.roles) {
            val item = JSObject()
            item.put("role", role.role)
            item.put("androidRole", role.androidRole)
            item.put("available", role.available)
            item.put("held", role.held)
            item.put("holders", JSArray(role.holders))
            roles.put(item)
        }
        result.put("roles", roles)
        return result
    }

    private fun deviceSettingsToJs(settings: SystemDeviceReader.DeviceSettings): JSObject {
        val result = JSObject()
        result.put("brightness", settings.brightness)
        result.put("brightnessMode", settings.brightnessMode)
        result.put("canWriteSettings", settings.canWriteSettings)
        val volumes = JSArray()
        for (volume in settings.volumes) {
            volumes.put(volumeToJs(volume))
        }
        result.put("volumes", volumes)
        return result
    }

    private fun volumeToJs(volume: SystemDeviceReader.VolumeStatus): JSObject {
        val result = JSObject()
        result.put("stream", volume.stream)
        result.put("current", volume.current)
        result.put("max", volume.max)
        return result
    }
}

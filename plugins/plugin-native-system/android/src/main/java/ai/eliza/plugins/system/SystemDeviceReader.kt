/**
 * Reads Android role membership and device settings for the native system bridge.
 * RoleManager is authoritative for this app's membership; default-handler APIs
 * provide external holder identities when the app does not hold a role.
 */
package ai.eliza.plugins.system

import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.provider.Settings
import android.provider.Telephony
import android.telecom.TelecomManager

class SystemDeviceReader(private val context: Context) {

    data class RoleStatus(
        val role: String,
        val androidRole: String,
        val available: Boolean,
        val held: Boolean,
        val holders: List<String>,
    )

    data class SystemStatus(
        val packageName: String,
        val roles: List<RoleStatus>,
    )

    data class VolumeStatus(
        val stream: String,
        val current: Int,
        val max: Int,
    )

    data class DeviceSettings(
        val brightness: Double,
        val brightnessMode: String,
        val canWriteSettings: Boolean,
        val volumes: List<VolumeStatus>,
    )

    /** Package name + per-role status (home/dialer/sms/assistant). Roles are
     *  empty below Android 10 (RoleManager unavailable), matching the original. */
    fun readStatus(): SystemStatus {
        val roles = mutableListOf<RoleStatus>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = context.getSystemService(Context.ROLE_SERVICE) as RoleManager
            for ((name, androidRole) in ROLE_MAP) {
                val available = roleManager.isRoleAvailable(androidRole)
                val held = available && roleManager.isRoleHeld(androidRole)
                val holders = if (held) listOf(context.packageName)
                    else if (available) roleHolders(name) else emptyList()
                roles.add(
                    RoleStatus(
                        role = name,
                        androidRole = androidRole,
                        available = available,
                        held = held,
                        holders = holders,
                    ),
                )
            }
        }
        return SystemStatus(packageName = context.packageName, roles = roles)
    }

    /** Brightness (0–1), brightness mode, WRITE_SETTINGS grant, and volume
     *  levels for every audio stream — all read from the live device. */
    fun readDeviceSettings(): DeviceSettings {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return DeviceSettings(
            brightness = readBrightness(),
            brightnessMode = readBrightnessMode(),
            canWriteSettings = canWriteSettings(),
            volumes = VOLUME_STREAM_MAP.map { (name, stream) -> readVolume(name, stream, audio) },
        )
    }

    /** Single-stream volume status (used by the write path's response). */
    fun readVolume(name: String, stream: Int, audio: AudioManager): VolumeStatus =
        VolumeStatus(
            stream = name,
            current = audio.getStreamVolume(stream),
            max = audio.getStreamMaxVolume(stream),
        )

    fun canWriteSettings(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.System.canWrite(context)

    private fun roleHolders(name: String): List<String> = when (name) {
        "home" -> listOfNotNull(resolveHomePackage())
        "dialer" -> listOfNotNull(resolveDefaultDialerPackage())
        "sms" -> listOfNotNull(Telephony.Sms.getDefaultSmsPackage(context))
        "assistant" -> listOfNotNull(resolveAssistantPackage())
        else -> emptyList()
    }

    private fun resolveHomePackage(): String? {
        val intent = Intent(Intent.ACTION_MAIN)
        intent.addCategory(Intent.CATEGORY_HOME)
        return context.packageManager.resolveActivity(intent, 0)?.activityInfo?.packageName
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

    private fun readBrightness(): Double {
        return try {
            Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
                .coerceIn(0, 255) / 255.0
        } catch (_: Settings.SettingNotFoundException) {
            0.75
        }
    }

    private fun readBrightnessMode(): String {
        return try {
            when (
                Settings.System.getInt(
                    context.contentResolver,
                    Settings.System.SCREEN_BRIGHTNESS_MODE,
                )
            ) {
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL -> "manual"
                Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC -> "automatic"
                else -> "unknown"
            }
        } catch (_: Settings.SettingNotFoundException) {
            "unknown"
        }
    }

    companion object {
        /** role name → Android RoleManager constant, in launcher display order. */
        val ROLE_MAP: Map<String, String> = linkedMapOf(
            "home" to RoleManager.ROLE_HOME,
            "dialer" to RoleManager.ROLE_DIALER,
            "sms" to RoleManager.ROLE_SMS,
            "assistant" to RoleManager.ROLE_ASSISTANT,
        )

        /** volume stream name → AudioManager stream constant. */
        val VOLUME_STREAM_MAP: Map<String, Int> = linkedMapOf(
            "music" to AudioManager.STREAM_MUSIC,
            "ring" to AudioManager.STREAM_RING,
            "alarm" to AudioManager.STREAM_ALARM,
            "notification" to AudioManager.STREAM_NOTIFICATION,
            "system" to AudioManager.STREAM_SYSTEM,
            "voiceCall" to AudioManager.STREAM_VOICE_CALL,
        )
    }
}

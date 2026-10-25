package ai.eliza.testing

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.util.AtomicFile
import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import java.io.Closeable
import java.io.File

/** Real settings and AudioManager effects, with a durable pre-mutation recovery record. */
class SystemControlsFixture(private val context: Context) : Closeable {
    companion object {
        private const val BACKUP = "native-system-controls-restore.json"
        private fun shell(command: String): String =
            InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use {
                ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() }
            }

        private fun guard(context: Context) {
            check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Use an isolated stock emulator" }
            check(context.packageName.endsWith(".test"))
            check(shell("pm list packages ai.elizaos.app").isBlank()) { "Do not change a user app's device settings" }
        }

        private fun permissionMode(context: Context): String {
            val text = shell("appops get ${context.packageName} android:write_settings")
            val mode = Regex("WRITE_SETTINGS: (\\w+)").find(text)?.groupValues?.get(1)
                ?: if (text.contains("No operations")) "default" else error("Unknown app-op state: $text")
            check(mode in setOf("allow", "ignore", "deny", "default"))
            return mode
        }

        private fun emit(name: String, data: JSONObject) {
            InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                putString("nativeArtifactName", name)
                putString("nativeArtifactBase64", Base64.encodeToString(data.toString().toByteArray(), Base64.NO_WRAP))
            })
        }

        /** Can run in a fresh instrumentation process after a crash, before APK removal. */
        fun restore(context: Context) {
            guard(context)
            val file = File(context.filesDir, BACKUP)
            if (!file.exists()) return
            val saved = JSONObject(AtomicFile(file).readFully().toString(Charsets.UTF_8))
            val brightness = saved.getInt("brightness")
            val mode = saved.getInt("brightnessMode")
            val volume = saved.getInt("music")
            val permission = saved.getString("writeSettingsMode")
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            check(saved.getInt("version") == 1 && brightness in 0..255 && mode in 0..1)
            check(volume in 0..audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
            check(permission in setOf("allow", "ignore", "deny", "default"))
            val errors = mutableListOf<Throwable>()
            fun attempt(action: () -> Unit) { try { action() } catch (error: Throwable) { errors.add(error) } }
            attempt {
                shell("settings put system screen_brightness_mode $mode")
                shell("settings put system screen_brightness $brightness")
                check(Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS) == brightness)
                check(Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE) == mode)
            }
            attempt {
                audio.setStreamVolume(AudioManager.STREAM_MUSIC, volume, 0)
                check(audio.getStreamVolume(AudioManager.STREAM_MUSIC) == volume)
            }
            attempt {
                shell("appops set ${context.packageName} android:write_settings $permission")
                check(permissionMode(context) == permission)
            }
            if (errors.isNotEmpty()) {
                errors.drop(1).forEach { errors.first().addSuppressed(it) }
                throw errors.first()
            }
            emit("system-controls-restoration.json", saved.put("restored", true))
            AtomicFile(file).delete()
            check(!file.exists()) { "Recovery record must be removed only after verified restoration" }
        }
    }

    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val initialBrightness: Int
    private val initialMode: Int
    private val initialMusic: Int
    private val initialPermission: String
    private val initialCanWrite: Boolean
    private val maxMusic = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    private var closed = false

    init {
        guard(context)
        val file = File(context.filesDir, BACKUP)
        check(!file.exists()) { "An interrupted settings scenario needs recovery before another run" }
        initialBrightness = Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
        initialMode = Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE)
        initialMusic = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        initialPermission = permissionMode(context)
        initialCanWrite = Settings.System.canWrite(context)
        check(initialBrightness in 0..255 && initialMode in 0..1 && maxMusic > 0)
        val record = JSONObject().put("version", 1).put("brightness", initialBrightness)
            .put("brightnessMode", initialMode).put("music", initialMusic).put("writeSettingsMode", initialPermission)
        val atomic = AtomicFile(file)
        val output = atomic.startWrite()
        try {
            output.write(record.toString().toByteArray())
            atomic.finishWrite(output)
        } catch (error: Throwable) {
            atomic.failWrite(output)
            throw error
        }
    }

    private fun permission(mode: String, allowed: Boolean) {
        shell("appops set ${context.packageName} android:write_settings $mode")
        check(Settings.System.canWrite(context) == allowed) { "WRITE_SETTINGS did not become $mode" }
    }

    fun run(leaveForRecovery: Boolean = false, checkBridge: (String, JSONObject) -> Unit) {
        fun stage(name: String, brightness: Int, mode: Int, music: Int, canWrite: Boolean,
            brightnessInput: Double = 0.37, volumeInput: Int = music) {
            val expected = JSONObject().put("brightness", brightness / 255.0)
                .put("brightnessMode", if (mode == 0) "manual" else "automatic")
                .put("music", music).put("maxMusic", maxMusic).put("canWriteSettings", canWrite)
                .put("brightnessInput", brightnessInput).put("volumeInput", volumeInput)
            checkBridge(name, expected)
            check(Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS) == brightness) { "Native brightness does not match bridge effect" }
            check(Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE) == mode)
            check(audio.getStreamVolume(AudioManager.STREAM_MUSIC) == music) { "Native music volume does not match bridge effect" }
            check(Settings.System.canWrite(context) == canWrite)
            emit("system-controls-$name-native.json", JSONObject().put("stage", name)
                .put("brightness", brightness).put("brightnessMode", mode).put("music", music)
                .put("canWriteSettings", canWrite))
        }
        permission("ignore", false)
        stage("denied", initialBrightness, initialMode, initialMusic, false)
        permission("allow", true)
        val changedMusic = if (initialMusic < maxMusic) initialMusic + 1 else initialMusic - 1
        stage("granted", 94, 0, changedMusic, true)
        // End this instrumentation process with real mutations and a durable record.
        // The host must recover them through a fresh instrumentation process.
        if (leaveForRecovery) return
        stage("clamped", 255, 0, maxMusic, true, 2.0, maxMusic + 10)
        permission("ignore", false)
        stage("revoked", 255, 0, initialMusic, false)
        close()
        stage("restored", initialBrightness, initialMode, initialMusic, initialCanWrite)
    }

    override fun close() {
        if (closed) return
        restore(context)
        closed = true
    }
}

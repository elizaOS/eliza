package ai.eliza.plugins.system

import android.content.Context
import android.media.AudioManager
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The first on-device instrumented test for an elizaOS native plugin (issue
 * #9967: "Kotlin runs on no test, on no device").
 *
 * Runs on a real device/emulator and exercises the ACTUAL Android system reads
 * that the launcher's System/Settings view depends on — `RoleManager`,
 * `AudioManager`, and `Settings` via [SystemDeviceReader] — asserting real
 * native side-effects (state reads), not a mocked `Capacitor.Plugins` bridge.
 *
 * Run: `./gradlew :elizaos-capacitor-system:connectedDebugAndroidTest`
 * (from packages/app-core/platforms/android, with a device/emulator attached).
 */
@RunWith(AndroidJUnit4::class)
class SystemDeviceReaderInstrumentedTest {

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun readStatus_returnsRealPackageNameAndRoles() {
        val status = SystemDeviceReader(context).readStatus()

        // packageName is the real instrumented target package, not a stub.
        assertEquals(context.packageName, status.packageName)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Every declared launcher role is reported, in order, from the live
            // RoleManager — not the 0-length array the web stub / mock returns.
            assertEquals(
                listOf("home", "dialer", "sms", "assistant"),
                status.roles.map { it.role },
            )
            for (role in status.roles) {
                assertEquals(
                    "androidRole must match the RoleManager constant",
                    SystemDeviceReader.ROLE_MAP[role.role],
                    role.androidRole,
                )
                // `held` is consistent with the live holders list (the real
                // device side-effect: who actually owns the role right now).
                assertEquals(
                    role.holders.contains(context.packageName),
                    role.held,
                )
            }
        } else {
            assertTrue("roles are empty below Android 10", status.roles.isEmpty())
        }
    }

    @Test
    fun readDeviceSettings_returnsRealBrightnessAndEveryVolumeStream() {
        val reader = SystemDeviceReader(context)
        val settings = reader.readDeviceSettings()

        // Brightness read off the live device, normalized to [0, 1].
        assertTrue(
            "brightness ${settings.brightness} must be in [0,1]",
            settings.brightness in 0.0..1.0,
        )
        assertTrue(
            "brightnessMode must be a known mode",
            settings.brightnessMode in setOf("manual", "automatic", "unknown"),
        )

        // Every audio stream is reported with real AudioManager bounds.
        assertEquals(
            SystemDeviceReader.VOLUME_STREAM_MAP.keys.toList(),
            settings.volumes.map { it.stream },
        )
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        for (volume in settings.volumes) {
            val stream = SystemDeviceReader.VOLUME_STREAM_MAP.getValue(volume.stream)
            assertTrue(
                "${volume.stream} max ${volume.max} must be positive",
                volume.max > 0,
            )
            assertTrue(
                "${volume.stream} current ${volume.current} must be within [0, max]",
                volume.current in 0..volume.max,
            )
            // The reader's bounds match a direct, independent AudioManager read.
            assertEquals(audio.getStreamMaxVolume(stream), volume.max)
        }
    }

    @Test
    fun canWriteSettings_returnsLiveGrantState() {
        // Just asserts the real permission probe runs on-device without
        // throwing and returns a concrete boolean (Settings.System.canWrite).
        val value = SystemDeviceReader(context).canWriteSettings()
        assertNotNull(value)
    }
}

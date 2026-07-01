package ai.eliza.plugins.swabble

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.speech.SpeechRecognizer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device coverage for Swabble's Android microphone and speech platform
 * probes (#9967). This runs against the real package permission state,
 * SpeechRecognizer availability, and AudioManager input devices.
 */
@RunWith(AndroidJUnit4::class)
class SwabbleAndroidPlatformProbeInstrumentedTest {
    @get:Rule
    val microphonePermission: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun permissionResult_matchesRealMicrophoneGrantAndSpeechRecognizerAvailability() {
        val microphoneGranted =
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        val speechAvailable = SpeechRecognizer.isRecognitionAvailable(context)

        val result = SwabbleAndroidPlatformProbe.permissionResult(
            microphone = if (microphoneGranted) "granted" else "denied",
            speechRecognitionAvailable = SwabbleAndroidPlatformProbe.speechRecognitionAvailable(context)
        )

        assertEquals(if (microphoneGranted) "granted" else "denied", result.getString("microphone"))
        assertEquals(speechAvailable, SwabbleAndroidPlatformProbe.speechRecognitionAvailable(context))
        assertEquals(
            if (speechAvailable) "granted" else "not_supported",
            result.getString("speechRecognition")
        )
    }

    @Test
    fun audioDevices_returnsRealAndroidInputsOrDefaultFallback() {
        val devices = SwabbleAndroidPlatformProbe.audioDevices(context, selectedDeviceId = null)
        assertTrue("Swabble must expose at least one input option", devices.length() >= 1)

        val first = devices.getJSONObject(0)
        assertTrue(first.getString("id").isNotBlank())
        assertTrue(first.getString("name").isNotBlank())
        assertTrue(first.has("isDefault"))

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val realInputs = audio.getDevices(AudioManager.GET_DEVICES_INPUTS)
            if (realInputs.isNotEmpty()) {
                assertEquals(realInputs.size, devices.length())
                assertNotEquals("default", first.getString("id"))
            }
        }
    }

    @Test
    fun deviceTypeName_labelsKnownMicrophoneTypes() {
        assertEquals(
            "Built-in Microphone",
            SwabbleAndroidPlatformProbe.deviceTypeName(AudioDeviceInfo.TYPE_BUILTIN_MIC)
        )
        assertEquals(
            "Bluetooth SCO",
            SwabbleAndroidPlatformProbe.deviceTypeName(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
        )
    }
}

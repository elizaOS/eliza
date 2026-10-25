package ai.eliza.plugins.camera

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the camera enumeration (issue #9967).
 *
 * Drives the real `CameraManager` via [CameraDeviceReader] on a device/emulator
 * and asserts the live camera list — a real native side-effect, not the mocked
 * bridge / web `MediaDevices` stub.
 *
 * Run: `./gradlew :elizaos-capacitor-camera:connectedDebugAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class CameraDeviceReaderInstrumentedTest {

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun readDevices_enumeratesRealCameras() {
        val devices = CameraDeviceReader(context).readDevices()

        // A phone-class device/emulator exposes at least one camera, read live
        // from CameraManager.cameraIdList (no permission needed to enumerate).
        assertTrue("device should expose >= 1 camera", devices.isNotEmpty())

        for (device in devices) {
            assertTrue("camera id is non-empty", device.deviceId.isNotEmpty())
            assertTrue(
                "direction must be a known facing",
                device.direction in setOf("front", "back", "external"),
            )
            assertTrue("maxZoom ${device.maxZoom} must be >= 1", device.maxZoom >= 1.0)
            // Any reported output size must have positive dimensions.
            for (res in device.resolutions) {
                assertTrue(
                    "resolution ${res.width}x${res.height} must be positive",
                    res.width > 0 && res.height > 0,
                )
            }
        }

        // At least one camera should report a back or front facing (not all external).
        assertTrue(
            "at least one front/back camera",
            devices.any { it.direction == "front" || it.direction == "back" },
        )
    }
}

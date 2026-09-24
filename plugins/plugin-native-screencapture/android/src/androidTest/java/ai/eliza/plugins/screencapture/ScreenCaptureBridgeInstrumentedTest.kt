package ai.eliza.plugins.screencapture

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import java.io.File
import java.io.ByteArrayOutputStream
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.getcapacitor.BridgeActivity
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Captures real display pixels through MediaProjection after the system consent UI. */
class ScreenCaptureBridgeTestActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ScreenCapturePlugin::class.java)
        if (Build.VERSION.SDK_INT >= 27) { setTurnScreenOn(true); setShowWhenLocked(true) }
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

@RunWith(AndroidJUnit4::class)
class ScreenCaptureBridgeInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val device get() = UiDevice.getInstance(instrumentation)

    private fun evaluate(scenario: ActivityScenario<ScreenCaptureBridgeTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var value = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { result -> value = result; done.countDown() } }
        assertTrue("WebView evaluation timed out", done.await(5, TimeUnit.SECONDS))
        return value
    }

    private fun begin(scenario: ActivityScenario<ScreenCaptureBridgeTestActivity>, method: String, options: JSONObject = JSONObject()) {
        evaluate(scenario, """
            window.result = null;
            window.Capacitor.nativePromise('ScreenCapture', '$method', $options)
              .then(value => window.result = JSON.stringify({value: value ?? {}}))
              .catch(error => window.result = JSON.stringify({error: String(error)}));
        """.trimIndent())
    }

    private fun result(scenario: ActivityScenario<ScreenCaptureBridgeTestActivity>): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            val raw = evaluate(scenario, "window.result")
            if (raw != "null") {
                val parsed = JSONObject(JSONTokener(raw).nextValue() as String)
                assertFalse("Native capture rejected: $parsed", parsed.has("error"))
                return parsed.getJSONObject("value")
            }
            Thread.sleep(30)
        }
        throw AssertionError("Screen capture promise did not settle")
    }

    private fun consent() {
        val share = device.wait(Until.findObject(By.res("android", "button1")), 10000)
            ?: throw AssertionError("System projection consent did not appear")
        // On recent Android, choose the whole display instead of the default
        // single-app picker. This is a disposable emulator containing test fixtures.
        val spinner = device.findObject(By.res("com.android.systemui", "screen_share_mode_options"))
        if (spinner != null) {
            spinner.click()
            val entire = device.wait(Until.findObject(By.textContains("Entire screen")), 3000)
                ?: device.findObject(By.textContains("entire screen"))
            assertNotNull("Whole-screen consent option missing", entire)
            entire!!.click()
        }
        device.findObject(By.res("android", "button1")).click()
        device.waitForIdle()
    }

    private fun ready(scenario: ActivityScenario<ScreenCaptureBridgeTestActivity>) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)") != "true") {
            assertTrue("Capacitor initialization timed out", System.nanoTime() < deadline)
            Thread.sleep(20)
        }
    }

    private fun export(name: String, bytes: ByteArray) {
        instrumentation.sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        })
    }

    private fun assertPixels(shot: JSONObject, expected: Int = Color.rgb(18, 196, 90)) {
        val bytes = Base64.decode(shot.getString("base64"), Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertNotNull("Returned image must decode", bitmap)
        assertEquals(shot.getInt("width"), bitmap.width)
        assertEquals(shot.getInt("height"), bitmap.height)
        assertFrame(bitmap, expected)
        bitmap.recycle()
    }

    private fun assertFrame(bitmap: Bitmap, expected: Int = Color.rgb(18, 196, 90)) {
        val pixel = bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)
        assertTrue("Expected fixture color ${Integer.toHexString(expected)}, got ${Integer.toHexString(pixel)}",
            kotlin.math.abs(Color.red(pixel) - Color.red(expected)) < 12 &&
            kotlin.math.abs(Color.green(pixel) - Color.green(expected)) < 12 &&
            kotlin.math.abs(Color.blue(pixel) - Color.blue(expected)) < 12)
    }

    @Test
    fun screenshotContainsDisplayedPixelsAndResizesTheGrantedSession() {
        ActivityScenario.launch(ScreenCaptureBridgeTestActivity::class.java).use { scenario ->
            ready(scenario)
            begin(scenario, "captureScreenshot", JSONObject().put("format", "png"))
            consent()
            val first = result(scenario)
            assertPixels(first)
            export("screenshot.png", Base64.decode(first.getString("base64"), Base64.DEFAULT))
            begin(scenario, "captureScreenshot", JSONObject().put("format", "png"))
            assertPixels(result(scenario))
            begin(scenario, "captureScreenshot", JSONObject().put("format", "png").put("scale", 0.5))
            val scaled = result(scenario)
            assertPixels(scaled)
            export("screenshot-scaled.png", Base64.decode(scaled.getString("base64"), Base64.DEFAULT))
            assertEquals(first.getInt("width") / 2, scaled.getInt("width"))
            assertEquals(first.getInt("height") / 2, scaled.getInt("height"))
            evaluate(scenario, "document.body.style.background = '#254bc8'")
            // Wait for WebView composition, then require new pixels from the same reader.
            Thread.sleep(250)
            begin(scenario, "captureScreenshot", JSONObject().put("format", "png").put("scale", 0.5))
            val changed = result(scenario)
            export("screenshot-changed.png", Base64.decode(changed.getString("base64"), Base64.DEFAULT))
            assertPixels(changed, Color.rgb(37, 75, 200))
        }
    }

    @Test
    fun recordingAfterScreenshotProducesDecodableVideoAcrossPauseAndResume() {
        ActivityScenario.launch(ScreenCaptureBridgeTestActivity::class.java).use { scenario ->
            ready(scenario)
            begin(scenario, "captureScreenshot")
            consent()
            val beforeRecording = result(scenario)
            export("before-recording.png", Base64.decode(beforeRecording.getString("base64"), Base64.DEFAULT))
            assertPixels(beforeRecording)
            begin(scenario, "startRecording", JSONObject().put("fps", 15).put("captureSystemAudio", false).put("captureMicrophone", false))
            consent()
            result(scenario)
            Thread.sleep(1500)
            begin(scenario, "pauseRecording")
            result(scenario)
            begin(scenario, "getRecordingState")
            val paused = result(scenario)
            assertTrue(paused.getBoolean("isRecording"))
            assertTrue(paused.getBoolean("isPaused"))
            Thread.sleep(600)
            begin(scenario, "getRecordingState")
            assertEquals(paused.getDouble("duration"), result(scenario).getDouble("duration"), 0.05)
            begin(scenario, "resumeRecording")
            result(scenario)
            Thread.sleep(1500)
            begin(scenario, "stopRecording")
            val recording = result(scenario)
            val file = File(recording.getString("path"))
            assertTrue("Recording must exist", file.isFile)
            assertEquals(file.length(), recording.getLong("fileSize"))
            assertTrue("Recording must contain media", file.length() > 1000)
            assertEquals("video/mp4", recording.getString("mimeType"))
            assertTrue(recording.getDouble("duration") >= 3.0)
            MediaMetadataRetriever().use { retriever ->
                retriever.setDataSource(file.absolutePath)
                assertEquals(recording.getInt("width"), retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)!!.toInt())
                assertEquals(recording.getInt("height"), retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)!!.toInt())
                val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong()
                assertTrue("Encoded video must span both recording intervals: $duration", duration >= 2500)
                assertEquals(recording.getDouble("duration"), duration / 1000.0, 0.8)
                val frame = retriever.getFrameAtTime(1000000, MediaMetadataRetriever.OPTION_CLOSEST)!!
                assertFrame(frame)
                val image = ByteArrayOutputStream()
                assertTrue(frame.compress(Bitmap.CompressFormat.PNG, 100, image))
                export("recording-frame.png", image.toByteArray())
                frame.recycle()
            }
            export("recording.mp4", file.readBytes())
            begin(scenario, "getRecordingState")
            assertFalse(result(scenario).getBoolean("isRecording"))
            file.delete()
        }
    }

}

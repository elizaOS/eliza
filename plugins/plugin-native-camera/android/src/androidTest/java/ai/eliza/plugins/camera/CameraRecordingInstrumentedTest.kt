/**
 * Exercises production CameraX recording through a real Capacitor activity on a device.
 * Only the JavaScript reply transport is intercepted. Camera, codec, metadata and
 * MediaStore are real; each generated artifact is removed after verification.
 */
package ai.eliza.plugins.camera

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.DynamicRange
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.Recorder
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.lifecycle.Lifecycle
import com.getcapacitor.BridgeActivity
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

class CameraTestActivity : BridgeActivity() {
    // Failure injection is confined to this test activity. CameraX and the
    // registered production plugin are unchanged; normal tests use MediaStore.
    @Volatile var galleryFaultResolver: android.content.ContentResolver? = null
    override fun getContentResolver(): android.content.ContentResolver = galleryFaultResolver ?: super.getContentResolver()
    override fun onCreate(state: Bundle?) {
        registerPlugin(CameraPlugin::class.java)
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

@RunWith(AndroidJUnit4::class)
class CameraRecordingInstrumentedTest {
    @get:Rule val permissions = GrantPermissionRule.grant(Manifest.permission.CAMERA)

    private class Reply(method: String, data: JSObject = JSObject()) :
        PluginCall(null, "ElizaCamera", "camera-test", method, data) {
        val done = CountDownLatch(1)
        val settlements = AtomicInteger()
        var value: JSObject? = null
        var failure: String? = null
        override fun resolve(data: JSObject) { value = data; settle() }
        override fun resolve() { value = JSObject(); settle() }
        override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
            failure = "$code: $message ${error?.message.orEmpty()}"
            settle()
        }
        private fun settle() { settlements.incrementAndGet(); done.countDown() }
        fun await(): JSObject {
            assertTrue("$methodName did not settle", done.await(30, TimeUnit.SECONDS))
            assertEquals("$methodName settled more than once", 1, settlements.get())
            assertNull("$methodName failed: $failure", failure)
            return requireNotNull(value)
        }
    }

    private fun awaitBridgeReady(scenario: ActivityScenario<CameraTestActivity>) {
        // Initial navigation resets Capacitor listeners and saved permission calls.
        // Exercise the plugin only after the real harness document has loaded.
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (SystemClock.elapsedRealtime() < deadline) {
            val evaluated = CountDownLatch(1)
            var ready = false
            scenario.onActivity { activity ->
                activity.bridge.webView.evaluateJavascript(
                    "document.readyState === 'complete' && document.title === 'Camera integration harness' && !!window.Capacitor"
                ) { result -> ready = result == "true"; evaluated.countDown() }
            }
            assertTrue("Camera harness WebView evaluation timed out", evaluated.await(5, TimeUnit.SECONDS))
            if (ready) return
            SystemClock.sleep(25)
        }
        throw AssertionError("Camera harness bridge did not finish loading")
    }

    private fun call(scenario: ActivityScenario<CameraTestActivity>, method: String, data: JSObject = JSObject()): Reply {
        awaitBridgeReady(scenario)
        val reply = Reply(method, data)
        scenario.onActivity { activity ->
            val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
            when (method) {
                "startPreview" -> plugin.startPreview(reply)
                "stopPreview" -> plugin.stopPreview(reply)
                "startRecording" -> plugin.startRecording(reply)
                "stopRecording" -> plugin.stopRecording(reply)
                "getRecordingState" -> plugin.getRecordingState(reply)
                "capturePhoto" -> plugin.capturePhoto(reply)
                "switchCamera" -> plugin.switchCamera(reply)
                else -> error("Unsupported harness operation")
            }
        }
        return reply
    }

    private fun preview(scenario: ActivityScenario<CameraTestActivity>) {
        call(scenario, "startPreview", JSObject().apply {
            put("direction", "back")
            put("resolution", JSObject().apply { put("width", 640); put("height", 480) })
        }).await()
    }

    private fun inspectAndDelete(result: JSObject, gallery: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val path = result.getString("path")
        assertTrue("Finalized output path is required", !path.isNullOrEmpty())
        val uri = if (gallery) Uri.parse(path) else Uri.fromFile(File(requireNotNull(path)))
        assertEquals(if (gallery) "content" else "file", uri.scheme)
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(context, uri, null)
            val video = (0 until extractor.trackCount).first { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
            val format = extractor.getTrackFormat(video)
            assertEquals(format.getInteger(MediaFormat.KEY_WIDTH), result.getInt("width"))
            assertEquals(format.getInteger(MediaFormat.KEY_HEIGHT), result.getInt("height"))
            assertTrue(result.getDouble("duration") > 0)
            val actualSize = if (gallery) context.contentResolver.openFileDescriptor(uri, "r")!!.use { it.statSize }
                else File(requireNotNull(path)).length()
            assertTrue(actualSize > 0)
            assertEquals(actualSize, result.getLong("fileSize"))
            extractor.selectTrack(video)
            assertTrue("Finalized container contains a video sample", extractor.readSampleData(ByteBuffer.allocate(4 * 1024 * 1024), 0) > 0)
        } finally {
            extractor.release()
            if (gallery) assertEquals(1, context.contentResolver.delete(uri, null, null))
            else assertTrue(File(requireNotNull(path)).delete())
        }
    }

    @Test fun cacheRecordingStopsOnlyWhenMediaIsReadable_andConcurrentStopSharesResult() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                call(scenario, "startRecording", JSObject().put("audio", false)).await()
                val duplicate = call(scenario, "startRecording", JSObject().put("audio", false))
                assertTrue(duplicate.done.await(5, TimeUnit.SECONDS))
                assertTrue(duplicate.failure?.startsWith("RECORDING_BUSY:") == true)
                val switching = call(scenario, "switchCamera", JSObject().put("direction", "front"))
                assertTrue(switching.done.await(5, TimeUnit.SECONDS))
                assertTrue(switching.failure?.startsWith("RECORDING_BUSY:") == true)
                SystemClock.sleep(1200)
                val first = Reply("stopRecording")
                val second = Reply("stopRecording")
                scenario.onActivity { activity ->
                    val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                    plugin.stopRecording(first)
                    plugin.stopRecording(second)
                }
                val result = first.await()
                assertEquals(result.toString(), second.await().toString())
                inspectAndDelete(result, false)
                assertFalse(call(scenario, "getRecordingState").await().getBoolean("isRecording"))
            } finally {
                call(scenario, "stopPreview").await()
            }
        }
    }

    @Test fun galleryDurationLimitRetainsFinalizedContentUriForStopCaller() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                call(scenario, "startRecording", JSObject().apply {
                    put("audio", false); put("saveToGallery", true); put("maxDuration", 1.0)
                }).await()
                val deadline = SystemClock.elapsedRealtime() + 30_000
                while (call(scenario, "getRecordingState").await().getBoolean("isRecording")) {
                    assertTrue("Native duration limit did not stop recording", SystemClock.elapsedRealtime() < deadline)
                    SystemClock.sleep(100)
                }
                inspectAndDelete(call(scenario, "stopRecording").await(), true)
            } finally {
                call(scenario, "stopPreview").await()
            }
        }
    }

    @Test fun previewProducesDecodablePhoto_andInvalidRecordingLimitsDoNotStartCapture() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                val invalid = call(scenario, "startRecording", JSObject().apply {
                    put("audio", false); put("maxDuration", -1)
                })
                assertTrue(invalid.done.await(5, TimeUnit.SECONDS))
                assertTrue(invalid.failure?.startsWith("INVALID_OPTIONS:") == true)
                assertFalse(call(scenario, "getRecordingState").await().getBoolean("isRecording"))
                val photo = call(scenario, "capturePhoto", JSObject().put("format", "jpeg")).await()
                val bytes = Base64.decode(photo.getString("base64"), Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                assertNotNull("Camera output must decode as an image", bitmap)
                try {
                    assertEquals(photo.getInt("width"), bitmap.width)
                    assertEquals(photo.getInt("height"), bitmap.height)
                    assertTrue(bitmap.width > 0 && bitmap.height > 0)
                } finally {
                    bitmap.recycle()
                }
            } finally {
                call(scenario, "stopPreview").await()
            }
        }
    }

    @Test fun stopDuringPreviewStartupCancelsAdmission_andDoesNotResurrectCamera() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            val starting = Reply("startPreview")
            val stopping = Reply("stopPreview")
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                plugin.startPreview(starting)
                plugin.stopPreview(stopping)
            }
            stopping.await()
            assertTrue(starting.done.await(5, TimeUnit.SECONDS))
            assertTrue(starting.failure?.startsWith("PREVIEW_CANCELLED:") == true)
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            val recording = call(scenario, "startRecording", JSObject().put("audio", false))
            assertTrue(recording.done.await(5, TimeUnit.SECONDS))
            assertTrue(recording.failure?.startsWith("CAMERA_NOT_READY:") == true)
            assertEquals(1, starting.settlements.get())
            preview(scenario)
            call(scenario, "stopPreview").await()
        }
    }

    @Test fun requestedQualityChangesEncodedResolution_andMalformedOptionsRejectBeforeRecording() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                for (options in listOf(
                    JSObject().put("quality", "unknown"), JSObject().put("bitrate", "large"),
                    JSObject().put("frameRate", 29.5), JSObject().put("maxFileSize", "many"),
                )) {
                    options.put("audio", false)
                    val invalid = call(scenario, "startRecording", options)
                    assertTrue(invalid.done.await(5, TimeUnit.SECONDS))
                    assertTrue(invalid.failure?.startsWith("INVALID_OPTIONS:") == true)
                }
                call(scenario, "startRecording", JSObject().apply {
                    put("audio", false); put("quality", "low"); put("bitrate", 1_000_000); put("frameRate", 30)
                }).await()
                SystemClock.sleep(1200)
                val low = call(scenario, "stopRecording").await()
                val lowPixels = low.getInt("width") * low.getInt("height")
                inspectAndDelete(low, false)
                call(scenario, "startRecording", JSObject().put("audio", false)).await()
                SystemClock.sleep(1200)
                val default = call(scenario, "stopRecording").await()
                try {
                    val provider = ProcessCameraProvider.getInstance(InstrumentationRegistry.getInstrumentation().targetContext).get()
                    val cameraInfo = CameraSelector.DEFAULT_BACK_CAMERA.filter(provider.availableCameraInfos).first()
                    val qualities = Recorder.getVideoCapabilities(cameraInfo).getSupportedQualities(DynamicRange.SDR)
                    val defaultPixels = default.getInt("width") * default.getInt("height")
                    assertTrue("Default highest quality must not inherit the previous low profile",
                        if (qualities.size > 1) defaultPixels > lowPixels else defaultPixels == lowPixels)
                } finally {
                    inspectAndDelete(default, false)
                }
            } finally {
                call(scenario, "stopPreview").await()
            }
        }
    }

    @Test fun queuedCameraTogglesUseTheLastCommittedSelection() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val executor = Executors.newSingleThreadExecutor()
            try {
                val first = Reply("switchCamera")
                val second = Reply("switchCamera")
                scenario.onActivity { activity ->
                    val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                    // Queue both bridge-thread calls before Android processes either switch.
                    executor.submit {
                        plugin.switchCamera(first)
                        plugin.switchCamera(second)
                    }.get(5, TimeUnit.SECONDS)
                }
                assertEquals("front", first.await().getString("deviceId"))
                assertEquals("back", second.await().getString("deviceId"))
            } finally {
                executor.shutdownNow()
                call(scenario, "stopPreview").await()
            }
        }
    }

    @Test fun frameEventsFollowActualCameraActivity_andStopWithPreview() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            awaitBridgeReady(scenario)
            val frames = LinkedBlockingQueue<JSObject>()
            val listener = object : PluginCall(null, "ElizaCamera", "frame-test", "addListener", JSObject().put("eventName", "frame")) {
                override fun resolve(data: JSObject) { frames.add(data) }
            }
            scenario.onActivity { activity -> activity.bridge.getPlugin("ElizaCamera").instance.addListener(listener) }
            preview(scenario)
            val frame = frames.poll(20, TimeUnit.SECONDS)
            assertNotNull("Camera must complete captures before emitting frame events", frame)
            assertTrue(frame!!.getInt("width") > 0 && frame.getInt("height") > 0)
            val provider = ProcessCameraProvider.getInstance(InstrumentationRegistry.getInstrumentation().targetContext).get()
            val cameraInfo = CameraSelector.DEFAULT_BACK_CAMERA.filter(provider.availableCameraInfos).first()
            scenario.moveToState(Lifecycle.State.CREATED)
            val deadline = SystemClock.elapsedRealtime() + 10_000
            while (cameraInfo.cameraState.value?.type != CameraState.Type.CLOSED) {
                assertTrue("Paused camera did not close", SystemClock.elapsedRealtime() < deadline)
                SystemClock.sleep(50)
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            frames.clear()
            assertNull("A closed camera must not emit synthetic timer frames", frames.poll(1200, TimeUnit.MILLISECONDS))
            scenario.moveToState(Lifecycle.State.RESUMED)
            assertNotNull("Resuming preview must resume real frame events", frames.poll(20, TimeUnit.SECONDS))
            call(scenario, "stopPreview").await()
            frames.clear()
            assertNull("Stop must fence late capture callbacks", frames.poll(1200, TimeUnit.MILLISECONDS))
        }
    }

    @Test fun deniedMicrophoneDialogRejectsRequestedAudio_withoutStartingSilentVideo() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assertNotEquals("Use a fresh test-package install; microphone must not be pre-granted",
            PackageManager.PERMISSION_GRANTED,
            instrumentation.targetContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO))
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val automation = instrumentation.uiAutomation
            val originalInfo = automation.serviceInfo
            val originalFlags = originalInfo.flags
            originalInfo.flags = originalFlags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            automation.serviceInfo = originalInfo
            try {
                val starting = call(scenario, "startRecording", JSObject().put("audio", true))
                val deadline = SystemClock.elapsedRealtime() + 15_000
                var denied = false
                while (!denied && SystemClock.elapsedRealtime() < deadline) {
                    val root = automation.rootInActiveWindow
                    val button = root?.findAccessibilityNodeInfosByViewId(
                        "com.android.permissioncontroller:id/permission_deny_button")?.firstOrNull()
                    if (button != null) denied = button.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    if (!denied) SystemClock.sleep(50)
                }
                assertTrue("Android microphone permission dialog did not offer Deny", denied)
                assertTrue("Microphone denial did not settle the recording call", starting.done.await(10, TimeUnit.SECONDS))
                assertTrue(starting.failure?.startsWith("MICROPHONE_DENIED:") == true)
                assertEquals(1, starting.settlements.get())
                assertFalse(call(scenario, "getRecordingState").await().getBoolean("isRecording"))
            } finally {
                originalInfo.flags = originalFlags
                automation.serviceInfo = originalInfo
                call(scenario, "stopPreview").await()
            }
        }
    }
}

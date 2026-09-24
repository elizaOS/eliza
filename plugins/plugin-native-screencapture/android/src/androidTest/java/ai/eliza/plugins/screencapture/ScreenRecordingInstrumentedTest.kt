/** Exercises production screen recording with real consent, MediaProjection and MediaRecorder in an isolated test app. */
package ai.eliza.plugins.screencapture

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import android.graphics.Rect
import android.graphics.BitmapFactory
import android.util.Base64
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import android.media.MediaRecorder
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.ParcelFileDescriptor
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.getcapacitor.BridgeActivity
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

class ScreenCaptureTestActivity : BridgeActivity() {
    override fun onCreate(state: Bundle?) {
        registerPlugin(ScreenCapturePlugin::class.java)
        super.onCreate(state)
    }
}

@RunWith(AndroidJUnit4::class)
class ScreenRecordingInstrumentedTest {
    @Before @After fun removeTestArtifacts() {
        val directory = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
        requireNotNull(directory.listFiles()).filter { it.name.startsWith("screen_") && it.extension == "mp4" }.forEach { assertTrue(it.delete()) }
    }

    private class ChangingScreen(context: Context) : View(context) {
        private val random = java.util.Random(42)
        private val paint = Paint()
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            for (y in 0 until height step 40) for (x in 0 until width step 40) {
                paint.color = Color.rgb(random.nextInt(256), random.nextInt(256), random.nextInt(256))
                canvas.drawRect(x.toFloat(), y.toFloat(), (x + 40).toFloat(), (y + 40).toFloat(), paint)
            }
            postInvalidateOnAnimation()
        }
    }

    private class Reply(method: String, data: JSObject = JSObject()) : PluginCall(null, "ScreenCapture", "screen-test-$method", method, data) {
        val done = CountDownLatch(1)
        val settlements = AtomicInteger()
        var value: JSObject? = null
        var failure: String? = null
        override fun resolve(data: JSObject) { value = data; settle() }
        override fun resolve() { value = JSObject(); settle() }
        override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
            failure = "$code: $message"
            settle()
        }
        private fun settle() { settlements.incrementAndGet(); done.countDown() }
        fun await(): JSObject {
            assertTrue("$methodName did not settle after consent", done.await(90, TimeUnit.SECONDS))
            assertEquals(1, settlements.get())
            assertNull(failure, failure)
            return requireNotNull(value)
        }
    }

    private fun call(scenario: ActivityScenario<ScreenCaptureTestActivity>, method: String, data: JSObject = JSObject()): Reply {
        val reply = Reply(method, data)
        scenario.onActivity { activity ->
            val plugin = activity.bridge.getPlugin("ScreenCapture").instance as ScreenCapturePlugin
            when (method) {
                "startRecording" -> plugin.startRecording(reply)
                "captureScreenshot" -> plugin.captureScreenshot(reply)
                "stopRecording" -> plugin.stopRecording(reply)
                "getRecordingState" -> plugin.getRecordingState(reply)
                "isSupported" -> plugin.isSupported(reply)
                else -> error("Unsupported harness operation")
            }
        }
        return reply
    }

    private fun consentToEntireScreen(deny: Boolean = false) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val info = automation.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        automation.serviceInfo = info
        fun find(id: String? = null, text: String? = null): AccessibilityNodeInfo {
            val deadline = SystemClock.elapsedRealtime() + 15000
            while (SystemClock.elapsedRealtime() < deadline) {
                val root = automation.rootInActiveWindow
                val matches = if (id != null) root?.findAccessibilityNodeInfosByViewId(id)
                    else root?.findAccessibilityNodeInfosByText(requireNotNull(text))
                matches?.firstOrNull { it.isVisibleToUser }?.let { return it }
                SystemClock.sleep(50)
            }
            error("Expected Android consent control: $id $text")
        }
        fun tap(node: AccessibilityNodeInfo) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            val now = SystemClock.uptimeMillis()
            for (action in intArrayOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(now, SystemClock.uptimeMillis(), action, bounds.exactCenterX(), bounds.exactCenterY(), 0)
                try { assertTrue(automation.injectInputEvent(event, true)) } finally { event.recycle() }
            }
        }
        val title = find(id = "com.android.systemui:id/screen_share_dialog_title")
        assertTrue("Consent must belong to this test app", title.text.toString().contains("Eliza capture test"))
        if (deny) {
            tap(find(id = "android:id/button2"))
            return
        }
        tap(find(id = "com.android.systemui:id/screen_share_mode_options"))
        tap(find(text = "Share entire screen"))
        val share = find(id = "android:id/button1")
        assertEquals("SHARE SCREEN", share.text.toString())
        tap(share)
    }

    @Test fun recordingReturnsReadableVideoWithAccurateMetadata_andConcurrentStopAgreement() = record("normal")

    @Test fun missingRecordingArtifactRejectsInsteadOfReturningSuccess() = record("evicted")

    @Test fun recorderFinalizationFailureRejectsInsteadOfReturningSuccess() = record("reset")

    @Test fun durationLimitedRecordingRemainsRetrievable() = record("limited")

    @Test fun pendingConsentRejectsCompetingRecordingAndScreenshot() = record("overlap")

    @Test fun deniedConsentSettlesAndAllowsAnotherRequest() {
        ActivityScenario.launch(ScreenCaptureTestActivity::class.java).use { scenario ->
            val denied = call(scenario, "startRecording")
            consentToEntireScreen(deny = true)
            assertTrue(denied.done.await(10, TimeUnit.SECONDS))
            assertEquals(1, denied.settlements.get())
            assertTrue(denied.failure?.startsWith("CAPTURE_DENIED:") == true)
            val accepted = call(scenario, "startRecording")
            consentToEntireScreen()
            accepted.await()
            SystemClock.sleep(1500)
            call(scenario, "stopRecording").await()
        }
    }

    @Test fun destroyingActivitySettlesPendingConsentExactlyOnce() {
        val scenario = ActivityScenario.launch(ScreenCaptureTestActivity::class.java)
        val pending = call(scenario, "startRecording")
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        scenario.close()
        assertTrue(pending.done.await(10, TimeUnit.SECONDS))
        assertEquals(1, pending.settlements.get())
        assertTrue(pending.failure?.startsWith("CAPTURE_DESTROYED:") == true)
    }

    @Test fun destructionBeforeQueuedAdmissionStillSettlesCaller() {
        ActivityScenario.launch(ScreenCaptureTestActivity::class.java).use { scenario ->
            val queued = Reply("startRecording")
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ScreenCapture").instance as ScreenCapturePlugin
                plugin.startRecording(queued)
                // Deliver lifecycle teardown before the main queue admits the request.
                val destroy = ScreenCapturePlugin::class.java.getDeclaredMethod("handleOnDestroy")
                destroy.isAccessible = true
                destroy.invoke(plugin)
            }
            assertTrue(queued.done.await(10, TimeUnit.SECONDS))
            assertEquals(1, queued.settlements.get())
            assertTrue(queued.failure?.startsWith("CAPTURE_DESTROYED:") == true)
        }
    }

    @Test fun repeatedScreenshotsResizeWithinOneConsentSession() {
        ActivityScenario.launch(ScreenCaptureTestActivity::class.java).use { scenario ->
            val initial = call(scenario, "captureScreenshot")
            consentToEntireScreen()
            val full = initial.await()
            fun inspect(result: JSObject, name: String) {
                val bytes = Base64.decode(requireNotNull(result.getString("base64")), Base64.DEFAULT)
                val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                try {
                    assertEquals(bitmap.width, requireNotNull(result.getInteger("width")))
                    assertEquals(bitmap.height, requireNotNull(result.getInteger("height")))
                    if (InstrumentationRegistry.getArguments().getString("exportEvidence") == "true") {
                        val context = InstrumentationRegistry.getInstrumentation().targetContext
                        File(context.filesDir, "screenshot-$name.png").writeBytes(bytes)
                    }
                } finally { bitmap.recycle() }
            }
            inspect(full, "full")
            val half = call(scenario, "captureScreenshot", JSObject().apply { put("scale", 0.5) }).await()
            inspect(half, "half")
            assertEquals(requireNotNull(full.getInteger("width")) / 2, requireNotNull(half.getInteger("width")))
            assertEquals(requireNotNull(full.getInteger("height")) / 2, requireNotNull(half.getInteger("height")))
            val restored = call(scenario, "captureScreenshot").await()
            inspect(restored, "restored")
            assertEquals(full.getInteger("width"), restored.getInteger("width"))
            assertEquals(full.getInteger("height"), restored.getInteger("height"))
        }
    }

    @Test fun microphoneDenialDoesNotStartSilentRecordingAndReleasesAdmission() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val info = automation.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        automation.serviceInfo = info
        ActivityScenario.launch(ScreenCaptureTestActivity::class.java).use { scenario ->
            val requested = call(scenario, "startRecording", JSObject().apply { put("captureMicrophone", true) })
            val deadline = SystemClock.elapsedRealtime() + 15000
            var denied = false
            while (!denied && SystemClock.elapsedRealtime() < deadline) {
                val node = automation.rootInActiveWindow?.findAccessibilityNodeInfosByViewId(
                    "com.android.permissioncontroller:id/permission_deny_button")?.firstOrNull()
                if (node != null) denied = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                if (!denied) SystemClock.sleep(50)
            }
            assertTrue("Fresh test install must show microphone Deny", denied)
            assertTrue(requested.done.await(10, TimeUnit.SECONDS))
            assertEquals(1, requested.settlements.get())
            assertTrue(requested.failure?.startsWith("MICROPHONE_DENIED:") == true)
            assertFalse(call(scenario, "getRecordingState").await().getBoolean("isRecording"))
            val retry = call(scenario, "startRecording")
            consentToEntireScreen()
            retry.await()
            SystemClock.sleep(1500)
            call(scenario, "stopRecording").await()
        }
    }

    @Test fun destroyingActiveRecordingReleasesPlatformProjection() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        fun projectionState(): String = ParcelFileDescriptor.AutoCloseInputStream(
            automation.executeShellCommand("dumpsys media_projection")
        ).bufferedReader().use { it.readText() }
        val testPackage = InstrumentationRegistry.getInstrumentation().targetContext.packageName
        val scenario = ActivityScenario.launch(ScreenCaptureTestActivity::class.java)
        try {
            val starting = call(scenario, "startRecording")
            consentToEntireScreen()
            starting.await()
            assertTrue("Platform must register this test's active projection", projectionState().contains(testPackage))
            SystemClock.sleep(500)
        } finally { scenario.close() }
        val deadline = SystemClock.elapsedRealtime() + 10000
        while (projectionState().contains(testPackage) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50)
        assertFalse("Destruction must release the platform projection", projectionState().contains(testPackage))
    }

    @Test fun fileSizeLimitedRecordingRemainsReadableAndRetrievable() = record("fileLimited")

    @Test fun unsupportedSystemAudioRejectsBeforeConsentAndAllowsRetry() = record("systemAudio")

    @Test fun invalidFileSizeLimitsRejectAndReleaseAdmission() {
        ActivityScenario.launch(ScreenCaptureTestActivity::class.java).use { scenario ->
            for (value in listOf<Any>(0, -1, 1.5, "131072", true, JSObject.NULL, 9_007_199_254_740_992.0)) {
                val reply = call(scenario, "startRecording", JSObject().put("maxFileSize", value))
                assertTrue("Invalid limit must settle before consent", reply.done.await(2, TimeUnit.SECONDS))
                assertEquals(1, reply.settlements.get())
                assertTrue("Invalid limit must reject rather than become unlimited: $value", reply.failure?.startsWith("INVALID_RECORDING_OPTIONS:") == true)
            }
            val retry = call(scenario, "startRecording")
            consentToEntireScreen(deny = true)
            assertTrue(retry.done.await(2, TimeUnit.SECONDS))
            assertTrue("Valid retry must reach consent", retry.failure?.startsWith("CAPTURE_DENIED:") == true)
        }
    }

    private fun record(mode: String) {
        ActivityScenario.launch(ScreenCaptureTestActivity::class.java).use { scenario ->
            if (mode == "systemAudio") {
                val unsupported = call(scenario, "startRecording", JSObject().put("captureSystemAudio", true))
                assertTrue("Unsupported audio must reject before consent", unsupported.done.await(2, TimeUnit.SECONDS))
                assertEquals(1, unsupported.settlements.get())
                assertTrue(unsupported.failure?.startsWith("SYSTEM_AUDIO_UNSUPPORTED:") == true)
                val features = call(scenario, "isSupported").await().getJSONArray("features")
                assertFalse((0 until features.length()).any { features.getString(it) == "system_audio" })
            }
            if (mode == "fileLimited") scenario.onActivity { it.setContentView(ChangingScreen(it)) }
            val starting = call(scenario, "startRecording", JSObject().apply {
                if (mode == "systemAudio") put("captureSystemAudio", false)
                if (mode == "limited") put("maxDuration", 0.7)
                if (mode == "fileLimited") put("maxFileSize", 128 * 1024)
            })
            if (mode == "overlap") {
                for (method in listOf("startRecording", "captureScreenshot")) {
                    val competing = call(scenario, method)
                    assertTrue("Competing $method must settle without another consent prompt", competing.done.await(2, TimeUnit.SECONDS))
                    assertTrue("Competing request must report busy", competing.failure?.startsWith("CAPTURE_BUSY:") == true)
                }
            }
            consentToEntireScreen()
            starting.await()
            if (mode == "limited" || mode == "fileLimited") {
                val deadline = SystemClock.elapsedRealtime() + 10000
                while (call(scenario, "getRecordingState").await().getBoolean("isRecording") && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50)
                assertFalse("Configured limit must stop recording", call(scenario, "getRecordingState").await().getBoolean("isRecording"))
            } else SystemClock.sleep(1500)
            if (mode == "evicted") {
                scenario.onActivity { activity ->
                    val files = requireNotNull(activity.cacheDir.listFiles()).filter { it.name.startsWith("screen_") && it.extension == "mp4" }
                    assertEquals("Exactly one test-owned recording", 1, files.size)
                    assertTrue("Simulate cache eviction", files.single().delete())
                }
            }
            if (mode == "reset") {
                scenario.onActivity { activity ->
                    val plugin = activity.bridge.getPlugin("ScreenCapture").instance as ScreenCapturePlugin
                    val field = ScreenCapturePlugin::class.java.getDeclaredField("mediaRecorder")
                    field.isAccessible = true
                    // Force a real native finalization failure without replacing the recorder or plugin.
                    (field.get(plugin) as MediaRecorder).reset()
                }
            }
            var competingStop: Reply? = null
            val stopped = if (mode == "normal") {
                val first = Reply("stopRecording")
                val second = Reply("stopRecording")
                competingStop = second
                scenario.onActivity { activity ->
                    val plugin = activity.bridge.getPlugin("ScreenCapture").instance as ScreenCapturePlugin
                    plugin.stopRecording(first)
                    plugin.stopRecording(second)
                }
                first
            } else call(scenario, "stopRecording")
            if (mode == "evicted" || mode == "reset") {
                assertTrue(stopped.done.await(15, TimeUnit.SECONDS))
                assertEquals(1, stopped.settlements.get())
                assertNotNull("Failed $mode recording must reject", stopped.failure)
                assertNull("Failed recording must never return a video", stopped.value)
                scenario.onActivity { activity ->
                    requireNotNull(activity.cacheDir.listFiles()).filter { it.name.startsWith("screen_") && it.extension == "mp4" }.forEach { assertTrue(it.delete()) }
                }
                return@use
            }
            val result = stopped.await()
            val repeated = (competingStop ?: call(scenario, "stopRecording")).await()
            assertEquals("Repeated stop must return the same finalized video", result.toString(), repeated.toString())
            val state = call(scenario, "getRecordingState").await()
            assertFalse(state.getBoolean("isRecording"))
            assertEquals(result.getLong("fileSize"), state.getLong("fileSize"))
            val file = File(requireNotNull(result.getString("path")))
            val extractor = MediaExtractor()
            try {
                assertTrue("Finalized video must exist", file.isFile && file.length() > 0)
                assertEquals(file.length(), result.getLong("fileSize").toLong())
                extractor.setDataSource(file.absolutePath)
                val track = (0 until extractor.trackCount).first { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
                val format = extractor.getTrackFormat(track)
                assertEquals(format.getInteger(MediaFormat.KEY_WIDTH), requireNotNull(result.getInteger("width")))
                assertEquals(format.getInteger(MediaFormat.KEY_HEIGHT), requireNotNull(result.getInteger("height")))
                extractor.selectTrack(track)
                assertTrue("Video sample must be readable", extractor.readSampleData(ByteBuffer.allocate(4 * 1024 * 1024), 0) > 0)
                if (InstrumentationRegistry.getArguments().getString("exportEvidence") == "true") {
                    val context = InstrumentationRegistry.getInstrumentation().targetContext
                    file.copyTo(File(context.filesDir, "screen-recording-evidence.mp4"), overwrite = true)
                }
            } finally {
                extractor.release()
                assertTrue("Remove test-owned recording", file.delete())
            }
        }
    }
}

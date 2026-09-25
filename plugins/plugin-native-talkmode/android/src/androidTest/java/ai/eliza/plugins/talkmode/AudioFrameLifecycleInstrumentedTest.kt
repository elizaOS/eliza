package ai.eliza.plugins.talkmode

import android.Manifest
import android.media.AudioRecord
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the real AudioRecord worker; only Capacitor response delivery is recorded. */
@RunWith(AndroidJUnit4::class)
class AudioFrameLifecycleInstrumentedTest {
    @get:Rule
    val microphonePermission = GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

    private class RecordedCall(method: String, args: JSObject = JSObject()) :
        PluginCall(null, "TalkMode", "test", method, args) {
        val results = CopyOnWriteArrayList<JSObject>()
        var errorCode: String? = null
        override fun resolve(value: JSObject) { results.add(value) }
        override fun resolve() {}
        override fun reject(message: String, code: String) { errorCode = code }
    }

    private fun field(plugin: TalkModePlugin, name: String): Any? =
        TalkModePlugin::class.java.getDeclaredField(name).apply { isAccessible = true }.get(plugin)

    private fun start(plugin: TalkModePlugin): RecordedCall {
        val call = RecordedCall("startAudioFrames", JSObject().apply {
            put("sampleRate", 16000)
            put("frameMs", 32)
        })
        TalkModePlugin::class.java.getDeclaredMethod("startAudioFramesInternal", PluginCall::class.java)
            .apply { isAccessible = true }.invoke(plugin, call)
        return call
    }

    private fun isCapturing(plugin: TalkModePlugin): Boolean {
        val call = RecordedCall("isCapturingAudioFrames")
        plugin.isCapturingAudioFrames(call)
        return call.results.single().getBoolean("capturing")
    }

    private fun destroy(plugin: TalkModePlugin) {
        TalkModePlugin::class.java.getDeclaredMethod("handleOnDestroy")
            .apply { isAccessible = true }.invoke(plugin)
    }

    private fun awaitReader(job: Job) = runBlocking { withTimeout(5000) { job.join() } }

    private fun errors(plugin: TalkModePlugin): RecordedCall =
        RecordedCall("addListener", JSObject().put("eventName", "error")).also(plugin::addListener)

    @Test
    fun stoppedRecorderClearsStatusAndAllowsRestart() = assertFailureCleansUp { it.stop() }

    @Test
    fun releasedRecorderClearsStatusAndAllowsRestart() = assertFailureCleansUp { it.release() }

    private fun assertFailureCleansUp(fail: (AudioRecord) -> Unit) {
        val plugin = TalkModePlugin()
        try {
            val errors = errors(plugin)
            assertTrue(start(plugin).results.single().getBoolean("started"))
            val record = field(plugin, "audioRecord") as AudioRecord
            val reader = field(plugin, "audioFrameJob") as Job
            // Break the real recorder underneath the worker. Android may
            // return zero or ERROR_INVALID_OPERATION; neither is live capture.
            fail(record)
            awaitReader(reader)
            assertFalse(isCapturing(plugin))
            assertNull(field(plugin, "audioRecord"))
            assertEquals(AudioRecord.STATE_UNINITIALIZED, record.state)
            assertEquals("AUDIO_CAPTURE_FAILED", errors.results.single().getString("code"))
            assertTrue(start(plugin).results.single().getBoolean("started"))
            assertTrue(isCapturing(plugin))
        } finally { destroy(plugin) }
    }

    @Test
    fun oldReaderCompletionCannotStopReplacementCapture() {
        val plugin = TalkModePlugin()
        try {
            val errors = errors(plugin)
            assertTrue(start(plugin).results.single().getBoolean("started"))
            val old = field(plugin, "audioRecord") as AudioRecord
            val reader = field(plugin, "audioFrameJob") as Job
            plugin.stopAudioFrames(RecordedCall("stopAudioFrames"))
            awaitReader(reader)
            assertTrue(start(plugin).results.single().getBoolean("started"))
            val current = field(plugin, "audioRecord")
            TalkModePlugin::class.java.getDeclaredMethod(
                "finishAudioFrames", AudioRecord::class.java, Exception::class.java
            ).apply { isAccessible = true }.invoke(plugin, old, IllegalStateException("late read failure"))
            assertSame(current, field(plugin, "audioRecord"))
            assertTrue(isCapturing(plugin))
            assertTrue(errors.results.isEmpty())
        } finally { destroy(plugin) }
    }

    @Test
    fun teardownReleasesRecorderAndRejectsLatePermissionCompletion() {
        val plugin = TalkModePlugin()
        assertTrue(start(plugin).results.single().getBoolean("started"))
        val record = field(plugin, "audioRecord") as AudioRecord
        val reader = field(plugin, "audioFrameJob") as Job
        try {
            destroy(plugin)
            awaitReader(reader)
            assertFalse(isCapturing(plugin))
            assertNull(field(plugin, "audioRecord"))
            assertEquals(AudioRecord.STATE_UNINITIALIZED, record.state)
            assertEquals("AUDIO_CAPTURE_DESTROYED", start(plugin).errorCode)
        } finally { destroy(plugin) }
    }
}

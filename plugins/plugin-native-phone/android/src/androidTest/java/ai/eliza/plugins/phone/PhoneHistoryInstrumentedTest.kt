/** Exercises production phone-history and transcript bridge methods against real Android CallLog and preferences with isolated synthetic data. */
package ai.eliza.plugins.phone

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.provider.CallLog
import android.system.Os
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.json.JSONObject
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.getcapacitor.BridgeActivity
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

class PhoneTestActivity : BridgeActivity() {
    override fun onCreate(state: Bundle?) { registerPlugin(PhonePlugin::class.java); super.onCreate(state) }
}

@RunWith(AndroidJUnit4::class)
class PhoneHistoryInstrumentedTest {
    @get:Rule val permissions: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CALL_LOG, Manifest.permission.WRITE_CALL_LOG,
    )
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val preferences get() = context.getSharedPreferences("eliza_phone_call_transcripts", Context.MODE_PRIVATE)
    private val inserted = mutableListOf<Uri>()
    @Before @After fun cleanup() {
        for (uri in inserted) assertEquals(1, context.contentResolver.delete(CallLog.Calls.CONTENT_URI, "${CallLog.Calls._ID} = ?", arrayOf(requireNotNull(uri.lastPathSegment))))
        inserted.clear()
        assertTrue(preferences.edit().clear().commit())
    }
    private class Reply(method: String, data: JSObject) : PluginCall(null, "ElizaPhone", "phone-test", method, data) {
        var result: JSObject? = null
        var failure: String? = null
        var settlements = 0
        override fun resolve(data: JSObject) { result = data; settlements++ }
        override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) { failure = "$code: $message"; settlements++ }
        fun success(): JSObject { assertEquals(1, settlements); assertNull(failure, failure); return requireNotNull(result) }
    }
    private fun call(scenario: ActivityScenario<PhoneTestActivity>, method: String, data: JSObject): Reply {
        val reply = Reply(method, data)
        scenario.onActivity {
            val plugin = it.bridge.getPlugin("ElizaPhone").instance as PhonePlugin
            when (method) {
                "listRecentCalls" -> plugin.listRecentCalls(reply)
                "saveCallTranscript" -> plugin.saveCallTranscript(reply)
                else -> error("Unsupported harness method")
            }
        }
        return reply
    }
    private fun insert(number: String, date: Long): String {
        val uri = requireNotNull(context.contentResolver.insert(CallLog.Calls.CONTENT_URI, ContentValues().apply {
            put(CallLog.Calls.NUMBER, number); put(CallLog.Calls.DATE, date)
            put(CallLog.Calls.DURATION, 17); put(CallLog.Calls.TYPE, CallLog.Calls.INCOMING_TYPE)
            put(CallLog.Calls.NEW, 0)
            for (column in listOf(CallLog.Calls.CACHED_NAME, CallLog.Calls.PHONE_ACCOUNT_ID,
                CallLog.Calls.GEOCODED_LOCATION, CallLog.Calls.TRANSCRIPTION, CallLog.Calls.VOICEMAIL_URI)) {
                putNull(column)
            }
        }))
        inserted.add(uri)
        return requireNotNull(uri.lastPathSegment)
    }
    @Test fun completeHistoryFiltersOrdersAndHonorsNumericLimits() {
        val number = "+1555${System.nanoTime()}"
        val old = insert(number, 1_700_000_000_000)
        val recent = insert(number, 1_700_000_001_000)
        insert("${number}9", 1_700_000_002_000)
        ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            fun read(data: JSObject) = call(scenario, "listRecentCalls", data.put("number", number)).success().getJSONArray("calls")
            val all = read(JSObject())
            assertEquals(3, all.length())
            assertEquals(recent, all.getJSONObject(1).getString("id"))
            assertEquals(old, all.getJSONObject(2).getString("id"))
            assertEquals(17, all.getJSONObject(0).getInt("durationSeconds"))
            val wireEntry = JSONObject(all.getJSONObject(0).toString())
            // CallLog may normalize inserted nulls (notably geocoded location) to
            // empty strings. Preserve the actual provider value at the bridge.
            val columns = linkedMapOf(
                "cachedName" to CallLog.Calls.CACHED_NAME,
                "phoneAccountId" to CallLog.Calls.PHONE_ACCOUNT_ID,
                "geocodedLocation" to CallLog.Calls.GEOCODED_LOCATION,
                "transcription" to CallLog.Calls.TRANSCRIPTION,
                "voicemailUri" to CallLog.Calls.VOICEMAIL_URI,
            )
            requireNotNull(context.contentResolver.query(CallLog.Calls.CONTENT_URI,
                columns.values.toTypedArray(), "${CallLog.Calls._ID} = ?",
                arrayOf(wireEntry.getString("id")), null)).use { cursor ->
                assertTrue(cursor.moveToFirst())
                for ((field, column) in columns) {
                    val index = cursor.getColumnIndexOrThrow(column)
                    val expected = if (cursor.isNull(index)) JSONObject.NULL else cursor.getString(index)
                    assertEquals("Provider data must cross the bridge unchanged: $field", expected, wireEntry.get(field))
                }
            }
            for (field in listOf("agentTranscript", "agentSummary", "agentTranscriptUpdatedAt")) {
                assertEquals("Absent data must cross the bridge as explicit null: $field", JSONObject.NULL, wireEntry.get(field))
            }
            assertEquals(1, read(JSObject().put("limit", 1)).length())
            assertEquals(1, read(JSObject().put("limit", 1.0)).length())
            assertEquals(3, read(JSObject().put("limit", 9_007_199_254_740_991L)).length())
            val empty = call(scenario, "listRecentCalls", JSObject().put("number", "absent-$number")).success().getJSONArray("calls")
            assertEquals(0, empty.length())
        }
    }
    @Test fun invalidLimitsRejectBeforeReading() {
        ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            for (value in listOf<Any>(1.5, "1", true, JSObject.NULL, 0, -1, 9_007_199_254_740_992.0)) {
                val reply = call(scenario, "listRecentCalls", JSObject().put("limit", value))
                assertEquals(1, reply.settlements)
                assertTrue("Invalid limit: $value", reply.failure?.startsWith("INVALID_LIMIT:") == true)
                assertNull(reply.result)
            }
        }
    }
    @Test fun transcriptRoundTripPreservesCompleteText() {
        val number = "+1555${System.nanoTime()}"
        val id = insert(number, 1_700_000_000_000)
        val transcript = "  \n" + "Synthetic transcript 🦊\n".repeat(2048) + "\n  "
        val summary = "  Synthetic summary 🦊\n"
        ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            val saved = call(scenario, "saveCallTranscript", JSObject().put("callId", id).put("transcript", transcript).put("summary", summary)).success()
            val disk = File(context.applicationInfo.dataDir, "shared_prefs/eliza_phone_call_transcripts.xml")
            val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(disk)
            val entries = document.getElementsByTagName("string")
            val persisted = (0 until entries.length).map { entries.item(it) }
                .single { it.attributes.getNamedItem("name").nodeValue == id }
            val persistedPayload = JSONObject(persisted.textContent)
            assertEquals("Acknowledged save must already contain complete disk bytes", transcript, persistedPayload.getString("transcript"))
            assertEquals(summary, persistedPayload.getString("summary"))
            val entry = call(scenario, "listRecentCalls", JSObject().put("number", number)).success().getJSONArray("calls").getJSONObject(0)
            assertEquals(transcript, entry.getString("agentTranscript"))
            assertEquals(summary, entry.getString("agentSummary"))
            assertEquals(saved.getLong("updatedAt"), entry.getLong("agentTranscriptUpdatedAt"))
            call(scenario, "saveCallTranscript", JSObject().put("callId", id).put("transcript", transcript)).success()
            val withoutSummary = call(scenario, "listRecentCalls", JSObject().put("number", number)).success().getJSONArray("calls").getJSONObject(0)
            assertEquals(transcript, withoutSummary.getString("agentTranscript"))
            assertEquals(JSONObject.NULL, JSONObject(withoutSummary.toString()).get("agentSummary"))
        }
    }
    @Test fun unwritableTranscriptStoreRejectsWithoutAcknowledgingSave() {
        val directory = File(context.applicationInfo.dataDir, "shared_prefs")
        assertTrue(preferences.edit().putString("synthetic-seed", "{}").commit())
        assertTrue(preferences.edit().clear().commit())
        val originalMode = Os.stat(directory.absolutePath).st_mode and 511
        ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            try {
                Os.chmod(directory.absolutePath, 0b101101101)
                val reply = call(scenario, "saveCallTranscript", JSObject().put("callId", "synthetic-save-failure").put("transcript", "complete synthetic text"))
                assertFalse("The actual preferences writer must be unable to persist", preferences.edit().putString("synthetic-barrier", "{}").commit())
                assertEquals(1, reply.settlements)
                assertTrue("Unwritable storage must not report saved", reply.failure?.startsWith("TRANSCRIPT_SAVE_FAILED:") == true)
                assertNull(reply.result)
            } finally {
                Os.chmod(directory.absolutePath, originalMode)
            }
        }
    }

    @Test fun corruptTranscriptSettlesWithExplicitFailure() {
        ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            for (raw in listOf("{broken", "{}", "{\"transcript\":true,\"updatedAt\":1}", "{\"transcript\":\"test\",\"updatedAt\":\"invalid\"}")) {
                assertTrue(preferences.edit().putString("synthetic-corrupt", raw).commit())
                val reply = call(scenario, "listRecentCalls", JSObject())
                assertEquals(1, reply.settlements)
                assertTrue(reply.failure?.startsWith("CALL_HISTORY_UNAVAILABLE:") == true)
                assertNull(reply.result)
            }
            assertTrue(preferences.edit().putInt("synthetic-corrupt", 1).commit())
            val wrongStorage = call(scenario, "listRecentCalls", JSObject())
            assertEquals(1, wrongStorage.settlements)
            assertTrue(wrongStorage.failure?.startsWith("CALL_HISTORY_UNAVAILABLE:") == true)
            assertNull(wrongStorage.result)
        }
    }
}

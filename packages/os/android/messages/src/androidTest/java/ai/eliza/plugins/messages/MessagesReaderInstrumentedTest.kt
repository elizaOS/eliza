/**
 * Round-trips complete histories through the real Android SMS provider.
 * Only this test's inserted rows are read and removed; no radio or private inbox is required.
 */
package ai.eliza.plugins.messages

import android.Manifest
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.provider.Telephony
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MessagesReaderInstrumentedTest {
    @get:Rule
    val permissionRule = GrantPermissionRule.grant(Manifest.permission.READ_SMS)
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Test
    fun completeHistoryAndExplicitLimitsPreserveBodiesBeyondFiveHundredRows() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish", "cutf_cvm")) { "SMS fixtures require an emulator" }
        val inserted = mutableListOf<Uri>()
        val address = "+1555${System.nanoTime().toString().takeLast(7)}"
        val body = "  complete SMS body\n" + "context ".repeat(1000) + "\nend  "
        val resolver = context.contentResolver
        // The instrumentation target is a disposable test package, not the user's SMS app.
        shell("appops set ${context.packageName} WRITE_SMS allow")
        try {
            for (index in 0 until 502) {
                inserted += requireNotNull(resolver.insert(Telephony.Sms.Inbox.CONTENT_URI, ContentValues().apply {
                    put(Telephony.Sms.ADDRESS, address)
                    put(Telephony.Sms.BODY, "$index:$body")
                    put(Telephony.Sms.DATE, 1_700_000_000_000L + index)
                    put(Telephony.Sms.READ, 0)
                    put(Telephony.Sms.SUBSCRIPTION_ID, -1)
                    // Android 17 defaults non-role-app inserts to restricted messages.
                    // These synthetic fixtures are deliberately ordinary readable SMS.
                    if (Build.VERSION.SDK_INT >= 37) put("restricted", false)
                })) { "Fixture SMS insertion must succeed" }
            }
            val thread = requireNotNull(resolver.query(inserted.first(), arrayOf(Telephony.Sms.THREAD_ID), null, null, null)).use {
                check(it.moveToFirst()) { "Inserted fixture must be visible: " + shell("content query --uri ${inserted.first()} --projection _id:thread_id:type:sub_id:restricted") }
                it.getString(0)
            }
            val reader = MessagesReader(context)
            val all = reader.listMessages(thread)
            assertEquals(502, all.size)
            assertEquals("501:$body", all.first().body)
            assertEquals("0:$body", all.last().body)
            assertEquals(501, reader.listMessages(thread, 501).size)
            assertEquals(all.first(), reader.listMessages(thread, 1).single())
            assertThrows(IllegalArgumentException::class.java) { reader.listMessages(thread, 0) }
            assertTrue(reader.listMessages("-1").isEmpty())
        } finally {
            for (uri in inserted) resolver.delete(uri, null, null)
            shell("appops set ${context.packageName} WRITE_SMS default")
        }
    }

    private fun shell(command: String): String {
        return instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
            java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }
        }
    }
}

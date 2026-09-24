package ai.eliza.plugins.messages

import android.Manifest
import android.content.Context
import android.content.ContentValues
import android.provider.Telephony
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Emulator-only SMS provider write -> production reader -> cleanup round trip. */
@RunWith(AndroidJUnit4::class)
class MessagesReaderInstrumentedTest {

    @get:Rule
    val permissionRule: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.READ_SMS)

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun shell(command: String): String =
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText() }
        }

    @Test
    fun listMessages_readsBackTheInjectedSms() {
        // A unique emulator-only fixture prevents an old run's SMS from making
        // this test green. The shell provider write never sends an actual SMS.
        check(android.os.Build.HARDWARE in setOf("ranchu", "goldfish", "cutf_cvm")) {
            "SMS fixture tests require an emulator"
        }
        val marker = "$MARKER-${System.nanoTime()}"
        shell("appops set ${context.packageName} android:write_sms allow")
        if (android.os.Build.VERSION.SDK_INT >= 37) {
            // Android 17 marks messages inserted by non-default SMS apps as
            // restricted. Grant only this disposable emulator test package
            // access to read back its own synthetic provider fixture.
            shell("appops set ${context.packageName} android:read_restricted_messages allow")
        }
        val uri = context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, ContentValues().apply {
            put("address", "15558675309")
            put("body", marker)
            // Android temporarily hides newly received possible OTPs from
            // non-default SMS apps. This synthetic historical message tests
            // provider access without depending on the device's OTP classifier.
            put("date", System.currentTimeMillis() - 24 * 60 * 60 * 1000L)
            put("type", 1)
            put("sub_id", android.telephony.SubscriptionManager.getDefaultSmsSubscriptionId())
        })
        assertNotNull("SMS fixture insertion must return its URI", uri)
        try {
            val rows = MessagesReader(context).listMessages(threadId = null, limit = 500)
            val sms = rows.find { it.body == marker }
            assertNotNull("inserted SMS must be read through the production reader", sms)
            assertTrue("address survives provider round trip", sms!!.address == "15558675309")
            assertTrue("date is a real epoch ms", sms.date > 0)
            assertTrue("inbox type survives round trip", sms.type == 1)
            assertTrue("id is non-empty", sms.id.isNotEmpty())
        } finally {
            assertTrue("SMS fixture must be deleted", context.contentResolver.delete(uri!!, null, null) == 1)
        }
    }

    companion object {
        const val MARKER = "Eliza-9967-SMS-roundtrip"
    }
}

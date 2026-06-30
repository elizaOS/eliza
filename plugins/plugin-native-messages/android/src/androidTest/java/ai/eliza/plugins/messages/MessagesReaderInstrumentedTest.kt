package ai.eliza.plugins.messages

import android.Manifest
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device read test for the SMS provider (issue #9967).
 *
 * Drives the real `content://sms` query via [MessagesReader] and asserts a
 * marker SMS is read back. The marker message is injected host-side on an
 * **emulator** (`adb emu sms send <number> "<…$MARKER…>"`) so the test never
 * reads a real device's private inbox — it is run via `am instrument` against
 * the emulator only, not the physical device.
 */
@RunWith(AndroidJUnit4::class)
class MessagesReaderInstrumentedTest {

    @get:Rule
    val permissionRule: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.READ_SMS)

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun listMessages_readsBackTheInjectedSms() {
        val messages = MessagesReader(context).listMessages(threadId = null, limit = 500)

        // Skip (don't fail) when the marker SMS hasn't been injected — this test
        // is meaningful only on an orchestrated emulator where the harness ran
        // `adb -s <emulator> emu sms send <number> "…$MARKER…"` first, and is
        // deliberately not pointed at a real device's private inbox.
        val probe = messages.find { it.body.contains(MARKER) }
        assumeTrue(
            "marker SMS '$MARKER' not present — inject it on an emulator first",
            probe != null,
        )

        // The read-back message is well-formed from the live provider.
        val sms = probe!!
        assertTrue("address is non-empty", sms.address.isNotEmpty())
        assertTrue("date ${sms.date} is a real epoch ms", sms.date > 0)
        assertTrue("type ${sms.type} is a valid SMS message type", sms.type in 0..6)
        assertTrue("id is non-empty", sms.id.isNotEmpty())
    }

    companion object {
        const val MARKER = "Eliza-9967-SMS-roundtrip"
    }
}

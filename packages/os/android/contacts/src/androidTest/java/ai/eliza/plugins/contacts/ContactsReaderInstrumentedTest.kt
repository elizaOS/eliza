package ai.eliza.plugins.contacts

import android.Manifest
import android.content.ContentProviderOperation
import android.content.Context
import android.net.Uri
import android.provider.ContactsContract
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device write→read round-trip for contacts (issue #9967).
 *
 * Inserts a contact through the real `ContactsProvider`, reads it back via
 * [ContactsReader], and asserts the written record (name + phone) is returned —
 * the exact "contact written/read" native side-effect the issue calls for — then
 * cleans up. Permissions are granted with `GrantPermissionRule` so it runs
 * unattended on a device/emulator.
 *
 * Run: `./gradlew :elizaos-plugin-native-contacts:connectedDebugAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class ContactsReaderInstrumentedTest {

    @get:Rule
    val permissionRule: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.WRITE_CONTACTS,
    )

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun listContacts_readsBackAWrittenContact() {
        val name = "Eliza 9967 ${System.nanoTime()}"
        val phoneDigits = "555${(System.nanoTime() % 10_000_000).toString().padStart(7, '0')}"
        val rawContactUri = insertContact(name, "+1$phoneDigits")

        try {
            val matches = ContactsReader(context).listContacts(name, 500)

            // The freshly written contact is read back from the real provider.
            assertTrue(
                "written contact '$name' must be read back by name",
                matches.any { it.displayName == name },
            )
            val found = matches.first { it.displayName == name }

            // And it carries the phone number we wrote (digits survive any
            // provider formatting).
            assertTrue(
                "written phone $phoneDigits must be read back (got ${found.phoneNumbers})",
                found.phoneNumbers.any { it.filter(Char::isDigit).contains(phoneDigits) },
            )
        } finally {
            context.contentResolver.delete(rawContactUri, null, null)
        }
    }

    @Test
    fun catalogPagesWithCursorAndRefusesAStaleOne() {
        val marker = "Elizapage${System.nanoTime()}"
        val raw = listOf("A", "B", "C").map { insertContact("$marker $it", "+1555000000${it[0].code % 10}") }
        try {
            val catalog = ContactsCatalog(context)
            val first = catalog.list(marker, 2, null, android.os.CancellationSignal())
            assertEquals(2, first.getJSONArray("contacts").length())
            assertTrue(first.getBoolean("more"))
            val next = first.getString("next")
            val second = catalog.list(marker, 2, next, android.os.CancellationSignal())
            assertEquals(1, second.getJSONArray("contacts").length())
            assertFalse(second.getBoolean("more"))
            assertNull(second.opt("next"))
            val names = (0 until 2).map { first.getJSONArray("contacts").getJSONObject(it).getString("name") } +
                second.getJSONArray("contacts").getJSONObject(0).getString("name")
            assertEquals(listOf("$marker A", "$marker B", "$marker C"), names)
            try { catalog.list("$marker B", 2, next, android.os.CancellationSignal()); fail("cursor of another query") } catch (expected: IllegalArgumentException) {}
            context.contentResolver.delete(raw[0], null, null)
            try { catalog.list(marker, 2, next, android.os.CancellationSignal()); fail("stale cursor") } catch (expected: ContactsCatalog.StaleCursor) {}
        } finally {
            raw.forEach { context.contentResolver.delete(it, null, null) }
        }
    }

    private fun insertContact(displayName: String, phone: String): Uri {
        val ops = arrayListOf(
            ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null as String?)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null as String?)
                .build(),
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
                )
                .withValue(
                    ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME,
                    displayName,
                )
                .build(),
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
                )
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
                .withValue(
                    ContactsContract.CommonDataKinds.Phone.TYPE,
                    ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE,
                )
                .build(),
        )
        val results = context.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        return requireNotNull(results[0].uri) { "RawContacts insert returned no uri" }
    }
}

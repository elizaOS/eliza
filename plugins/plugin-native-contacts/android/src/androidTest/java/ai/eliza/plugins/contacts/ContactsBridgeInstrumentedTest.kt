/** Exercises the real contacts bridge/provider and injects only null/empty provider responses for reader failure boundaries. */
package ai.eliza.plugins.contacts

import android.Manifest
import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentResolver
import android.content.ContentValues
import android.content.ContextWrapper
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.getcapacitor.BridgeActivity
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

class ContactsTestActivity : BridgeActivity() {
    override fun onCreate(state: Bundle?) {
        registerPlugin(ContactsPlugin::class.java)
        super.onCreate(state)
    }
}

@RunWith(AndroidJUnit4::class)
class ContactsBridgeInstrumentedTest {
    @get:Rule val permissions: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS,
    )

    private class Reply(method: String, data: JSObject) : PluginCall(null, "ElizaContacts", "contacts-test", method, data) {
        var result: JSObject? = null
        var failure: String? = null
        var settlements = 0
        override fun resolve(data: JSObject) { result = data; settlements++ }
        override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
            failure = "$code: $message"; settlements++
        }
        fun success(): JSObject {
            assertEquals("Request settles exactly once", 1, settlements)
            assertNull(failure, failure)
            return requireNotNull(result)
        }
    }

    private fun call(scenario: ActivityScenario<ContactsTestActivity>, method: String, data: JSObject): Reply {
        val reply = Reply(method, data)
        scenario.onActivity {
            val plugin = it.bridge.getPlugin("ElizaContacts").instance as ContactsPlugin
            when (method) {
                "createContact" -> plugin.createContact(reply)
                "listContacts" -> plugin.listContacts(reply)
                else -> error("Unsupported harness method")
            }
        }
        return reply
    }

    @Test fun malformedLimitsRejectInsteadOfReadingTheAddressBook() {
        ActivityScenario.launch(ContactsTestActivity::class.java).use { scenario ->
            for (value in listOf<Any>(1.5, 0, -1, "1", true, JSObject.NULL, 9_007_199_254_740_992.0)) {
                val reply = call(scenario, "listContacts", JSObject().put("limit", value))
                assertEquals(1, reply.settlements)
                assertTrue("Explicit malformed limit must fail: $value", reply.failure?.startsWith("INVALID_LIMIT:") == true)
                assertNull(reply.result)
            }
        }
    }

    @Test fun createdContactsAreCompleteSearchableAndExplicitlyLimited() {
        val marker = "ElizaContactsReview${System.nanoTime()}"
        val ids = mutableListOf<String>()
        val phonePrefix = "+1555${System.nanoTime() % 1_000_000}"
        val resolver = InstrumentationRegistry.getInstrumentation().targetContext.contentResolver
        try {
            ActivityScenario.launch(ContactsTestActivity::class.java).use { scenario ->
                repeat(2) { index ->
                    ids.add(requireNotNull(call(scenario, "createContact", JSObject()
                        .put("displayName", "$marker $index")
                        .put("phoneNumber", "$phonePrefix$index")
                        .put("emailAddress", "$marker.$index@example.invalid")).success().getString("id")))
                }
                fun list(data: JSObject) = call(scenario, "listContacts", data.put("query", marker)).success().getJSONArray("contacts")
                val all = list(JSObject())
                assertEquals(2, all.length())
                repeat(2) { index ->
                    val contact = all.getJSONObject(index)
                    assertTrue(ids.contains(contact.getString("id")))
                    assertEquals("$marker $index", contact.getString("displayName"))
                    assertEquals("$phonePrefix$index", contact.getJSONArray("phoneNumbers").getString(0))
                    assertEquals("$marker.$index@example.invalid", contact.getJSONArray("emailAddresses").getString(0))
                }
                assertEquals(1, list(JSObject().put("limit", 1)).length())
                assertEquals(1, list(JSObject().put("limit", 1.0)).length())
                assertEquals(2, list(JSObject().put("limit", 9_007_199_254_740_991L)).length())
                val emailMatch = call(scenario, "listContacts", JSObject().put("query", "$marker.1@example.invalid")).success().getJSONArray("contacts")
                assertEquals(1, emailMatch.length())
                assertEquals(ids[1], emailMatch.getJSONObject(0).getString("id"))
            }
        } finally {
            val ownedRows = requireNotNull(resolver.query(ContactsContract.Data.CONTENT_URI,
                arrayOf(ContactsContract.Data.RAW_CONTACT_ID),
                "${ContactsContract.Data.MIMETYPE} = ? AND ${ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME} IN (?, ?)",
                arrayOf(ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE, "$marker 0", "$marker 1"), null))
            val rawIds = ownedRows.use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.getLong(0)) } }
            for (rawId in rawIds) assertEquals(1, resolver.delete(
                ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, rawId), null, null))
        }
    }

    private fun readerWithProvider(empty: Boolean): ContactsReader {
        val provider = object : ContentProvider() {
            override fun onCreate() = true
            override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? =
                if (empty) MatrixCursor(requireNotNull(projection)) else null
            override fun getType(uri: Uri): String? = null
            override fun insert(uri: Uri, values: ContentValues?): Uri? = error("Read-only fixture")
            override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = error("Read-only fixture")
            override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = error("Read-only fixture")
        }
        val resolver = ContentResolver.wrap(provider)
        return ContactsReader(object : ContextWrapper(InstrumentationRegistry.getInstrumentation().targetContext) {
            override fun getContentResolver() = resolver
        })
    }

    @Test fun nullChildCursorsAreFailuresRatherThanEmptyContacts() {
        val reader = readerWithProvider(false)
        assertThrows(IllegalStateException::class.java) { reader.readPhoneNumbers("synthetic", true) }
        assertThrows(IllegalStateException::class.java) { reader.readEmailAddresses("synthetic") }
    }

    @Test fun emptyChildCursorsRemainValidEmptyData() {
        val reader = readerWithProvider(true)
        assertTrue(reader.readPhoneNumbers("synthetic", true).isEmpty())
        assertTrue(reader.readEmailAddresses("synthetic").isEmpty())
    }
}

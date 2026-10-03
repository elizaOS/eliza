package ai.eliza.testing

import android.content.Context
import android.content.ContentUris
import android.os.Build
import android.os.Bundle
import android.provider.ContactsContract
import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.util.UUID

/** Own only synthetic raw contacts found through this run's unique email addresses. */
class ContactsImportFixture(private val context: Context) : Closeable {
    private val marker = "ElizaVCard${UUID.randomUUID().toString().replace("-", "")}"
    private val emails = (0..3).map { "$marker.$it@example.invalid" }
    val descriptor = JSONObject().put("marker", marker).put("emails", JSONArray(emails))
        .put("phonePrefix", "+1555" + (System.nanoTime() % 100000000).toString().padStart(8, '0'))
    private val resolver get() = context.contentResolver

    init {
        check(Build.HARDWARE in setOf("ranchu", "goldfish", "cutf_cvm"))
        check(context.packageName.endsWith(".test"))
        check(ownedRawIds().isEmpty()) { "Synthetic import identifiers already exist" }
    }

    private fun ownedRawIds(): Set<Long> {
        val args = arrayOf(ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE, *emails.toTypedArray())
        return requireNotNull(resolver.query(ContactsContract.Data.CONTENT_URI,
            arrayOf(ContactsContract.Data.RAW_CONTACT_ID),
            "${ContactsContract.Data.MIMETYPE} = ? AND ${ContactsContract.CommonDataKinds.Email.ADDRESS} IN (?,?,?,?)",
            args, null)).use { cursor -> buildSet { while (cursor.moveToNext()) add(cursor.getLong(0)) } }
    }

    private fun emit(name: String, data: JSONObject) {
        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(data.toString().toByteArray(), Base64.NO_WRAP))
        })
    }

    fun verifyImported(imported: JSONArray) {
        val ids = ownedRawIds()
        check(ids.size == 3) { "Expected three synthetic raw contacts, got ${ids.size}" }
        val ownedContactIds = ids.map { rawId ->
            requireNotNull(resolver.query(ContactsContract.RawContacts.CONTENT_URI,
                arrayOf(ContactsContract.RawContacts.CONTACT_ID), "${ContactsContract.RawContacts._ID} = ?",
                arrayOf(rawId.toString()), null)).use { cursor ->
                check(cursor.moveToFirst())
                cursor.getString(0)
            }
        }.toSet()
        check((0 until imported.length()).map { imported.getJSONObject(it).getString("id") }.toSet() == ownedContactIds) {
            "Import receipts must refer exactly to the synthetic raw contacts"
        }
        val contacts = JSONArray()
        for (index in 0 until imported.length()) {
            val receipt = imported.getJSONObject(index)
            val id = receipt.getString("id")
            requireNotNull(resolver.query(ContactsContract.Contacts.CONTENT_URI,
                arrayOf(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY, ContactsContract.Contacts.LOOKUP_KEY),
                "${ContactsContract.Contacts._ID} = ?", arrayOf(id), null)).use { cursor ->
                check(cursor.moveToFirst()) { "Imported contact ID is absent from ContactsProvider" }
                check(receipt.getString("displayName") == cursor.getString(0)) { "Import receipt display name differs from ContactsProvider" }
                check(receipt.getString("lookupKey") == cursor.getString(1)) { "Import receipt lookup key differs from ContactsProvider" }
                contacts.put(JSONObject().put("id", id).put("displayName", cursor.getString(0)).put("lookupKey", cursor.getString(1)))
            }
        }
        val rows = JSONArray()
        for (id in ids) {
            requireNotNull(resolver.query(ContactsContract.Data.CONTENT_URI,
                arrayOf(ContactsContract.Data.MIMETYPE, ContactsContract.Data.DATA1),
                "${ContactsContract.Data.RAW_CONTACT_ID} = ?", arrayOf(id.toString()), null)).use { cursor ->
                while (cursor.moveToNext()) rows.put(JSONObject().put("rawContactId", id)
                    .put("mimeType", cursor.getString(0)).put("value", cursor.getString(1)))
            }
        }
        emit("contacts-import-provider.json", JSONObject().put("marker", marker).put("rows", rows).put("contacts", contacts))
    }

    override fun close() {
        val ids = ownedRawIds()
        for (id in ids) check(resolver.delete(ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, id), null, null) == 1)
        check(ownedRawIds().isEmpty()) { "Synthetic raw contacts remain after cleanup" }
        emit("contacts-import-cleanup.json", JSONObject().put("marker", marker)
            .put("deletedRawContactIds", JSONArray(ids.toList())).put("remaining", 0))
    }
}

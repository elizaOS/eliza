package ai.eliza.plugins.contacts

import android.Manifest
import android.content.ContentProviderOperation
import android.provider.ContactsContract
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "MiladyContacts")
class ContactsPlugin : Plugin() {
    @PluginMethod
    fun listContacts(call: PluginCall) {
        if (!hasPermission(Manifest.permission.READ_CONTACTS)) {
            call.reject("READ_CONTACTS permission is required")
            return
        }

        val query = call.getString("query")?.trim()
        val limit = call.getInt("limit") ?: 100
        val contacts = JSArray()
        val projection = arrayOf(
            ContactsContract.Contacts._ID,
            ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,
            ContactsContract.Contacts.PHOTO_THUMBNAIL_URI,
            ContactsContract.Contacts.HAS_PHONE_NUMBER
        )
        val selection = if (query.isNullOrEmpty()) null else "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} LIKE ?"
        val selectionArgs = if (query.isNullOrEmpty()) null else arrayOf("%$query%")
        context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} ASC"
        )?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
            val nameCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
            val photoCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.PHOTO_THUMBNAIL_URI)
            val phoneCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.HAS_PHONE_NUMBER)
            var count = 0
            while (cursor.moveToNext() && count < limit) {
                val id = cursor.getString(idCol)
                val contact = JSObject()
                contact.put("id", id)
                contact.put("displayName", cursor.getString(nameCol) ?: "")
                contact.put("photoUri", cursor.getString(photoCol))
                contact.put("phoneNumbers", readPhoneNumbers(id, cursor.getInt(phoneCol) > 0))
                contacts.put(contact)
                count += 1
            }
        }

        val result = JSObject()
        result.put("contacts", contacts)
        call.resolve(result)
    }

    @PluginMethod
    fun createContact(call: PluginCall) {
        if (!hasPermission(Manifest.permission.WRITE_CONTACTS)) {
            call.reject("WRITE_CONTACTS permission is required")
            return
        }
        val displayName = call.getString("displayName")?.trim()
        if (displayName.isNullOrEmpty()) {
            call.reject("displayName is required")
            return
        }
        val phoneNumber = call.getString("phoneNumber")?.trim()
        val operations = ArrayList<ContentProviderOperation>()
        operations.add(
            ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                .build()
        )
        operations.add(
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, displayName)
                .build()
        )
        if (!phoneNumber.isNullOrEmpty()) {
            operations.add(
                ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phoneNumber)
                    .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                    .build()
            )
        }
        val results = context.contentResolver.applyBatch(ContactsContract.AUTHORITY, operations)
        val result = JSObject()
        result.put("id", results.firstOrNull()?.uri?.lastPathSegment ?: "")
        call.resolve(result)
    }

    private fun readPhoneNumbers(contactId: String, hasPhone: Boolean): JSArray {
        val numbers = JSArray()
        if (!hasPhone) return numbers
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?",
            arrayOf(contactId),
            null
        )?.use { cursor ->
            val numberCol = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (cursor.moveToNext()) {
                numbers.put(cursor.getString(numberCol))
            }
        }
        return numbers
    }
}

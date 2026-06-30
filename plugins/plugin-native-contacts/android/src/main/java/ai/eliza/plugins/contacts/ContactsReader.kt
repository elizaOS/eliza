package ai.eliza.plugins.contacts

import android.content.Context
import android.provider.ContactsContract

/**
 * Pure, [Context]-backed reader for the contact query that
 * [ContactsPlugin.listContacts] exposes (name + phone + email, with optional
 * search + limit).
 *
 * Extracted from the Capacitor plugin so the real `ContactsContract` query can
 * be exercised by an instrumented `androidTest` (a write→read round-trip)
 * against the real ContactsProvider, without a Capacitor `Bridge`/WebView
 * (issue #9967). Requires `READ_CONTACTS`; [ContactsPlugin] delegates to it and
 * marshals each record into the unchanged JS shape.
 */
class ContactsReader(private val context: Context) {

    data class ContactRecord(
        val id: String,
        val lookupKey: String,
        val displayName: String,
        val photoUri: String?,
        val phoneNumbers: List<String>,
        val emailAddresses: List<String>,
        val starred: Boolean,
    )

    /** @throws IllegalStateException if the provider returns no cursor (matches
     *  the plugin's reject). */
    fun listContacts(query: String?, limit: Int): List<ContactRecord> {
        val normalizedQuery = query?.trim()?.lowercase()
        val results = mutableListOf<ContactRecord>()
        val projection = arrayOf(
            ContactsContract.Contacts._ID,
            ContactsContract.Contacts.LOOKUP_KEY,
            ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,
            ContactsContract.Contacts.PHOTO_THUMBNAIL_URI,
            ContactsContract.Contacts.HAS_PHONE_NUMBER,
            ContactsContract.Contacts.STARRED,
        )
        val cursor = context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            projection,
            null,
            null,
            "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} ASC",
        ) ?: throw IllegalStateException("Contacts provider returned no cursor")

        cursor.use {
            val idCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
            val lookupCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.LOOKUP_KEY)
            val nameCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
            val photoCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.PHOTO_THUMBNAIL_URI)
            val phoneCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.HAS_PHONE_NUMBER)
            val starredCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.STARRED)
            var count = 0
            while (cursor.moveToNext() && count < limit) {
                val id = cursor.getString(idCol)
                val displayName = cursor.getString(nameCol) ?: ""
                val phoneNumbers = readPhoneNumbers(id, cursor.getInt(phoneCol) > 0)
                val emailAddresses = readEmailAddresses(id)
                if (!matchesQuery(normalizedQuery, displayName, phoneNumbers, emailAddresses)) continue
                results.add(
                    ContactRecord(
                        id = id,
                        lookupKey = cursor.getString(lookupCol) ?: "",
                        displayName = displayName,
                        photoUri = cursor.getString(photoCol),
                        phoneNumbers = phoneNumbers,
                        emailAddresses = emailAddresses,
                        starred = cursor.getInt(starredCol) == 1,
                    ),
                )
                count += 1
            }
        }
        return results
    }

    fun readPhoneNumbers(contactId: String, hasPhone: Boolean): List<String> {
        if (!hasPhone) return emptyList()
        val numbers = mutableListOf<String>()
        val cursor = context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?",
            arrayOf(contactId),
            null,
        ) ?: return numbers
        cursor.use {
            val numberCol =
                cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (cursor.moveToNext()) {
                val number = cursor.getString(numberCol)?.trim()
                if (!number.isNullOrEmpty()) numbers.add(number)
            }
        }
        return numbers.distinct()
    }

    fun readEmailAddresses(contactId: String): List<String> {
        val emails = mutableListOf<String>()
        val cursor = context.contentResolver.query(
            ContactsContract.CommonDataKinds.Email.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS),
            "${ContactsContract.CommonDataKinds.Email.CONTACT_ID} = ?",
            arrayOf(contactId),
            null,
        ) ?: return emails
        cursor.use {
            val emailCol =
                cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Email.ADDRESS)
            while (cursor.moveToNext()) {
                val email = cursor.getString(emailCol)?.trim()
                if (!email.isNullOrEmpty()) emails.add(email)
            }
        }
        return emails.distinct()
    }

    private fun matchesQuery(
        query: String?,
        displayName: String,
        phoneNumbers: List<String>,
        emailAddresses: List<String>,
    ): Boolean {
        if (query.isNullOrEmpty()) return true
        if (displayName.lowercase().contains(query)) return true
        if (phoneNumbers.any { it.lowercase().contains(query) }) return true
        return emailAddresses.any { it.lowercase().contains(query) }
    }
}

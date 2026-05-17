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

@CapacitorPlugin(name = "ElizaContacts")
class ContactsPlugin : Plugin() {
    @PluginMethod
    fun listContacts(call: PluginCall) {
        if (!hasPermission(Manifest.permission.READ_CONTACTS)) {
            call.reject("READ_CONTACTS permission is required")
            return
        }

        val query = call.getString("query")?.trim()?.lowercase()
        val limit = call.getInt("limit") ?: 100
        if (limit <= 0 || limit > 500) {
            call.reject("limit must be between 1 and 500")
            return
        }
        val contacts = JSArray()
        val projection = arrayOf(
            ContactsContract.Contacts._ID,
            ContactsContract.Contacts.LOOKUP_KEY,
            ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,
            ContactsContract.Contacts.PHOTO_THUMBNAIL_URI,
            ContactsContract.Contacts.HAS_PHONE_NUMBER,
            ContactsContract.Contacts.STARRED
        )
        val cursor = context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            projection,
            null,
            null,
            "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} ASC"
        )
        if (cursor == null) {
            call.reject("Contacts provider returned no cursor")
            return
        }
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
                if (!matchesQuery(query, displayName, phoneNumbers, emailAddresses)) continue
                contacts.put(
                    contactJson(
                        id = id,
                        lookupKey = cursor.getString(lookupCol) ?: "",
                        displayName = displayName,
                        photoUri = cursor.getString(photoCol),
                        phoneNumbers = phoneNumbers,
                        emailAddresses = emailAddresses,
                        starred = cursor.getInt(starredCol) == 1
                    )
                )
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
        val phoneNumbers = readStringList(call, "phoneNumbers", call.getString("phoneNumber"))
        val emailAddresses = readStringList(call, "emailAddresses", call.getString("emailAddress"))
        val contactId = insertContact(displayName, phoneNumbers, emailAddresses)
        val result = JSObject()
        result.put("id", contactId)
        call.resolve(result)
    }

    @PluginMethod
    fun importVCard(call: PluginCall) {
        if (!hasPermission(Manifest.permission.WRITE_CONTACTS)) {
            call.reject("WRITE_CONTACTS permission is required")
            return
        }
        val vcardText = call.getString("vcardText")
        if (vcardText.isNullOrBlank()) {
            call.reject("vcardText is required")
            return
        }
        val parsedContacts = parseVCards(vcardText)
        if (parsedContacts.isEmpty()) {
            call.reject("No importable contacts were found in the vCard data")
            return
        }

        val imported = JSArray()
        for (parsed in parsedContacts) {
            val contactId = insertContact(parsed.displayName, parsed.phoneNumbers, parsed.emailAddresses)
            val summary = readContactSummary(contactId)
            summary.put("sourceName", parsed.displayName)
            imported.put(summary)
        }
        val result = JSObject()
        result.put("imported", imported)
        call.resolve(result)
    }

    private fun insertContact(
        displayName: String,
        phoneNumbers: List<String>,
        emailAddresses: List<String>
    ): String {
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
        for (phoneNumber in phoneNumbers) {
            operations.add(
                ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phoneNumber)
                    .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                    .build()
            )
        }
        for (emailAddress in emailAddresses) {
            operations.add(
                ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, emailAddress)
                    .withValue(ContactsContract.CommonDataKinds.Email.TYPE, ContactsContract.CommonDataKinds.Email.TYPE_OTHER)
                    .build()
            )
        }
        val results = context.contentResolver.applyBatch(ContactsContract.AUTHORITY, operations)
        val rawContactId = results.firstOrNull()?.uri?.lastPathSegment
        if (rawContactId.isNullOrEmpty()) {
            throw IllegalStateException("Contacts provider did not return a raw contact id")
        }
        return resolveContactId(rawContactId)
            ?: throw IllegalStateException("Contacts provider did not link the inserted raw contact")
    }

    private fun resolveContactId(rawContactId: String): String? {
        context.contentResolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts.CONTACT_ID),
            "${ContactsContract.RawContacts._ID} = ?",
            arrayOf(rawContactId),
            null
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val contactIdCol = cursor.getColumnIndexOrThrow(ContactsContract.RawContacts.CONTACT_ID)
                return cursor.getString(contactIdCol)
            }
        }
        return null
    }

    private fun readContactSummary(contactId: String): JSObject {
        val projection = arrayOf(
            ContactsContract.Contacts._ID,
            ContactsContract.Contacts.LOOKUP_KEY,
            ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,
            ContactsContract.Contacts.PHOTO_THUMBNAIL_URI,
            ContactsContract.Contacts.HAS_PHONE_NUMBER,
            ContactsContract.Contacts.STARRED
        )
        val cursor = context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            projection,
            "${ContactsContract.Contacts._ID} = ?",
            arrayOf(contactId),
            null
        ) ?: throw IllegalStateException("Contacts provider returned no cursor for $contactId")
        cursor.use {
            if (!cursor.moveToFirst()) {
                throw IllegalStateException("Inserted contact $contactId was not readable")
            }
            val idCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
            val lookupCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.LOOKUP_KEY)
            val nameCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
            val photoCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.PHOTO_THUMBNAIL_URI)
            val phoneCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.HAS_PHONE_NUMBER)
            val starredCol = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.STARRED)
            val id = cursor.getString(idCol)
            return contactJson(
                id = id,
                lookupKey = cursor.getString(lookupCol) ?: "",
                displayName = cursor.getString(nameCol) ?: "",
                photoUri = cursor.getString(photoCol),
                phoneNumbers = readPhoneNumbers(id, cursor.getInt(phoneCol) > 0),
                emailAddresses = readEmailAddresses(id),
                starred = cursor.getInt(starredCol) == 1
            )
        }
    }

    private fun readPhoneNumbers(contactId: String, hasPhone: Boolean): List<String> {
        if (!hasPhone) return emptyList()
        val numbers = mutableListOf<String>()
        val cursor = context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?",
            arrayOf(contactId),
            null
        ) ?: return numbers
        cursor.use {
            val numberCol = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (cursor.moveToNext()) {
                val number = cursor.getString(numberCol)?.trim()
                if (!number.isNullOrEmpty()) numbers.add(number)
            }
        }
        return numbers.distinct()
    }

    private fun readEmailAddresses(contactId: String): List<String> {
        val emails = mutableListOf<String>()
        val cursor = context.contentResolver.query(
            ContactsContract.CommonDataKinds.Email.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS),
            "${ContactsContract.CommonDataKinds.Email.CONTACT_ID} = ?",
            arrayOf(contactId),
            null
        ) ?: return emails
        cursor.use {
            val emailCol = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Email.ADDRESS)
            while (cursor.moveToNext()) {
                val email = cursor.getString(emailCol)?.trim()
                if (!email.isNullOrEmpty()) emails.add(email)
            }
        }
        return emails.distinct()
    }

    private fun contactJson(
        id: String,
        lookupKey: String,
        displayName: String,
        photoUri: String?,
        phoneNumbers: List<String>,
        emailAddresses: List<String>,
        starred: Boolean
    ): JSObject {
        val contact = JSObject()
        contact.put("id", id)
        contact.put("lookupKey", lookupKey)
        contact.put("displayName", displayName)
        contact.put("photoUri", photoUri)
        contact.put("phoneNumbers", JSArray(phoneNumbers))
        contact.put("emailAddresses", JSArray(emailAddresses))
        contact.put("starred", starred)
        return contact
    }

    private fun matchesQuery(
        query: String?,
        displayName: String,
        phoneNumbers: List<String>,
        emailAddresses: List<String>
    ): Boolean {
        if (query.isNullOrEmpty()) return true
        if (displayName.lowercase().contains(query)) return true
        if (phoneNumbers.any { it.lowercase().contains(query) }) return true
        return emailAddresses.any { it.lowercase().contains(query) }
    }

    private fun readStringList(call: PluginCall, arrayKey: String, singleValue: String?): List<String> {
        val values = mutableListOf<String>()
        val array = call.getArray(arrayKey)
        if (array != null) {
            for (index in 0 until array.length()) {
                val value = array.optString(index).trim()
                if (value.isNotEmpty()) values.add(value)
            }
        }
        val single = singleValue?.trim()
        if (!single.isNullOrEmpty()) values.add(single)
        return values.distinct()
    }

    private fun parseVCards(input: String): List<ParsedVCard> {
        val unfolded = unfoldVCardLines(input)
        val contacts = mutableListOf<ParsedVCard>()
        var current = mutableListOf<String>()
        var insideCard = false
        for (line in unfolded) {
            val upper = line.uppercase()
            if (upper == "BEGIN:VCARD") {
                insideCard = true
                current = mutableListOf()
            } else if (upper == "END:VCARD") {
                if (insideCard) {
                    parseVCard(current)?.let { contacts.add(it) }
                }
                insideCard = false
                current = mutableListOf()
            } else if (insideCard) {
                current.add(line)
            }
        }
        if (contacts.isEmpty()) {
            parseVCard(unfolded)?.let { contacts.add(it) }
        }
        return contacts
    }

    private fun unfoldVCardLines(input: String): List<String> {
        val lines = mutableListOf<String>()
        for (rawLine in input.replace("\r\n", "\n").replace('\r', '\n').split('\n')) {
            if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && lines.isNotEmpty()) {
                lines[lines.lastIndex] = lines.last() + rawLine.drop(1)
            } else {
                lines.add(rawLine.trimEnd())
            }
        }
        return lines
    }

    private fun parseVCard(lines: List<String>): ParsedVCard? {
        var fullName: String? = null
        var structuredName: String? = null
        val phoneNumbers = mutableListOf<String>()
        val emailAddresses = mutableListOf<String>()
        for (line in lines) {
            val separator = line.indexOf(':')
            if (separator <= 0) continue
            val key = line.substring(0, separator).substringBefore(';').uppercase()
            val value = decodeVCardValue(line.substring(separator + 1)).trim()
            if (value.isEmpty()) continue
            when (key) {
                "FN" -> fullName = value
                "N" -> structuredName = structuredNameToDisplayName(value)
                "TEL" -> phoneNumbers.add(value)
                "EMAIL" -> emailAddresses.add(value)
            }
        }
        val displayName = fullName ?: structuredName ?: phoneNumbers.firstOrNull() ?: emailAddresses.firstOrNull()
        if (displayName.isNullOrBlank()) return null
        return ParsedVCard(
            displayName = displayName,
            phoneNumbers = phoneNumbers.map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
            emailAddresses = emailAddresses.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        )
    }

    private fun structuredNameToDisplayName(value: String): String {
        val parts = value.split(';').map { decodeVCardValue(it).trim() }
        val family = parts.getOrNull(0).orEmpty()
        val given = parts.getOrNull(1).orEmpty()
        val additional = parts.getOrNull(2).orEmpty()
        val prefix = parts.getOrNull(3).orEmpty()
        val suffix = parts.getOrNull(4).orEmpty()
        return listOf(prefix, given, additional, family, suffix)
            .filter { it.isNotEmpty() }
            .joinToString(" ")
    }

    private fun decodeVCardValue(value: String): String {
        return value
            .replace("\\n", "\n")
            .replace("\\N", "\n")
            .replace("\\,", ",")
            .replace("\\;", ";")
            .replace("\\\\", "\\")
    }

    private data class ParsedVCard(
        val displayName: String,
        val phoneNumbers: List<String>,
        val emailAddresses: List<String>
    )
}

package ai.eliza.plugins.messages

import android.content.Context
import android.net.Uri
import android.provider.Telephony

/**
 * Pure, [Context]-backed reader for the SMS query that
 * [MessagesPlugin.listMessages] exposes (id / thread / address / body / date /
 * type / read), optionally filtered by thread, newest-first.
 *
 * Extracted from the Capacitor plugin so the real `content://sms` query can be
 * exercised by an instrumented `androidTest` against the real SMS provider,
 * without a Capacitor `Bridge`/WebView (issue #9967). Requires `READ_SMS`;
 * [MessagesPlugin] delegates to it and marshals each record into the unchanged
 * JS shape.
 */
class MessagesReader(private val context: Context) {

    data class SmsRecord(
        val id: String,
        val threadId: String,
        val address: String,
        val body: String,
        val date: Long,
        val type: Int,
        val read: Boolean,
    )

    /** @throws IllegalStateException if the provider returns no cursor (matches
     *  the plugin's reject). */
    fun listMessages(threadId: String?, limit: Int): List<SmsRecord> {
        val normalizedThread = threadId?.trim()
        val selection =
            if (normalizedThread.isNullOrEmpty()) null else "${Telephony.Sms.THREAD_ID} = ?"
        val selectionArgs =
            if (normalizedThread.isNullOrEmpty()) null else arrayOf(normalizedThread)

        val cursor = context.contentResolver.query(
            Uri.parse("content://sms"),
            arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.THREAD_ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.DATE,
                Telephony.Sms.TYPE,
                Telephony.Sms.READ,
            ),
            selection,
            selectionArgs,
            "${Telephony.Sms.DATE} DESC",
        ) ?: throw IllegalStateException("SMS provider returned no cursor")

        val results = mutableListOf<SmsRecord>()
        cursor.use {
            val idCol = cursor.getColumnIndexOrThrow(Telephony.Sms._ID)
            val threadCol = cursor.getColumnIndexOrThrow(Telephony.Sms.THREAD_ID)
            val addressCol = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
            val bodyCol = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
            val dateCol = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
            val typeCol = cursor.getColumnIndexOrThrow(Telephony.Sms.TYPE)
            val readCol = cursor.getColumnIndexOrThrow(Telephony.Sms.READ)
            var count = 0
            while (cursor.moveToNext() && count < limit) {
                results.add(
                    SmsRecord(
                        id = cursor.getString(idCol),
                        threadId = cursor.getString(threadCol),
                        address = cursor.getString(addressCol) ?: "",
                        body = cursor.getString(bodyCol) ?: "",
                        date = cursor.getLong(dateCol),
                        type = cursor.getInt(typeCol),
                        read = cursor.getInt(readCol) == 1,
                    ),
                )
                count += 1
            }
        }
        return results
    }
}

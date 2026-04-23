package ai.eliza.plugins.messages

import android.Manifest
import android.net.Uri
import android.provider.Telephony
import android.telephony.SmsManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "MiladyMessages")
class MessagesPlugin : Plugin() {
    @PluginMethod
    fun sendSms(call: PluginCall) {
        if (!hasPermission(Manifest.permission.SEND_SMS)) {
            call.reject("SEND_SMS permission is required")
            return
        }
        val address = call.getString("address")?.trim()
        val body = call.getString("body") ?: ""
        if (address.isNullOrEmpty()) {
            call.reject("address is required")
            return
        }
        SmsManager.getDefault().sendTextMessage(address, null, body, null, null)
        call.resolve()
    }

    @PluginMethod
    fun listMessages(call: PluginCall) {
        if (!hasPermission(Manifest.permission.READ_SMS)) {
            call.reject("READ_SMS permission is required")
            return
        }
        val limit = call.getInt("limit") ?: 100
        val threadId = call.getString("threadId")?.trim()
        val selection = if (threadId.isNullOrEmpty()) null else "${Telephony.Sms.THREAD_ID} = ?"
        val selectionArgs = if (threadId.isNullOrEmpty()) null else arrayOf(threadId)
        val messages = JSArray()
        context.contentResolver.query(
            Uri.parse("content://sms"),
            arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.THREAD_ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.DATE,
                Telephony.Sms.TYPE,
                Telephony.Sms.READ
            ),
            selection,
            selectionArgs,
            "${Telephony.Sms.DATE} DESC"
        )?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(Telephony.Sms._ID)
            val threadCol = cursor.getColumnIndexOrThrow(Telephony.Sms.THREAD_ID)
            val addressCol = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
            val bodyCol = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
            val dateCol = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
            val typeCol = cursor.getColumnIndexOrThrow(Telephony.Sms.TYPE)
            val readCol = cursor.getColumnIndexOrThrow(Telephony.Sms.READ)
            var count = 0
            while (cursor.moveToNext() && count < limit) {
                val message = JSObject()
                message.put("id", cursor.getString(idCol))
                message.put("threadId", cursor.getString(threadCol))
                message.put("address", cursor.getString(addressCol) ?: "")
                message.put("body", cursor.getString(bodyCol) ?: "")
                message.put("date", cursor.getLong(dateCol))
                message.put("type", cursor.getInt(typeCol))
                message.put("read", cursor.getInt(readCol) == 1)
                messages.put(message)
                count += 1
            }
        }
        val result = JSObject()
        result.put("messages", messages)
        call.resolve(result)
    }
}

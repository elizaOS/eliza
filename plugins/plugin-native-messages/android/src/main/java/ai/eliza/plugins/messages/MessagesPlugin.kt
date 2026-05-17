package ai.eliza.plugins.messages

import android.app.Activity
import android.app.PendingIntent
import android.Manifest
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.net.Uri
import android.provider.Telephony
import android.telephony.SmsManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@CapacitorPlugin(name = "ElizaMessages")
class MessagesPlugin : Plugin() {
    private val requestCounter = AtomicInteger(1)

    @PluginMethod
    fun sendSms(call: PluginCall) {
        if (!hasPermission(Manifest.permission.SEND_SMS)) {
            call.reject("SEND_SMS permission is required")
            return
        }
        val address = call.getString("address")?.trim()
        val body = call.getString("body")?.trim()
        if (address.isNullOrEmpty()) {
            call.reject("address is required")
            return
        }
        if (body.isNullOrEmpty()) {
            call.reject("body is required")
            return
        }

        val smsManager = SmsManager.getDefault()
        val parts = smsManager.divideMessage(body)
        if (parts.isEmpty()) {
            call.reject("body is required")
            return
        }

        val requestId = requestCounter.getAndIncrement()
        val action = "${context.packageName}.ELIZA_SMS_SENT.$requestId"
        val remaining = AtomicInteger(parts.size)
        val failed = AtomicBoolean(false)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (resultCode != Activity.RESULT_OK) {
                    failed.set(true)
                }
                if (remaining.decrementAndGet() == 0) {
                    receiverContext.unregisterReceiver(this)
                    if (failed.get()) {
                        call.reject("SMS send failed with result code $resultCode")
                    } else {
                        try {
                            call.resolve(persistSentSms(address, body))
                        } catch (error: RuntimeException) {
                            call.reject("SMS sent but Android SMS provider did not persist the sent row", error)
                        }
                    }
                }
            }
        }

        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(receiver, filter)
        }

        val pendingIntents = ArrayList<PendingIntent>()
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        for (index in parts.indices) {
            val sentIntent = Intent(action).setPackage(context.packageName)
            pendingIntents.add(
                PendingIntent.getBroadcast(context, requestId + index, sentIntent, flags)
            )
        }

        try {
            if (parts.size == 1) {
                smsManager.sendTextMessage(address, null, parts.first(), pendingIntents.first(), null)
            } else {
                smsManager.sendMultipartTextMessage(address, null, parts, pendingIntents, null)
            }
        } catch (error: RuntimeException) {
            context.unregisterReceiver(receiver)
            call.reject("SMS send failed before radio handoff", error)
        }
    }

    @PluginMethod
    fun listMessages(call: PluginCall) {
        if (!hasPermission(Manifest.permission.READ_SMS)) {
            call.reject("READ_SMS permission is required")
            return
        }
        val limit = call.getInt("limit") ?: 100
        if (limit <= 0 || limit > 500) {
            call.reject("limit must be between 1 and 500")
            return
        }
        val threadId = call.getString("threadId")?.trim()
        val selection = if (threadId.isNullOrEmpty()) null else "${Telephony.Sms.THREAD_ID} = ?"
        val selectionArgs = if (threadId.isNullOrEmpty()) null else arrayOf(threadId)
        val messages = JSArray()
        val cursor = context.contentResolver.query(
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
        )
        if (cursor == null) {
            call.reject("SMS provider returned no cursor")
            return
        }
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

    private fun persistSentSms(address: String, body: String): JSObject {
        val sentAt = System.currentTimeMillis()
        val values = ContentValues()
        values.put(Telephony.Sms.ADDRESS, address)
        values.put(Telephony.Sms.BODY, body)
        values.put(Telephony.Sms.DATE, sentAt)
        values.put(Telephony.Sms.DATE_SENT, sentAt)
        values.put(Telephony.Sms.READ, 1)
        values.put(Telephony.Sms.SEEN, 1)
        values.put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_SENT)

        val inserted = context.contentResolver.insert(Telephony.Sms.Sent.CONTENT_URI, values)
            ?: throw IllegalStateException("SMS provider returned no sent row URI")

        val result = JSObject()
        result.put("messageUri", inserted.toString())
        result.put("messageId", inserted.lastPathSegment ?: "")
        return result
    }
}

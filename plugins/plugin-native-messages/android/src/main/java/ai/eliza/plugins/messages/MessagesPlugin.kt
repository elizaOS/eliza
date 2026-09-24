package ai.eliza.plugins.messages

import android.app.Activity
import android.app.PendingIntent
import android.Manifest
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

// Declares the `sms` alias so the Capacitor base Plugin auto-provides
// checkPermissions()/requestPermissions() — SMS read/send is requested on first
// use of the Messages view, not at app launch.
@CapacitorPlugin(
    name = "ElizaMessages",
    permissions = [
        Permission(
            alias = "sms",
            strings = [
                Manifest.permission.SEND_SMS,
                Manifest.permission.READ_SMS,
            ],
        ),
    ],
)
class MessagesPlugin : Plugin() {
    private val requestCounter = AtomicInteger(1)

    @PluginMethod
    fun sendSms(call: PluginCall) {
        if (!hasPermission(Manifest.permission.SEND_SMS)) {
            call.reject("SEND_SMS permission is required")
            return
        }
        val address = call.getString("address")?.trim()
        val body = call.getString("body")
        if (address.isNullOrEmpty()) {
            call.reject("address is required")
            return
        }
        if (body.isNullOrBlank()) {
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
        val firstFailure = AtomicInteger(Activity.RESULT_OK)
        val sentUri = AtomicReference<String?>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (resultCode != Activity.RESULT_OK) {
                    firstFailure.compareAndSet(Activity.RESULT_OK, resultCode)
                }
                intent.getStringExtra("uri")?.let { sentUri.set(it) }
                if (remaining.decrementAndGet() == 0) {
                    receiverContext.unregisterReceiver(this)
                    if (firstFailure.get() != Activity.RESULT_OK) {
                        call.reject("SMS send failed with result code ${firstFailure.get()}")
                    } else {
                        try {
                            // Android persists messages sent by non-default SMS apps.
                            // A second insert can return content://sms/0 without writing
                            // anything. Return the system's actual sent-row receipt.
                            val receipt = if (Telephony.Sms.getDefaultSmsPackage(context) == context.packageName) {
                                persistSentSms(address, body)
                            } else {
                                sentSmsReceipt(sentUri.get())
                            }
                            call.resolve(receipt)
                        } catch (error: RuntimeException) {
                            call.reject("SMS was sent, but its persisted message receipt is unavailable", "SMS_SENT_RECEIPT_UNAVAILABLE", error)
                        }
                    }
                }
            }
        }

        val filter = IntentFilter(action)
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)

        val pendingIntents = ArrayList<PendingIntent>()
        // Telephony fills in the persisted URI. The callback stays package-scoped
        // and its receiver is not exported, including on pre-Android-13 devices.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
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
        // The content://sms query is delegated to MessagesReader so it can be
        // exercised by an instrumented androidTest without a Capacitor Bridge
        // (issue #9967); the JS shape below is unchanged.
        val messages = JSArray()
        try {
            for (record in MessagesReader(context).listMessages(call.getString("threadId"), limit)) {
                messages.put(
                    JSObject().apply {
                        put("id", record.id)
                        put("threadId", record.threadId)
                        put("address", record.address)
                        put("body", record.body)
                        put("date", record.date)
                        put("type", record.type)
                        put("read", record.read)
                    },
                )
            }
        } catch (error: IllegalStateException) {
            call.reject(error.message ?: "SMS provider returned no cursor")
            return
        }
        val result = JSObject()
        result.put("messages", messages)
        call.resolve(result)
    }

    private fun sentSmsReceipt(rawUri: String?): JSObject {
        val uri = rawUri?.let { Uri.parse(it) }
        val id = uri?.lastPathSegment
        check(uri?.scheme == "content" && uri.authority == "sms" && (id?.toLongOrNull() ?: 0) > 0) {
            "SMS was sent but Android did not supply a persisted message receipt"
        }
        return JSObject().apply {
            put("messageUri", uri.toString())
            put("messageId", id)
        }
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

        return sentSmsReceipt(inserted.toString())
    }
}

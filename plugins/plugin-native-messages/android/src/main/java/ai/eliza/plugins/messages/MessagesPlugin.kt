/** Dispatches Android SMS effects and translates provider and radio completion to Capacitor. */
package ai.eliza.plugins.messages

import android.app.role.RoleManager
import android.os.Handler
import android.os.Looper
import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission

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
    private val mainHandler = Handler(Looper.getMainLooper())
    private val sends = mutableSetOf<SmsSendRequest>()
    private var destroyed = false

    @PluginMethod
    fun sendSms(call: PluginCall) {
        if (!hasPermission(Manifest.permission.SEND_SMS)) {
            call.reject("SEND_SMS permission is required", "PERMISSION_DENIED")
            return
        }
        val address = call.getString("address")?.trim()
        val body = call.getString("body")
        if (address.isNullOrEmpty()) {
            call.reject("address is required", "INVALID_ARGUMENT")
            return
        }
        if (body.isNullOrBlank()) {
            call.reject("body is required", "INVALID_ARGUMENT")
            return
        }
        mainHandler.post {
            if (destroyed) {
                call.reject("SMS plugin was destroyed", "CANCELLED")
                return@post
            }
            val defaultSms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_SMS) == true
            } else {
                Telephony.Sms.getDefaultSmsPackage(context) == context.packageName
            }
            if (!defaultSms) {
                call.reject("Select Eliza as the default SMS app before sending; this API must persist the sent record", "DEFAULT_SMS_REQUIRED")
                return@post
            }
            var request: SmsSendRequest? = null
            try {
                val manager = SmsManager.getDefault()
                val parts = manager.divideMessage(body)
                require(parts.isNotEmpty()) { "SMS body could not be divided into parts" }
                val send = SmsSendRequest(context, parts.size) { outcome ->
                    sends.remove(request)
                    when (outcome) {
                        SmsSendRequest.Outcome.Sent -> {
                            try {
                                call.resolve(persistSentSms(address, body))
                            } catch (error: RuntimeException) {
                                // error-policy:J1 Radio success and provider failure must not be mistaken for an unsent SMS.
                                call.reject("SMS sent but Android SMS provider did not persist the sent row; do not resend", "SMS_SENT_PERSIST_FAILED", error)
                            }
                        }
                        is SmsSendRequest.Outcome.Failed -> call.reject(
                            "SMS send failed with result code ${outcome.resultCode}; some parts may have been sent",
                            "SMS_SEND_FAILED",
                        )
                        is SmsSendRequest.Outcome.Unknown -> call.reject(outcome.reason, "SMS_SEND_STATUS_UNKNOWN")
                    }
                }
                request = send
                sends.add(send)
                val receipts = send.start()
                if (parts.size == 1) {
                    manager.sendTextMessage(address, null, parts.first(), receipts.first(), null)
                } else {
                    manager.sendMultipartTextMessage(address, null, parts, receipts, null)
                }
            } catch (error: RuntimeException) {
                // error-policy:J1 The bridge settles dispatch failures and releases any registered receipt receiver.
                val send = request
                if (send != null) {
                    sends.remove(send)
                    send.cancel("SMS dispatch interrupted; send status is unknown: ${error.message}")
                } else {
                    call.reject("SMS dispatch failed: ${error.message}", "SMS_DISPATCH_FAILED", error)
                }
            }
        }
    }

    override fun handleOnDestroy() {
        destroyed = true
        for (send in sends.toList()) send.cancel("SMS plugin destroyed; send status is unknown")
        sends.clear()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun listMessages(call: PluginCall) {
        if (!hasPermission(Manifest.permission.READ_SMS)) {
            call.reject("READ_SMS permission is required")
            return
        }
        val rawLimit = call.data.opt("limit")
        val limit = if (!call.data.has("limit")) null else {
            if (rawLimit !is Number || !rawLimit.toDouble().isFinite() ||
                rawLimit.toDouble() < 1 || rawLimit.toDouble() > Int.MAX_VALUE ||
                rawLimit.toDouble() != rawLimit.toInt().toDouble()
            ) {
                call.reject("limit must be a positive 32-bit integer", "INVALID_ARGUMENT")
                return
            }
            rawLimit.toInt()
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
        } catch (error: SecurityException) {
            // error-policy:J1 Permission may be revoked during the provider query.
            call.reject("READ_SMS permission is required", "PERMISSION_DENIED", error)
            return
        } catch (error: IllegalStateException) {
            // error-policy:J1 A provider failure rejects instead of returning an empty inbox.
            call.reject(error.message ?: "SMS provider returned no cursor", "PROVIDER_UNAVAILABLE", error)
            return
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
        result.put("messageId", inserted.lastPathSegment ?: throw IllegalStateException("SMS provider returned a URI without an id"))
        return result
    }
}

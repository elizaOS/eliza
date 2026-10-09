/** Exposes Android Telecom, complete call-history reads and agent-authored transcript storage through Capacitor. */
package ai.eliza.plugins.phone

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.CallLog
import android.telecom.TelecomManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import org.json.JSONObject

// Declares the `phone` alias so the Capacitor base Plugin auto-provides
// checkPermissions()/requestPermissions() — call placement + call-log access are
// requested on first use of the Phone view, not at app launch.
@CapacitorPlugin(
    name = "ElizaPhone",
    permissions = [
        Permission(
            alias = "phone",
            strings = [
                Manifest.permission.CALL_PHONE,
                Manifest.permission.READ_CALL_LOG,
                Manifest.permission.READ_PHONE_STATE,
            ],
        ),
    ],
)
class PhonePlugin : Plugin() {
    private val transcriptPreferencesName = "eliza_phone_call_transcripts"

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val status = PhoneStatusReader(context).readStatus()
        val result = JSObject()
        result.put("hasTelecom", status.hasTelecom)
        result.put("canPlaceCalls", status.canPlaceCalls)
        result.put("defaultDialerPackage", status.defaultDialerPackage ?: JSONObject.NULL)
        result.put("isDefaultDialer", status.isDefaultDialer)
        call.resolve(result)
    }

    @PluginMethod
    fun placeCall(call: PluginCall) {
        val number = call.getString("number")?.trim()
        if (number.isNullOrEmpty()) {
            call.reject("number is required", "INVALID_ARGUMENT")
            return
        }
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        if (telecom == null) {
            call.reject("Telecom service is unavailable", "TELECOM_UNAVAILABLE")
            return
        }
        try {
            telecom.placeCall(Uri.parse("tel:$number"), Bundle())
            call.resolve()
        } catch (error: SecurityException) {
            // error-policy:J1 Telecom permission denial is returned to the bridge caller.
            call.reject("CALL_PHONE permission is required", "CALL_PERMISSION_DENIED", error)
        }
    }

    @PluginMethod
    fun openDialer(call: PluginCall) {
        val rawNumber = call.data.opt("number")
        if (call.data.has("number") && rawNumber !is String) {
            call.reject("number must be a string", "INVALID_ARGUMENT")
            return
        }
        val number = (rawNumber as? String)?.trim()
        val uri = Uri.fromParts("tel", number.orEmpty(), null)
        val intent = Intent(Intent.ACTION_DIAL, uri)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            call.resolve()
        } catch (error: android.content.ActivityNotFoundException) {
            call.reject("No dialer application is available", "DIALER_UNAVAILABLE", error)
        } catch (error: SecurityException) {
            call.reject("Android denied opening the dialer", "DIALER_PERMISSION_DENIED", error)
        }
    }

    @PluginMethod
    fun listRecentCalls(call: PluginCall) {
        if (!hasPermission(Manifest.permission.READ_CALL_LOG)) {
            call.reject("READ_CALL_LOG permission is required")
            return
        }
        val requestedLimit = (call.data.opt("limit") as? Number)?.toDouble()
        if (call.data.has("limit") && (requestedLimit == null || !requestedLimit.isFinite() ||
                requestedLimit <= 0 || requestedLimit > 9_007_199_254_740_991.0 || requestedLimit % 1.0 != 0.0)) {
            call.reject("limit must be a positive safe integer", "INVALID_LIMIT")
            return
        }
        try {
            call.resolve(readRecentCalls(call, requestedLimit?.toLong()))
        } catch (error: Exception) {
            // error-policy:J1 Reject incomplete history without exposing stored transcript text in parse errors.
            call.reject("Call history or saved transcripts could not be read", "CALL_HISTORY_UNAVAILABLE")
        }
    }

    private fun readRecentCalls(call: PluginCall, limit: Long?): JSObject {
        val number = call.getString("number")?.trim()
        val selection = if (number.isNullOrEmpty()) null else "${CallLog.Calls.NUMBER} LIKE ?"
        val selectionArgs = if (number.isNullOrEmpty()) null else arrayOf("%$number%")
        val calls = JSArray()
        val transcripts = readSavedTranscripts()
        val cursor = context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(
                CallLog.Calls._ID,
                CallLog.Calls.NUMBER,
                CallLog.Calls.CACHED_NAME,
                CallLog.Calls.DATE,
                CallLog.Calls.DURATION,
                CallLog.Calls.TYPE,
                CallLog.Calls.NEW,
                CallLog.Calls.PHONE_ACCOUNT_ID,
                CallLog.Calls.GEOCODED_LOCATION,
                CallLog.Calls.TRANSCRIPTION,
                CallLog.Calls.VOICEMAIL_URI
            ),
            selection,
            selectionArgs,
            "${CallLog.Calls.DATE} DESC"
        ) ?: throw IllegalStateException("Call log provider returned no cursor")
        cursor.use {
            val idCol = cursor.getColumnIndexOrThrow(CallLog.Calls._ID)
            val numberCol = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
            val nameCol = cursor.getColumnIndexOrThrow(CallLog.Calls.CACHED_NAME)
            val dateCol = cursor.getColumnIndexOrThrow(CallLog.Calls.DATE)
            val durationCol = cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION)
            val typeCol = cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE)
            val newCol = cursor.getColumnIndexOrThrow(CallLog.Calls.NEW)
            val accountCol = cursor.getColumnIndexOrThrow(CallLog.Calls.PHONE_ACCOUNT_ID)
            val locationCol = cursor.getColumnIndexOrThrow(CallLog.Calls.GEOCODED_LOCATION)
            val transcriptionCol = cursor.getColumnIndexOrThrow(CallLog.Calls.TRANSCRIPTION)
            val voicemailCol = cursor.getColumnIndexOrThrow(CallLog.Calls.VOICEMAIL_URI)
            while ((limit == null || calls.length().toLong() < limit) && cursor.moveToNext()) {
                val id = cursor.getString(idCol)
                val type = cursor.getInt(typeCol)
                val savedTranscript = transcripts[id]
                val entry = JSObject()
                entry.put("id", id)
                entry.put("number", cursor.getString(numberCol) ?: "")
                entry.put("cachedName", cursor.getString(nameCol) ?: JSONObject.NULL)
                entry.put("date", cursor.getLong(dateCol))
                entry.put("durationSeconds", cursor.getLong(durationCol))
                entry.put("type", callLogType(type))
                entry.put("rawType", type)
                entry.put("isNew", cursor.getInt(newCol) == 1)
                entry.put("phoneAccountId", cursor.getString(accountCol) ?: JSONObject.NULL)
                entry.put("geocodedLocation", cursor.getString(locationCol) ?: JSONObject.NULL)
                entry.put("transcription", cursor.getString(transcriptionCol) ?: JSONObject.NULL)
                entry.put("voicemailUri", cursor.getString(voicemailCol) ?: JSONObject.NULL)
                entry.put("agentTranscript", savedTranscript?.optionalString("transcript") ?: JSONObject.NULL)
                entry.put("agentSummary", savedTranscript?.optionalString("summary") ?: JSONObject.NULL)
                entry.put(
                    "agentTranscriptUpdatedAt",
                    if (savedTranscript != null && savedTranscript.has("updatedAt")) {
                        savedTranscript.optLong("updatedAt")
                    } else {
                        JSONObject.NULL
                    }
                )
                calls.put(entry)
            }
        }
        val result = JSObject()
        result.put("calls", calls)
        return result
    }

    @PluginMethod
    fun saveCallTranscript(call: PluginCall) {
        val callId = call.getString("callId")?.trim()
        if (callId.isNullOrEmpty()) {
            call.reject("callId is required")
            return
        }
        val transcript = call.getString("transcript")
        if (transcript.isNullOrBlank()) {
            call.reject("transcript is required")
            return
        }
        val summary = call.getString("summary")
        val updatedAt = System.currentTimeMillis()
        val payload = JSONObject()
            .put("transcript", transcript)
            .put("summary", summary ?: JSONObject.NULL)
            .put("updatedAt", updatedAt)
        try {
            val saved = context.getSharedPreferences(transcriptPreferencesName, Context.MODE_PRIVATE)
                .edit()
                .putString(callId, payload.toString())
                .commit()
            if (!saved) throw IllegalStateException("Transcript persistence did not complete")
        } catch (error: Exception) {
            // error-policy:J1 A failed persistence attempt cannot acknowledge a saved transcript or expose its contents.
            call.reject("Call transcript could not be saved", "TRANSCRIPT_SAVE_FAILED")
            return
        }

        val result = JSObject()
        result.put("updatedAt", updatedAt)
        call.resolve(result)
    }

    private fun readSavedTranscripts(): Map<String, JSONObject> {
        val preferences = context.getSharedPreferences(transcriptPreferencesName, Context.MODE_PRIVATE)
        val entries = mutableMapOf<String, JSONObject>()
        for ((key, value) in preferences.all) {
            val raw = value as? String ?: throw IllegalStateException("Saved transcript has an invalid storage type")
            val parsed = JSONObject(raw)
            val transcript = parsed.opt("transcript")
            val summary = parsed.opt("summary")
            val updatedAt = (parsed.opt("updatedAt") as? Number)?.toDouble()
            if (transcript !is String || transcript.isBlank() ||
                (summary != null && summary != JSONObject.NULL && summary !is String) ||
                updatedAt == null || !updatedAt.isFinite() || updatedAt <= 0 ||
                updatedAt > 9_007_199_254_740_991.0 || updatedAt % 1.0 != 0.0) {
                throw IllegalStateException("Saved transcript has invalid fields")
            }
            entries[key] = parsed
        }
        return entries
    }

    private fun callLogType(type: Int): String {
        return when (type) {
            CallLog.Calls.INCOMING_TYPE -> "incoming"
            CallLog.Calls.OUTGOING_TYPE -> "outgoing"
            CallLog.Calls.MISSED_TYPE -> "missed"
            CallLog.Calls.VOICEMAIL_TYPE -> "voicemail"
            CallLog.Calls.REJECTED_TYPE -> "rejected"
            CallLog.Calls.BLOCKED_TYPE -> "blocked"
            CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> "answered_externally"
            else -> "unknown"
        }
    }

    private fun JSONObject.optionalString(key: String): String? {
        if (!has(key) || isNull(key)) return null
        return optString(key)
    }
}

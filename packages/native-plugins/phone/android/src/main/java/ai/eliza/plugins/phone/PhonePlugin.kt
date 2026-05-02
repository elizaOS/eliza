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
import org.json.JSONObject

@CapacitorPlugin(name = "ElizaPhone")
class PhonePlugin : Plugin() {
    private val transcriptPreferencesName = "eliza_phone_call_transcripts"

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        val result = JSObject()
        result.put("hasTelecom", telecom != null)
        result.put("canPlaceCalls", hasPermission(Manifest.permission.CALL_PHONE))
        result.put("defaultDialerPackage", telecom?.defaultDialerPackage)
        result.put("isDefaultDialer", telecom?.defaultDialerPackage == context.packageName)
        call.resolve(result)
    }

    @PluginMethod
    fun placeCall(call: PluginCall) {
        val number = call.getString("number")?.trim()
        if (number.isNullOrEmpty()) {
            call.reject("number is required")
            return
        }
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        if (telecom == null) {
            call.reject("Telecom service is unavailable")
            return
        }
        try {
            telecom.placeCall(Uri.parse("tel:$number"), Bundle())
            call.resolve()
        } catch (error: SecurityException) {
            call.reject("CALL_PHONE permission is required", error)
        }
    }

    @PluginMethod
    fun openDialer(call: PluginCall) {
        val number = call.getString("number")?.trim()
        val uri = if (number.isNullOrEmpty()) Uri.parse("tel:") else Uri.parse("tel:$number")
        val intent = Intent(Intent.ACTION_DIAL, uri)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun listRecentCalls(call: PluginCall) {
        if (!hasPermission(Manifest.permission.READ_CALL_LOG)) {
            call.reject("READ_CALL_LOG permission is required")
            return
        }
        val limit = call.getInt("limit") ?: 100
        if (limit <= 0 || limit > 500) {
            call.reject("limit must be between 1 and 500")
            return
        }
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
        )
        if (cursor == null) {
            call.reject("Call log provider returned no cursor")
            return
        }
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
            var count = 0
            while (cursor.moveToNext() && count < limit) {
                val id = cursor.getString(idCol)
                val type = cursor.getInt(typeCol)
                val savedTranscript = transcripts[id]
                val entry = JSObject()
                entry.put("id", id)
                entry.put("number", cursor.getString(numberCol) ?: "")
                entry.put("cachedName", cursor.getString(nameCol))
                entry.put("date", cursor.getLong(dateCol))
                entry.put("durationSeconds", cursor.getLong(durationCol))
                entry.put("type", callLogType(type))
                entry.put("rawType", type)
                entry.put("isNew", cursor.getInt(newCol) == 1)
                entry.put("phoneAccountId", cursor.getString(accountCol))
                entry.put("geocodedLocation", cursor.getString(locationCol))
                entry.put("transcription", cursor.getString(transcriptionCol))
                entry.put("voicemailUri", cursor.getString(voicemailCol))
                entry.put("agentTranscript", savedTranscript?.optionalString("transcript"))
                entry.put("agentSummary", savedTranscript?.optionalString("summary"))
                entry.put(
                    "agentTranscriptUpdatedAt",
                    if (savedTranscript != null && savedTranscript.has("updatedAt")) {
                        savedTranscript.optLong("updatedAt")
                    } else {
                        null
                    }
                )
                calls.put(entry)
                count += 1
            }
        }
        val result = JSObject()
        result.put("calls", calls)
        call.resolve(result)
    }

    @PluginMethod
    fun saveCallTranscript(call: PluginCall) {
        val callId = call.getString("callId")?.trim()
        if (callId.isNullOrEmpty()) {
            call.reject("callId is required")
            return
        }
        val transcript = call.getString("transcript")?.trim()
        if (transcript.isNullOrEmpty()) {
            call.reject("transcript is required")
            return
        }
        val summary = call.getString("summary")?.trim()
        val updatedAt = System.currentTimeMillis()
        val payload = JSONObject()
            .put("transcript", transcript)
            .put("summary", if (summary.isNullOrEmpty()) JSONObject.NULL else summary)
            .put("updatedAt", updatedAt)
        context.getSharedPreferences(transcriptPreferencesName, Context.MODE_PRIVATE)
            .edit()
            .putString(callId, payload.toString())
            .apply()

        val result = JSObject()
        result.put("updatedAt", updatedAt)
        call.resolve(result)
    }

    private fun readSavedTranscripts(): Map<String, JSONObject> {
        val preferences = context.getSharedPreferences(transcriptPreferencesName, Context.MODE_PRIVATE)
        val entries = mutableMapOf<String, JSONObject>()
        for ((key, value) in preferences.all) {
            val raw = value as? String ?: continue
            val parsed = JSONObject(raw)
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

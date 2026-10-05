package ai.eliza.testing

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.CallLog
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable

/** Owns only the synthetic rows inserted by this test; never clears the call log. */
class PhoneCallLogFixture(private val context: Context) : Closeable {
    private val rows = mutableListOf<Uri>()
    val descriptor = JSONObject()

    init {
        try {
            val number = "+155501" + System.currentTimeMillis().toString().takeLast(7)
            val ids = JSONArray()
            val now = System.currentTimeMillis()
            for (type in listOf(1, 2, 3, 5, 6, 7)) {
                val values = ContentValues().apply {
                    put(CallLog.Calls.NUMBER, number)
                    put(CallLog.Calls.CACHED_NAME, "Eliza native call fixture")
                    put(CallLog.Calls.DATE, now - type * 1000)
                    put(CallLog.Calls.DURATION, type * 11)
                    put(CallLog.Calls.TYPE, type)
                    put(CallLog.Calls.NEW, if (type == 3) 1 else 0)
                }
                val row = requireNotNull(context.contentResolver.insert(CallLog.Calls.CONTENT_URI, values))
                rows.add(row)
                ids.put(requireNotNull(row.lastPathSegment))
            }
            // A newer unrelated row proves number filtering happens before limiting.
            val other = ContentValues().apply {
                put(CallLog.Calls.NUMBER, "+1555990000000")
                put(CallLog.Calls.CACHED_NAME, "Eliza native call fixture")
                put(CallLog.Calls.DATE, now)
                put(CallLog.Calls.TYPE, CallLog.Calls.OUTGOING_TYPE)
            }
            rows.add(requireNotNull(context.contentResolver.insert(CallLog.Calls.CONTENT_URI, other)))
            descriptor.put("number", number).put("ids", ids)
        } catch (error: Throwable) {
            try { close() } catch (cleanup: Throwable) { error.addSuppressed(cleanup) }
            throw error
        }
    }

    override fun close() {
        val preferences = context.getSharedPreferences("eliza_phone_call_transcripts", Context.MODE_PRIVATE)
        for (row in rows) {
            context.contentResolver.delete(CallLog.Calls.CONTENT_URI, "${CallLog.Calls._ID} = ?", arrayOf(row.lastPathSegment))
            preferences.edit().remove(row.lastPathSegment).commit()
        }
        rows.clear()
    }
}

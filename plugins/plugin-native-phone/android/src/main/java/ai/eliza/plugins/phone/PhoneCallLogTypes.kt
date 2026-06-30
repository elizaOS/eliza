package ai.eliza.plugins.phone

import android.provider.CallLog

/**
 * Maps Android `CallLog.Calls` integer type constants to the stable bridge
 * strings the JS layer consumes. Extracted from [PhonePlugin] so the mapping is
 * unit-testable without an Android device (see `PhoneCallLogTypesTest`).
 */
object PhoneCallLogTypes {
    fun toBridgeType(type: Int): String = when (type) {
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

# @elizaos/capacitor-phone

Android phone and Telecom bridge for elizaOS. A [Capacitor](https://capacitorjs.com/) plugin that gives Eliza agents running inside a Capacitor-wrapped Android application access to native phone capabilities: placing calls, opening the system dialer, reading the call log, and persisting agent-authored transcripts alongside call records.

## Capabilities

| Capability | Description |
|---|---|
| **Check phone status** | Query whether the Telecom service is available, whether `CALL_PHONE` permission is granted, and whether the host app is the system default dialer. |
| **Place a call** | Initiate an outgoing call to any number via `TelecomManager`. Requires the `CALL_PHONE` runtime permission. |
| **Open the system dialer** | Launch the Android dialer activity, optionally pre-filled with a phone number. Does not require the `CALL_PHONE` permission. |
| **Read the call log** | Retrieve all matching call records (incoming, outgoing, missed, voicemail, rejected, blocked). Supports filtering by phone number and an optional positive caller-requested result limit. Requires `READ_CALL_LOG` runtime permission. |
| **Save call transcripts** | Persist an agent-authored transcript and optional summary for a specific call. The data is stored in Android SharedPreferences and automatically merged into call log entries on subsequent reads. |

## Platform support

| Platform | Status |
|---|---|
| Android | Full native implementation |
| Web / browser | `getStatus` reports disabled capabilities; history, mutations and permission methods reject with `UNAVAILABLE` |
| iOS | Unsupported |

## Installation

Add the package to your Capacitor app:

```bash
bun add @elizaos/capacitor-phone
```

Then register the plugin in your Android project's `MainActivity`:

```kotlin
import ai.eliza.plugins.phone.PhonePlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(PhonePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
```

## Required Android permissions

The plugin declares the following permissions in its `AndroidManifest.xml`. Some must also be granted at runtime:

| Permission | Required for | Runtime prompt |
|---|---|---|
| `CALL_PHONE` | `placeCall` | Yes |
| `READ_CALL_LOG` | `listRecentCalls` | Yes |
| `READ_PHONE_STATE` | Telecom status queries | Declared |
| `ANSWER_PHONE_CALLS` | Future Telecom connection service | Declared |
| `MANAGE_OWN_CALLS` | Future Telecom connection service | Declared |
| `WRITE_CALL_LOG` | Future write support | Declared |

## Usage

```typescript
import { Phone } from "@elizaos/capacitor-phone";

// Check capabilities
const status = await Phone.getStatus();
console.log(status.canPlaceCalls, status.isDefaultDialer);

// Open dialer (no CALL_PHONE permission needed)
await Phone.openDialer({ number: "+15555550100" });

// Place a call (requires CALL_PHONE permission)
await Phone.placeCall({ number: "+15555550100" });

// Read recent calls
const { calls } = await Phone.listRecentCalls({ limit: 20 });

// Filter by number
const { calls: filtered } = await Phone.listRecentCalls({ number: "555" });

// Save an agent transcript for a call
const { updatedAt } = await Phone.saveCallTranscript({
  callId: calls[0].id,
  transcript: "Hello, how can I help you today?...",
  summary: "Customer asked about account balance.",
});
```

## Call log entry shape

Each entry returned by `listRecentCalls` conforms to `CallLogEntry`:

```typescript
interface CallLogEntry {
  id: string;
  number: string;
  cachedName: string | null;
  date: number;               // epoch ms
  durationSeconds: number;
  type: CallLogType;          // "incoming" | "outgoing" | "missed" | "voicemail" | "rejected" | "blocked" | "answered_externally" | "unknown"
  rawType: number;
  isNew: boolean;
  phoneAccountId: string | null;
  geocodedLocation: string | null;
  transcription: string | null;      // system-provided (OS voicemail transcription)
  voicemailUri: string | null;
  agentTranscript: string | null;    // agent-saved via saveCallTranscript
  agentSummary: string | null;
  agentTranscriptUpdatedAt: number | null;
}
```

## Build

```bash
bun run --cwd plugins/plugin-native-phone build
```

This runs `tsc` (TypeScript compilation to `dist/esm/`) followed by rollup (bundling to `dist/plugin.js` and `dist/plugin.cjs.js`).

## Android call-history validation

Explicit limits must be positive safe integers; malformed values reject with
`INVALID_LIMIT`. Omission returns complete matching history. Provider or saved
transcript failures reject the complete read with `CALL_HISTORY_UNAVAILABLE`;
partial history is not returned as successful data. Saved transcript and summary
text retain their exact whitespace and Unicode content.
Absent nullable call-history and status values are emitted as JSON `null`, so
the native wire response matches the published required nullable fields.

The native `PhoneHistoryInstrumentedTest` uses a real Capacitor BridgeActivity,
CallLog provider and isolated preferences. It verifies newest-first filtered
reads, numeric limits, invalid input, complete transcript round-trips and corrupt
stored-data rejection. Synthetic call rows are deleted by their exact inserted
IDs; test preferences belong to the isolated test APK. No carrier call is made.
Build `:elizaos-capacitor-phone:assembleDebugAndroidTest`, install its test APK
on an exclusive emulator, then run:

```bash
adb -s DEVICE shell am instrument -w \
  ai.eliza.plugins.phone.test/androidx.test.runner.AndroidJUnitRunner
```

Check the terminal instrumentation result rather than relying on shell exit 0.

The browser/Node fallback never reports unsupported history as an empty call log
or unsupported phone permissions as granted. Valid operation requests reject
with Capacitor `UNAVAILABLE`; malformed inputs still receive validation errors.
`getStatus()` remains available to report the disabled phone capabilities.

Android acknowledges a transcript save only after SharedPreferences reports a
successful disk commit. Persistence failure rejects with `TRANSCRIPT_SAVE_FAILED`
and no saved timestamp. The native suite verifies actual disk contents at
acknowledgment and injects a write failure only in the isolated test app’s own
preferences directory, restoring its permissions afterward.

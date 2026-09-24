# @elizaos/plugin-native-phone

Android dialer overlay + iOS Phone Companion (pairing, chat-mirror, remote-session) for Eliza agents.

Build, test, and setup: [README.md](README.md).

Android history is complete unless an explicit positive safe-integer limit is
requested. Malformed limits reject with INVALID_LIMIT; provider or stored-data
failures reject with CALL_HISTORY_UNAVAILABLE, without partial history. Nullable
wire fields remain explicit JSON null. Transcripts preserve complete text and
whitespace; save acknowledgment follows disk commit and failed persistence rejects
with TRANSCRIPT_SAVE_FAILED.

Non-Android history, mutation and permission operations reject with UNAVAILABLE;
getStatus reports disabled capabilities. The Phone view distinguishes loading,
ready-empty and unavailable history, preserves bridge errors and disables Call
until actual readiness succeeds. An unsuccessful call does not erase valid history.

The isolated PhoneHistoryInstrumentedTest uses real CallLog and preferences,
exact-ID synthetic cleanup, corrupt-data rejection and an owned write-failure
fixture. It does not place a carrier call. Inspect terminal instrumentation
success rather than treating shell exit 0 as a passing suite.

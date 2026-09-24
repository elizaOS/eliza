# @elizaos/plugin-native-phone

Android dialer overlay + iOS Phone Companion (pairing, chat-mirror, remote-session) for
Eliza agents.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-phone build  # build
bun run --cwd plugins/plugin-native-phone test   # tests
```

Native view and app-shell declarations share an ADMIN-gated capability catalog. Agents use named complete-or-error reads; mutations and generic renderer/DOM operations require human interaction. A bridge result at its non-paginated boundary is an explicit incomplete-read error. Device-status failures remain errors rather than fabricated empty state.

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

# @elizaos/ui

Shared React UI library for elizaOS apps: primitives, composites, layouts, the typed HTTP/WS API client, agent-surface view
instrumentation, GenUI, voice, and host capability interfaces.

Public JavaScript APIs use the package root; UI internals import owner files directly.
The app owns renderer composition and native transport selection. Consumers render
domain DTOs imported from `@elizaos/contracts`; business logic belongs to domain services. Use `bun run --cwd packages/ui storybook` for
component development. Changes reaching the app require its visual audit.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/ui build  # build
bun run --cwd packages/ui test   # tests
```

`bun run --cwd packages/ui audit:design` reports current component ownership
and possible duplication. It is advisory; lint, typecheck, rendered behavior,
and accessibility checks remain separate.

The browser-safe `TaskChoice` export renders validated
task choices in a chat or panel. The host owns transport, authorization, styling
and localized messages. It suppresses duplicate in-flight clicks and expired
responses; the durable runtime remains authoritative. Hosts that pass
`explainUnavailable` keep options activatable (`aria-disabled`) and announce why
an in-flight or expired choice cannot be used, and hide options once the choice
is no longer pending. `splitSpeechSegments`
shares lossless caption/playback chunks without importing the voice runtime.

`TaskLifecycle` projects authoritative task status and
reconciles start/pause/resume/cancel requests without optimistically reporting
success. Hosts provide transport, localized failure messages and view updates.
The durable runtime remains authoritative; this projection grants no task authority.

`encodeMonoPcm16Wav` and `encodeMonoPcm16WavChunks` share mono PCM16 WAV encoding for single buffers or
cumulative chunks without importing capture, desktop bridge or provider code.
Hosts own recording lifecycle, sample-rate selection and playback/transcription.
Nonfinite samples encode as silence; finite samples are clipped and rounded.

`BrowserDocumentStore` stores opaque text with IndexedDB transaction receipts.
Its compare-and-swap operation detects stale writes and retains reset tombstones;
`readOrCreate` initializes absent bytes atomically while preserving existing receipts,
including reset tombstones, across concurrent callers and tabs.
`edit` serializes asynchronous, side-effect-free callbacks with Web Locks and never
replays them. Cancellation prevents a late callback from committing. Hosts own
storage namespaces, schema validation, legacy migration and recovery presentation.
This API does not maintain a localStorage mirror. Run
`bun run --cwd packages/ui test:browser-document-store` for real cross-tab,
cancellation and recovery checks in Chromium, Firefox and WebKit.

`startCumulativeMicrophoneCapture` and `observeMicrophonePause` share cumulative sample previews and speech-pause
observation without owning microphone tracks, transcription or message submission.
Hosts supply timing/energy policy and the URL of `voice/microphone-samples.worklet.mjs`
(or a compatible mono worklet). Previews are single-flight and are not replayed;
unsupported capture returns no observer so the host can retain final-recording UX.

`createRuntimeJsonClient` shares JSON request handling and coalesced native
startup for host-selected runtime bridges. Hosts supply URLs, native HTTP
fallback, budgets and messages. Once native availability is established, failures
never fall back or replay requests. Account refresh fences earlier responses;
cancelling their publication does not undo native effects already dispatched.
Requests wait for account refresh. A failed or timed-out refresh blocks requests
until the host explicitly retries refresh; late status replies cannot restart polling.

`formatMinorCurrency` formats safe integer minor units through an exact decimal
string, checking the selected currency exponent. `isIsoCalendarDate` and
`isOrderedIsoDateRange` reject normalized invalid dates and reversed inclusive
ranges. These browser-safe helpers leave locale, labels and domain policy to hosts.

`ConversationTurnController` owns explicit single-flight creation/send, cached room
identity, interruption and stale-reply fencing without importing the shell. Hosts
supply transport, ownership-error classification, request metadata and synchronous
reply/error/settled observers. Interrupted work never publishes or replays. A new
send waits for an earlier room abort; failed aborts discard that room and report
failure before an explicit retry can create another. `reset` invalidates ownership
and teardown callbacks. A stop receipt does not prove an external action was undone.

Browser speech lifecycle leaves are available from `src/voice/device-speech-controller.ts`
and `src/voice/segmented-speech-playback.ts`. `DeviceSpeechController` owns device
utterance cancellation, stale callbacks and page visibility cleanup; dispose it on
unmount. `SegmentedSpeechPlayback` owns sequential synthesized clips, playback
state/captions, live rate changes and object URL/player cleanup. Inject synthesis
and state observers, call `stop()` on cancellation/teardown, and supply product
copy and consent gestures in the host. These encoded-audio and device-speech paths
do not replace the realtime PCM voice-session player or acquire a microphone.

`RecordedTranscriptionController` owns bounded MediaRecorder utterances, stream
cleanup, preview/final ordering and stale authorization/acquisition/transcription
responses. Supply authorization, shared capture/encoding adapters, a transcription
transport and selected bounds. `finish()` requests a final transcript; `cancel()`
releases resources without publishing late words. It never sends a chat message.
`DraftTranscriptGuard` distinguishes a recording's own preview updates from later
user edits and returns final conflicts for host review; hosts choose append/replace
policy and explicit review/send gestures.

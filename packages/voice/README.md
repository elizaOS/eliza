# @elizaos/voice

Browser-safe acoustic processing, turn analysis and speech metrics shared by UI,
native bridges and inference plugins. Import the public package barrel; internal
files import their defining modules directly. Batch renderer hosts can import
`@elizaos/voice/turn` for only the response gate and end-of-turn heuristic.
Native models and provider lifecycle
remain in their plugins.

From the repository root, run `bun run --cwd packages/voice build`,
and `bun run --cwd packages/voice typecheck`.

## Voice conversation session

`@elizaos/voice/assistant-session` exports `VoiceAssistantSession`, the conversation-voice
turn controller (hands-free: a finished turn is submitted automatically). Dictation, where the
transcript becomes an editable draft the user sends, is a separate host flow and never uses it.
The host supplies every port: one continuous capture that yields a final transcript per VAD
segment, `send`, `speak`, an optional semantic `endpoint` and the conversation binding checks.
The controller joins the segments of one utterance, asks `endpoint` once per utterance after a
short gap with a bounded deadline, and always submits after the long gap: an unavailable,
failing or late endpoint decision is never treated as complete. Resumed speech cancels a
pending submit, and confirmed speech over echo-cancelled capture interrupts an in-flight reply
or its playback (barge-in); only fully played sentences count as heard. Generation fencing
drops late endpoint, reply and playback callbacks, so a submitted turn is never resent. Mute,
stop, binding changes and owner-input pauses are handled; approvals are never given by voice.
`ASSISTANT_TIMING_DEFAULTS` are engineering defaults, not measured or accepted values. The module
has no DOM, storage, network or platform speech imports, and `bun run --cwd packages/voice test`
covers it with fake ports (not microphone, recognition, playback or latency evidence).

## Live ASR and voice-turn route clients

`@elizaos/voice/live-session` is the client of plugin-local-inference's on-device live ASR route
(`POST /api/asr/local-inference/live`). `createLiveVoiceSession` forwards the host's 16 kHz mono
frames and VAD edges in order, shows `voice-transcript` partials as display-only interim text
when the transport carries the agent event stream, and delivers each turn's final once (from the
response or the event). `createLiveSegmentStream` maps one continuous capture onto it: one result
per closed VAD segment (null when the segment produced no transcript), stop reconciliation
(`cutoff` drops audio stamped after the stop, `close` ends the open segment at it) and `cancel`
(discard). Its handlers are the `listen` port of `VoiceAssistantSession`.

`@elizaos/voice/turn-routes` holds the clients for the resident's end-of-turn route
(`residentEndpoint`, the controller's `endpoint` port: unavailable, malformed or over-long input is
never complete) and the heard route (`createHeardReporter`: after a barge-in only the played
prefix is kept, with one retry and never blocking the next turn). Hosts supply the owner-bound
request port; neither module carries audio anywhere else, stores or logs text. Vitest covers them
against stub agents; this is not microphone, recognition, scorer or latency evidence.

## Browser voice capture

`@elizaos/voice/browser-capture` records one MediaRecorder clip at a time. The host admits
the microphone (`openMicrophone(onLost)` returns the stream and its release) and receives the
finished clip in `stopped(event)`; clips stay in memory and nothing is uploaded or saved.
`decodeRecordingPcm` decodes a clip to bounded mono 16 kHz samples, and `encodePcm16Wav` /
`recordingPcmWav` produce mono PCM16 WAV for the host's speech service. The package has no
speech recognizer and no in-page model runtime; recognition belongs to the host, for example a
local agent's ASR route.
See `src/browser-capture/README.md`.

Browser consumers can qualify the recorder and PCM conversion in headless Chromium:

```sh
bun run --cwd packages/voice build
node packages/voice/test/consumer.mjs
```

It uses real MediaRecorder and Web Audio, never opens a physical microphone and makes no
request off the loopback host. It checks replacement capture ownership, decoding a WAV to
mono 16 kHz samples, PCM16 WAV encoding and cancellation. Reports are under root
`test-results/browser-capture-consumer`.

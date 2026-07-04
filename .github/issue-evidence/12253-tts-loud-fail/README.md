# #12253 — Voice TTS fails closed (no silent engine swap)

Sub-issue of #12187. Kokoro is the on-device voice; a Kokoro failure must be a
**loud error**, never a silent swap to a different voice engine. This directory
holds the failure-path evidence: with the Kokoro artifacts genuinely absent, the
whole chain fails loud and **no other voice plays**.

## Per-site before → after

| Site | Before (silent swap) | After (fails closed) |
|---|---|---|
| `plugins/plugin-local-inference/src/services/router-handler.ts` | ANY throw from the picked TTS provider rotated engines (Kokoro → elizacloud → elevenlabs → openai → groq → edge-tts) at `logger.info` | For `TEXT_TO_SPEECH` with any non-`manual` policy the router **re-throws** the structured error and `logger.error`s `failing closed — refusing to swap to another voice engine`. Only an explicit `manual` multi-provider chain still rotates. Non-TTS slots keep transient failover. |
| `plugins/plugin-local-inference/src/services/routing-policy.ts` | `prefer-local` + unviable device tier silently demoted the voice slot to cloud | `assessVoiceModality()` surfaces the demotion; the router warns **once per boot** and the `/api/local-inference/providers` route returns `voiceModality`, so a config-by-hardware cloud voice can never masquerade as a Kokoro failure. Demotion itself is kept — it is configuration, not error recovery. |
| `packages/core/src/runtime.ts` + `packages/core/src/services/message/fallback-reply.ts` | `shouldFailOverModelProvider` / `isModelProviderFallbackError` matched a Kokoro model-download `fetch failed` and rotated to the next registered TTS provider (`logger.warn`) | Both take `modelType`; `TEXT_TO_SPEECH` returns `false` unconditionally. A voice swap is never transient-recoverable. Text slots keep the heuristic. |
| `packages/ui/src/hooks/useVoiceChat.ts` | local-inference / ElevenLabs / native-talkmode failure fell through to browser `SpeechSynthesis` (`ttsDebug` only) | Each configured-engine failure calls `failClosed(engine, error)`: sets a visible `ttsError` state, stops the queue, `console.error`s, and does **not** call `speakBrowser`. Cleared on the next utterance. Cloud-proxy → direct-ElevenLabs-proxy stays (same voice, now `console.warn`). Browser TTS remains valid only as the **configured** engine. |
| `packages/ui/src/voice/voice-chat-types.ts` + `ChatVoiceStatusBar.tsx` + `ChatView.tsx` + `useContinuousChat.ts` | no user-visible surface for a silenced voice | `VoiceTtsError` type; the status bar renders a danger banner (`data-testid="chat-voice-tts-error"`) and force-shows even when otherwise hidden — a silenced voice is never invisible. |
| `plugins/plugin-native-talkmode/ios/.../TalkModePlugin.swift` | ElevenLabs streaming failure → `speakWithSystemTts` (AVSpeechSynthesizer) | Emits `elevenlabs_failed` and `call.resolve({ usedSystemTts: false, error })` + returns; AVSpeechSynthesizer is reachable only when the caller explicitly requests the system engine, never as error recovery. |
| `packages/app-core/src/runtime/voice-warmup.ts` | warmup went through the router, which could silently warm edge-tts and report a healthy warmup | Warmup goes through the router with no pinned provider; the router now fails closed for TTS, so a broken Kokoro surfaces its structured error at `warn` instead of a green warmup on a different voice. |

## Failure-path evidence (this is the issue DoD)

`01-failure-path-real-artifact-absence.log` — the real chain with Kokoro
artifacts **genuinely absent on disk** (`ELIZA_KOKORO_MODEL_DIR` → an empty temp
dir). No synthetic throw is injected; every step is the production code:

1. `resolveKokoroEngineConfig()` (real on-disk probe) → `null`.
2. `selectVoiceBackend({ kokoroAvailable: false })` (real engine selector) →
   throws `[voice] Kokoro model artifacts are not present on disk; …`.
3. The **real** router + policy engine (`prefer-local`, MAX tier) picks
   `eliza-local-inference`, its handler runs the real gate above and throws; the
   router **re-throws that exact error** and **never calls the registered
   `edge-tts` handler**. Captured loud log:

   ```
   [LocalInferenceRouter] eliza-local-inference failed for TEXT_TO_SPEECH; failing
   closed — refusing to swap to another voice engine (provider=eliza-local-inference,
   slot=TEXT_TO_SPEECH, policy=prefer-local, error=[voice] Kokoro model artifacts are
   not present on disk; …, alternativesRefused=1)
   ```

At the route boundary this structured error becomes **HTTP 502** (see
`plugins/plugin-local-inference/src/routes/local-inference-tts-route.ts:209,223`),
and in the web UI it becomes the visible `ttsError` banner
(`04-ui-hook-tests.log`, asserting a `502` sets `ttsError` and
`speechSynthesis.speak` is never called). iOS talkmode resolves
`usedSystemTts: false` with the error (source diff; Swift not runnable here).

## Test transcripts (real paths, no mocked subject-under-test)

| Log | Suite | Result |
|---|---|---|
| `01-failure-path-real-artifact-absence.log` | `router-tts-loud-fail-evidence.test.ts` — real on-disk absence → engine → router | 3 passed |
| `02-router-policy-tests.log` | `router-tts-fail-closed` + `router-voice-modality-warn` + `routing-policy` | 27 passed |
| `03-core-failover-tests.log` | `use-model-provider-fallback` + `provider-error-hygiene` (core failover excludes TTS) | 11 passed |
| `04-ui-hook-tests.log` | `useVoiceChat.fail-closed` (visible ttsError, no browser swap) | 3 passed |

The router/policy tests mock only `./hardware` (device tier) and
`./routing-preferences` (policy) so the pick is host-independent; the router,
policy engine, Kokoro gate, and core classifiers under test are the real code.

## Reproduce

```bash
# Failure path (real artifact absence → loud fail, no swap)
NODE_OPTIONS=--experimental-sqlite bun run --cwd plugins/plugin-local-inference \
  test -- router-tts-loud-fail-evidence --reporter verbose

# Full fail-closed contract
bun run --cwd plugins/plugin-local-inference test -- router-tts-fail-closed router-voice-modality-warn routing-policy
bun run --cwd packages/core test -- use-model-provider-fallback provider-error-hygiene
bun run --cwd packages/ui test -- useVoiceChat.fail-closed
```

## Not captured here (with reason)

- **Real STT→TTS audio round-trip / narrated walkthrough** — N/A: this change is
  a *negative* path (voice must **not** play on failure). The positive audio
  round-trip is unchanged and belongs to the sibling latency/quality issues
  (#12254/#12258). The audible assertion here is *silence + a surfaced error*,
  proven at the route/unit level above.
- **iOS on-device capture** — N/A in this worktree (no simulator/device build).
  The Swift fail-closed change is a source diff; the web + router + core paths
  are exercised for real above.

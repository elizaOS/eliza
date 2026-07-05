# Voice pipeline: cloud vs on-device STT/TTS, e2e testing

## Summary

The MVP is the LifeOps Personal Assistant (GitHub project 15): chat, onboarding, the
current views, and LifeOps scheduling/reminders/goals/tasks — serving children, adults
with ADHD/ADD/Asperger's/autism, neurotypical adults, and elderly users through real-life
scenarios, no therapy language, no special rails. Voice is a first-class input/output for
that audience (hands-busy reminders, users who won't type), so bidirectional voice — STT
in, TTS out — must work and be *proven* to work on every MVP surface.

This workstream evaluated cloud voice (the Railway deploys of Kokoro TTS and Whisper STT
that the Eliza Cloud API fronts) against on-device models. Decision in one line: **the
architecture is already right — on-device Kokoro TTS + fused ASR / OS recognizers where a
native runtime exists, Railway-backed cloud voice for web and unprovisioned devices —
but the cloud path is unbenchmarked, untested in CI, partially unwired on the client, and
pinned to an English-only tiny STT model.** The MVP work is measurement, wiring, and e2e
proof — not new voice infrastructure.

## Current state

What exists today, verified in code.

**Cloud voice = Railway Kokoro + Railway Whisper behind the Cloud API (free path).**
- `packages/cloud/api/v1/voice/tts/route.ts:164-198` — when `KOKORO_TTS_URL` is set, the
  cloud TTS route POSTs `{text, voice, speed}` to `<url>/api/tts` and streams the WAV back
  with **no credit reservation and no billing** ("free default voice"). Voice ids are
  allowlisted to 11 Kokoro presets defaulting to `af_heart` (`route.ts:96-111`).
  ElevenLabs remains the opt-in/custom-voice path below it.
- `packages/cloud/api/v1/voice/stt/route.ts:188-219` — when `WHISPER_STT_URL` is set, STT
  posts multipart audio to `<url>/v1/audio/transcriptions`, free. The model is
  **hardcoded to `Systran/faster-whisper-tiny.en`** (`route.ts:196`) — an English-only
  tiny model — even though the route accepts and forwards `languageCode`.
- Env vars are typed in `packages/cloud/shared/src/types/cloud-worker-env.ts:44,50` but
  are **not** in `wrangler.toml` — they are deploy-time Worker config. The provisioned
  service URLs exist in-repo only as defaults in one test:
  `kokoro-tts-production-aa4b.up.railway.app` / `whisper-stt-production-6fc7.up.railway.app`
  (`packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts:16-21`). There is **no
  Railway service definition** (Dockerfile, railway.json, deploy doc) for either service
  anywhere in the repo — the deploys are unreproducible pets.
- The live round-trip contract test (`voice-kokoro-whisper-live.test.ts`) drives the exact
  request shapes the routes use (Kokoro WAV out → Whisper transcript back, asserts salient
  words) but is gated on `ELIZA_VOICE_LIVE_RAILWAY=1` and **referenced by zero workflows**
  — it has no CI lane and asserts nothing about latency.

**Who consumes the cloud voice routes.**
- Server-side agent handlers: `plugins/plugin-elizacloud/src/models/speech.ts` posts to
  `/api/v1/voice/tts`; `transcription.ts:145-149` posts to `/api/v1/voice/stt`. Note:
  `transcription.ts:70-71` resolves and logs `ELIZAOS_CLOUD_TRANSCRIPTION_MODEL`
  (default `gpt-5-mini-transcribe`) but the route ignores any model — the log is
  misleading and the knob is dead on this path.
- The app's TTS proxy: `POST /api/tts/cloud` (`packages/app-core/src/api/route-auth-policy.ts:166`,
  handler in `plugins/plugin-elizacloud/src/lib/server-cloud-tts.ts`) forwards to
  `<cloud-base>/voice/tts` (`packages/shared/src/elizacloud/server-cloud-tts.ts:201-209`).
  The chat voice hook tries this first, then falls back to the ElevenLabs proxy
  (`packages/ui/src/hooks/useVoiceChat.ts:1221-1301`).
- The Kokoro branch returns **before** the ElevenLabs first-line cache
  (`tts/route.ts:236-288`), so cloud Kokoro gets no short-utterance caching:
  time-to-audio-start is full Railway synthesis per request, every request.

**Client provider defaults vs what actually runs — there is a gap.**
- The documented matrix (`packages/ui/src/voice/voice-provider-defaults.ts:54-83`):
  desktop-local → TTS+ASR `local-inference`; mobile-local → TTS `local-inference`
  (on-device Kokoro), ASR `eliza-cloud`; cloud/remote/web → TTS `edge`, ASR `eliza-cloud`.
- But the capture factory (`packages/ui/src/voice/voice-capture-factory.ts:163-192`)
  resolves `eliza-cloud`/`openai` ASR to **browser `SpeechRecognition`** ("Eliza-cloud /
  OpenAI providers go through the local-inference route server-side today; … browser API
  is the only sane client-side fallback"), and native mobile always prefers the TalkMode
  OS recognizer. Consequence: **interactive voice capture never sends audio to the Railway
  Whisper service.** It is exercised only by server-side `TRANSCRIPTION` calls (voice-memo
  attachments, connector audio). Web users in cloud mode get an engine-dependent,
  unmeasured browser recognizer; browsers without the Web Speech API get no STT at all.
- `edge` TTS resolves to browser `speechSynthesis` voices in chat
  (`useVoiceChat.ts:1736-1745`) and to `@elizaos/plugin-edge-tts` (free Microsoft neural
  voices) server-side, wrapped by the first-line cache
  (`packages/app-core/src/runtime/tts-cache-wiring.ts`).

**On-device stack — already built, already measured on desktop.**
- Kokoro (~82M params) is the **only** on-device TTS backend
  (`plugins/plugin-local-inference/src/services/voice/kokoro/runtime-selection.ts:1-30`;
  OmniVoice retired, #9649/#11106). It ships on all three native surfaces: fused
  `libelizainference` on desktop, in-process fused Kokoro on Android
  (`plugins/plugin-native-talkmode/android/.../TalkModePlugin.kt:1242-1305`,
  `streamAndPlayBionicKokoroTts`), CoreML on iOS
  (`plugins/plugin-native-bun-runtime/ios/Sources/ElizaBunRuntimePlugin/kokoro/KokoroCoreMlEngine.swift`).
  Artifact sizes: q4_k_m GGUF expected ~60 MB, voice packs ~522 KB each
  (`packages/shared/src/local-inference/voice-models.ts:524-537`).
- On-device ASR is fused eliza-1-asr (~1.0 GB) **only**; there is no whisper.cpp fallback
  (`.../voice/transcriber.ts:700,758`). The `.gitmodules` whisper.cpp entry (lines 18-32)
  is stale — the submodule is not checked out and `whisper-cpp-asr.ts` no longer exists.
- Committed measurements (`packages/ui/src/voice/STT_SELECTION.md`): fused ASR WER 0.008
  at RTF 0.262 on desktop CPU; Apple `SFSpeechRecognizer` WER 0 at RTF 0.168; Android
  fused ASR is bring-up-only (31.3 s including model load on Pixel 6a); Android
  `SpeechRecognizer` and Cloud ASR have **no committed measurements**.

**Test/benchmark harnesses that already exist (reuse, don't build).**
- `voice:latency-report` (`packages/app-core/scripts/voice-latency-report.mjs`) renders
  `GET /api/dev/voice-latency` — per-turn checkpoints from "user makes a sound" to
  "agent's first audio plays" with p50/p90/p99
  (`plugins/plugin-local-inference/src/services/latency-trace.ts:1-30`).
- Voice Workbench (`voice:workbench --mock|--logic|--real`, `--baseline` regression gate)
  scores WER, EOT, diarization, and first-audio/TTFT; CI runs the `--logic` lane
  (`.github/workflows/voice-workbench.yml`).
- `voice:matrix` (`packages/scripts/voice-matrix.mjs`) — the per-platform live-cell
  evidence matrix (`packages/ui/src/voice/VOICE_LIVE_MATRIX.md`).
- Nightly real-model lane `.github/workflows/voice-live-e2e.yml` (fused ASR + real Kokoro
  on self-hosted); `kokoro-real-smoke.yml` real-weight loader gate; `voice:duet` /
  `voice:interactive` local-loop harnesses (`packages/app-core/scripts/`).
- Web e2e: `packages/app/test/ui-smoke/voice-realaudio.spec.ts` drives REAL fake-mic audio
  through the real capture path (getUserMedia → WAV → POST → SSE → TTS decode) with
  barge-in — but its ASR/agent/TTS **backends are mocked**; no spec drives the Railway
  cloud path. TTS fail-closed behavior has unit coverage
  (`packages/ui/src/hooks/useVoiceChat.fail-closed.test.tsx`, #12253/#12428), but there is
  no browser-level failure-path spec for mic-denied / silence / network-drop-mid-stream.

**Weak/broken, summarized:** cloud voice has zero latency numbers, zero CI, an
English-only tiny STT model, an unwired client capture default, unreproducible deploys,
and no inline-postable round-trip evidence. On-device voice is measured and gated on
desktop/Linux, partially measured on Apple, unmeasured steady-state on Android.

## Design considerations

- **Do not resurrect Whisper on-device.** The workstream prompt asks whether to ship
  Kokoro + whisper-small onto devices. Kokoro on-device is already shipped everywhere.
  On-device Whisper was deliberately retired (transcriber.ts:758); the on-device ASR
  answers are fused eliza-1-asr (desktop, measured winner) and OS recognizers (mobile,
  free, no download, already the actual TalkMode behavior). Re-adding whisper.cpp would be
  a second ASR runtime for zero MVP benefit.
- **A browser tab has no on-device runtime.** Web needs the servers — that is settled.
  The open question is web *quality/latency*, which only the benchmark can answer.
- **Time-to-audio-start dominates perceived voice quality.** Cloud Kokoro returns a whole
  WAV with no first-line cache; the local path has phrase streaming + first-line caching.
  The benchmark must measure TTFB (first WAV byte) separately from total synthesis.
- **Free-path economics.** The Kokoro/Whisper branches bypass billing entirely — the MVP
  default voice costs nothing per request. ElevenLabs stays opt-in. Any change must keep
  the free branch first.
- **Evidence is inline now.** Round-trip proof is MP4 (renders inline in GitHub) + JPG;
  audio evidence is wrapped in MP4 since bare WAV does not render inline.

## Open questions → answers

**Q1: Cloud (Railway) or on-device for each platform?**
A: Per-platform decision matrix (MVP defaults):

| Platform | STT | TTS | Basis |
|---|---|---|---|
| Web (any runtime mode) | Cloud Whisper via `/api/v1/voice/stt` (wire it — today browser SpeechRecognition) | Cloud Kokoro via `/api/tts/cloud` if TTFB benchmark ≤ ~1.5 s for a short sentence; else keep `edge` | no on-device runtime in a tab; browser STT is engine-dependent and absent on some browsers |
| Desktop, local agent, bundle provisioned | fused eliza-1-asr | local Kokoro | measured: WER 0.008, RTF 0.262 (STT_SELECTION.md) — already the default |
| Desktop, cloud mode / unprovisioned | cloud Whisper (same wiring as web) | cloud Kokoro / edge | same as web |
| iOS | `SFSpeechRecognizer` via TalkMode | on-device Kokoro (CoreML) | measured WER 0 / RTF 0.168; zero download |
| Android | `SpeechRecognizer` via TalkMode | on-device fused Kokoro | already the actual behavior; Stage-B measurement is a follow-up, not an MVP blocker |

**Q2: Should we benchmark Railway vs local, and with what harness?**
A: Yes — it is the only deliverable that can settle web TTS default and validate the
cloud path at all. Reuse, don't build: extend `voice-kokoro-whisper-live.test.ts`'s
request shapes into a small bench run (TTFB, total time, RTF, bytes for 3 phrase lengths;
STT RTT for 3 s/10 s/30 s clips + WER over the existing 12-utterance workbench corpus),
and take local numbers from `voice:latency-report` + the committed STT_SELECTION.md rows.
Dimensions per the owner: model download size, memory, time-to-audio-start,
tokens-to-first-audio (local phrase-streaming path), round-trip latency.

**Q3: Is `faster-whisper-tiny.en` acceptable for the MVP audience?**
A: No as a hardcode. English-only breaks any non-English user silently, and tiny-tier
accuracy on children's/elderly speech is exactly where WER degrades. Make the model a
deploy-time env (`WHISPER_STT_MODEL`), benchmark tiny vs small on the corpus (the Railway
box's CPU budget decides), and drop the `.en` variant if any non-English locale is in
scope. Default recommendation pending benchmark: `Systran/faster-whisper-small`.

**Q4: Should web interactive capture post audio to cloud STT, or keep browser
SpeechRecognition?**
A: Wire `eliza-cloud` ASR for real. The WAV recorder already exists
(`startLocalAsrRecorder`, used by the local-inference path); posting the same WAV to the
cloud STT route (via the agent proxy) is a small change that makes web STT deterministic,
testable, and consistent with the documented default. Keep browser SpeechRecognition as
the interim-transcript enhancer where available, cloud WAV transcription as the final —
that mirrors what mobile TalkMode already does (OS interim + final).

**Q5: Does cloud Kokoro need streaming/caching work?**
A: Only if the benchmark says so. If short-sentence TTFB is already ≤ ~1.5 s, ship as-is.
If not, the cheapest lever is extending the existing first-line cache (it is already
provider-keyed; `packages/cloud/shared/src/lib/services/tts-first-line-cache*`) to the
Kokoro branch — not building WAV streaming. Genuinely undecidable before the numbers
exist; default: measure first, cache second, stream never (for MVP).

**Q6: Who owns keeping the Railway services alive?**
A: Nobody, today — that is the problem. The service definitions must live in-repo
(Dockerfile + railway config or a pinned deploy doc next to
`packages/cloud/infra/cloud/RAILWAY.md`, which currently doesn't mention voice at all)
and the live contract test needs a scheduled lane so a dead service pages as a red run,
not as a user report.

## Recommendation (minimal-scope MVP plan, ordered)

1. **Benchmark and publish** (P0): run the cloud-vs-local matrix (Q2) once, on real
   services and one real desktop; post the table + artifacts inline in the issue; record
   the web-TTS default decision (cloud Kokoro vs edge) in this doc.
2. **Bidirectional voice e2e with real audio** (P0): one lane that proves mic-audio →
   STT → live agent → TTS → audible reply on (a) web against the Railway path and (b) the
   desktop local path — MP4 with audio posted inline; plus the failure paths: mic denied,
   silence, network drop mid-TTS-stream.
3. **Wire web `eliza-cloud` ASR** (P1): capture WAV → cloud STT route; browser
   SpeechRecognition demoted to interim-only enhancement.
4. **Un-hardcode the Whisper model** (P1): `WHISPER_STT_MODEL` env, benchmark-informed
   default, delete the misleading `gpt-5-mini-transcribe` log on this path.
5. **Make the Railway services first-class** (P1): in-repo service definitions + the live
   contract test on a scheduled workflow.
6. **Kokoro TTFB mitigation** (P2, conditional on #1): first-line cache for the Kokoro
   branch only if measured TTFB exceeds threshold.
7. **Hygiene** (P2): remove the stale whisper.cpp `.gitmodules` entry; align the
   `voice-provider-defaults.ts` / capture-factory doc drift (mobile ASR reads
   `eliza-cloud` but runs TalkMode).

## Out of scope (explicit non-goals for MVP)

- On-device Whisper (any platform) — retired, stays retired.
- New TTS voices/voice cloning, ElevenLabs work beyond keeping the opt-in path intact.
- WAV/opus streaming synthesis on the cloud Kokoro service.
- Android Stage-B on-device ASR benchmarking (tracked in VOICE_LIVE_MATRIX.md; not an MVP
  gate since Android interactive STT is the OS recognizer).
- Wake-word, diarization, speaker-imprint changes — the workbench already gates these.
- Any new bespoke voice test harness — everything routes through the existing workbench /
  matrix / latency-report / Playwright lanes.

## Proposed issues

1. [voice] Benchmark Railway cloud voice vs on-device: TTFB, RTT, WER, sizes — publish decision table (P0)
2. [voice] Bidirectional voice e2e with real audio round-trip on web (Railway path) + desktop (local path), incl. failure paths (P0)
3. [voice] Wire web `eliza-cloud` ASR to actually POST audio to cloud STT (today it silently falls back to browser SpeechRecognition) (P1)
4. [voice] Cloud STT model is hardcoded English-only `faster-whisper-tiny.en` — make it deploy-configurable, fix the misleading model log (P1)
5. [voice] Railway Kokoro/Whisper services: in-repo service definitions + scheduled live contract lane (P1)
6. [voice] Cloud Kokoro time-to-audio-start: extend first-line cache to the Kokoro branch (conditional on benchmark) (P2)
7. [voice] Voice hygiene: remove stale whisper.cpp submodule entry; fix provider-defaults vs capture-factory doc drift (P2)

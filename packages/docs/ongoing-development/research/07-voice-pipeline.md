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
architecture is right — on-device Kokoro TTS + fused ASR / OS recognizers where a native
runtime exists, Railway-backed cloud voice for web and unprovisioned devices — and the
live benchmark now supports making Eliza Cloud Kokoro the web/cloud/remote TTS default.**
The model hardcode, web-ASR wiring, Railway service-definition gaps, and default-provider
drift are addressed in code; remaining MVP proof lives in the browser-level real-audio
round trip and Railway owner deploy evidence, not in a new voice architecture.

## Current state

What exists today, verified in code.

**Cloud voice = Railway Kokoro + Railway Whisper behind the Cloud API (free path).**
- `packages/cloud/api/v1/voice/tts/route.ts:164-198` — when `KOKORO_TTS_URL` is set, the
  cloud TTS route POSTs `{text, voice, speed}` to `<url>/api/tts` and streams the WAV back
  with **no credit reservation and no billing** ("free default voice"). Voice ids are
  allowlisted to 11 Kokoro presets defaulting to `af_heart` (`route.ts:96-111`).
  ElevenLabs remains the opt-in/custom-voice path below it.
- `packages/cloud/api/v1/voice/stt/route.ts:188-219` — when `WHISPER_STT_URL` is set, STT
  posts multipart audio to `<url>/v1/audio/transcriptions`, free. The model now resolves
  through `resolveWhisperSttModel(env.WHISPER_STT_MODEL)` with
  `Systran/faster-whisper-small` as the default
  (`packages/cloud/api/v1/voice/stt/whisper-model.ts`), so deployments can pin a
  different Speaches-hosted model without changing code.
- Env vars are typed in `packages/cloud/shared/src/types/cloud-worker-env.ts:44,50` but
  are **not** in `wrangler.toml` — they are deploy-time Worker config. The committed
  Railway service definitions live under
  `packages/cloud/services/voice-kokoro-tts/` and
  `packages/cloud/services/voice-whisper-stt/` (Dockerfile + `railway.toml` + README), and
  the topology is recorded in `packages/cloud/infra/cloud/RAILWAY.md`. The current
  blocking evidence is not code shape; it is the owner deploy proof from those committed
  definitions.
- The live round-trip contract test (`voice-kokoro-whisper-live.test.ts`) drives the exact
  request shapes the routes use (Kokoro WAV out → Whisper transcript back, asserts salient
  words). It is now referenced by the scheduled/dispatchable `voice-railway-contract` job
  in `.github/workflows/voice-live-e2e.yml`, still gated on
  `ELIZA_VOICE_LIVE_RAILWAY=1` so a real Railway outage is observable rather than silently
  skipped.

**Who consumes the cloud voice routes.**
- Server-side agent handlers: `plugins/plugin-elizacloud/src/models/speech.ts` posts to
  `/api/v1/voice/tts`; `transcription.ts:145-149` posts to `/api/v1/voice/stt`. The
  Whisper model is owned by the Cloud route's `WHISPER_STT_MODEL`, not by an OpenAI-style
  transcription model name in the client log path.
- The app's TTS proxy: `POST /api/tts/cloud` (`packages/app-core/src/api/route-auth-policy.ts:166`,
  handler in `plugins/plugin-elizacloud/src/lib/server-cloud-tts.ts`) forwards to
  `<cloud-base>/voice/tts` (`packages/shared/src/elizacloud/server-cloud-tts.ts:201-209`).
  The chat voice hook tries this first, then falls back to the ElevenLabs proxy
  (`packages/ui/src/hooks/useVoiceChat.ts:1221-1301`).
- The Kokoro branch owns a provider-keyed first-line cache helper
  (`packages/cloud/api/v1/voice/tts/kokoro-first-line-cache.ts`), gated by
  `KOKORO_FIRST_LINE_CACHE`; uncached text still streams directly from Railway so long
  responses preserve time-to-first-byte.

**Client provider defaults vs what actually runs.**
- The documented matrix (`packages/ui/src/voice/voice-provider-defaults.ts`):
  desktop-local → TTS+ASR `local-inference`; mobile-local → TTS `local-inference`
  (on-device Kokoro), ASR `eliza-cloud`; web/cloud/remote → TTS `eliza-cloud`, ASR
  `eliza-cloud`. Edge remains an explicit browser-voice override, not the default.
- Web/desktop `eliza-cloud` ASR now records WAV and posts to the cloud STT proxy
  (`/api/asr/cloud` → Cloud `/voice/stt`) instead of resolving straight to browser
  `SpeechRecognition`; browser recognition remains a fallback when WAV capture is not
  available. Native mobile interactive capture still prefers the TalkMode OS recognizer,
  which is the measured zero-download path for iOS and the practical Android path until
  Stage-B hardware measurements land.
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
- Voice Workbench (`voice:workbench --mock|--logic|--real`) records WER, EOT,
  diarization, and first-audio/TTFT telemetry; CI runs the deterministic
  `--logic` lane and uploads its report (`.github/workflows/voice-workbench.yml`).
- `voice:matrix` (`packages/scripts/voice-matrix.mjs`) — the per-platform live-cell
  evidence matrix (`packages/ui/src/voice/VOICE_LIVE_MATRIX.md`).
- `voice:cloud-bench` (`packages/scripts/voice-cloud-bench.mjs`) — the #14370 Railway
  benchmark runner added for this decision record. It reuses the live contract request
  shapes, measures Kokoro TTFB/total/RTF/bytes, measures Whisper RTT for short/medium/long
  clips, scores `tiny.en` vs `small` WER over a fixed 12-utterance workbench slice, and
  writes JSON + Markdown tables. It intentionally fails unless
  `ELIZA_VOICE_LIVE_RAILWAY=1` is set; no benchmark skip can look green.
- Nightly real-model lane `.github/workflows/voice-live-e2e.yml` (fused ASR + real Kokoro
  on self-hosted); `kokoro-real-smoke.yml` real-weight loader gate; `voice:duet` /
  `voice:interactive` local-loop harnesses (`packages/app-core/scripts/`).
- Web e2e: `packages/app/test/ui-smoke/voice-realaudio.spec.ts` drives REAL fake-mic audio
  through the real capture path (getUserMedia → WAV → POST → SSE → TTS decode) with
  barge-in — but its ASR/agent/TTS **backends are mocked**; no spec drives the Railway
  cloud path. TTS fail-closed behavior has unit coverage
  (`packages/ui/src/hooks/useVoiceChat.fail-closed.test.tsx`, #12253/#12428), but there is
  no browser-level failure-path spec for mic-denied / silence / network-drop-mid-stream.

**Weak/broken, summarized:** cloud voice now has a committed benchmark table and default
decision, but still needs posted audible MP4 round-trip evidence and owner proof that the
scheduled Railway lane passes against freshly deployed services. On-device voice is
measured and gated on desktop/Linux, partially measured on Apple, and unmeasured
steady-state on Android.

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
  WAV; the provider-keyed first-line cache handles only short whole-input openers when
  enabled. The benchmark must measure TTFB (first WAV byte) separately from total
  synthesis.
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
| Web (any runtime mode) | Cloud Whisper via `/api/v1/voice/stt` | Cloud Kokoro via `/api/tts/cloud` | no on-device runtime in a tab; #14370 measured warmed short-ack TTFB well below the ~1.5 s threshold and exposed a cold-start outlier to monitor |
| Desktop, local agent, bundle provisioned | fused eliza-1-asr | local Kokoro | measured: WER 0.008, RTF 0.262 (STT_SELECTION.md) — already the default |
| Desktop, cloud mode / unprovisioned | cloud Whisper (same wiring as web) | Cloud Kokoro via `/api/tts/cloud` | same as web; Edge remains an explicit override |
| iOS | `SFSpeechRecognizer` via TalkMode | on-device Kokoro (CoreML) | measured WER 0 / RTF 0.168; zero download |
| Android | `SpeechRecognizer` via TalkMode | on-device fused Kokoro | already the actual behavior; Stage-B measurement is a follow-up, not an MVP blocker |

**Q2: Should we benchmark Railway vs local, and with what harness?**
A: Yes — and the first #14370 live run settled the web/cloud default. `bun run
voice:cloud-bench` is the committed runner for this: it uses the same live
Kokoro/Whisper request shapes as `voice-kokoro-whisper-live.test.ts`, writes JSON +
Markdown, and fails closed without `ELIZA_VOICE_LIVE_RAILWAY=1`.

Command:

```bash
ELIZA_VOICE_LIVE_RAILWAY=1 \
KOKORO_TTS_URL=https://<kokoro-service> \
WHISPER_STT_URL=https://<whisper-service> \
bun run voice:cloud-bench -- --out /tmp/voice-cloud-bench
```

Live run: `2026-07-06T01:58:02.878Z` against
`kokoro-tts-production-aa4b.up.railway.app` and
`whisper-stt-production-6fc7.up.railway.app`.

Cloud TTS:

| Case | Runs | p50 TTFB ms | p90 TTFB ms | p50 total ms | p90 total ms | p50 RTF | p50 bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| short ack | 5 | 339 | 1990 | 368 | 2021 | 0.202 | 87644 |
| one sentence | 5 | 398 | 440 | 502 | 535 | 0.108 | 222044 |
| three sentences | 5 | 749 | 848 | 994 | 1092 | 0.099 | 482444 |

The short-ack p90 includes the first cold request in this run (TTFB 1990 ms). The
subsequent four short-ack TTFB samples were 355, 339, 279, and 277 ms, so the steady-state
voice path is well under the target. Keep this outlier visible: the scheduled live lane
and first-line cache/warmup policy must prevent a cold service from becoming an invisible
MVP regression.

Cloud STT RTT:

| Clip | Actual sec | Model | Runs | p50 RTT ms | p90 RTT ms |
|---|---:|---|---:|---:|---:|
| clip_3s | 3.33 | `Systran/faster-whisper-tiny.en` | 5 | 589 | 886 |
| clip_3s | 3.33 | `Systran/faster-whisper-small` | 5 | 1755 | 2310 |
| clip_10s | 8.10 | `Systran/faster-whisper-tiny.en` | 5 | 711 | 757 |
| clip_10s | 8.10 | `Systran/faster-whisper-small` | 5 | 2059 | 2185 |
| clip_30s | 15.88 | `Systran/faster-whisper-tiny.en` | 5 | 893 | 1033 |
| clip_30s | 15.88 | `Systran/faster-whisper-small` | 5 | 2688 | 2906 |

Cloud STT WER:

| Model | Utterances | Mean WER | Median WER | p90 WER | Mean RTT ms |
|---|---:|---:|---:|---:|---:|
| `Systran/faster-whisper-tiny.en` | 12 | 0.076 | 0.000 | 0.200 | 638 |
| `Systran/faster-whisper-small` | 12 | 0.038 | 0.000 | 0.143 | 1690 |

Committed local comparison rows:

| Backend | Device | Corpus | WER | RTF | Source |
|---|---|---|---:|---:|---|
| fused eliza-1-asr | Linux x86-64 CPU | 12 Kokoro utterances, 55.5 s | 0.008 | 0.262 | `packages/ui/src/voice/STT_SELECTION.md` |
| `SFSpeechRecognizer` | Apple silicon | 5 labelled utterances, quiet | 0.000 | 0.168 | `packages/ui/src/voice/STT_SELECTION.md` |

Download sizes:

| Artifact | Size | Source |
|---|---:|---|
| Kokoro q4_k_m GGUF | 60.0 MB | `packages/shared/src/local-inference/voice-models.ts` |
| Kokoro voice bin | 522.2 KB | `packages/shared/src/local-inference/voice-models.ts` |
| fused eliza-1-asr bundle | 1.00 GB | `packages/ui/src/voice/STT_SELECTION.md` |

The runner also writes representative WAV artifacts under `<out>/audio/`; use
`audio/tts-short_ack-run-1.wav` (or any saved source clip) for the inline MP4 proof.

Default decision: `pickDefaultVoiceProvider` now selects `eliza-cloud` TTS for web,
cloud, and remote runtime modes. The fresh run's cold first short-ack request exceeded
the threshold (1990 ms), but the steady-state short acknowledgements were 277-355 ms and
cloud Kokoro is the only default that translates cleanly from web chat to
Discord/Telegram/iMessage-style server-side replies. `edge` stays available as an
explicit browser-voice override.

**Q3: Is `faster-whisper-tiny.en` acceptable for the MVP audience?**
A: No as a hardcode. English-only breaks any non-English user silently, and tiny-tier
accuracy on children's/elderly speech is exactly where WER degrades. The hardcode is
removed: `WHISPER_STT_MODEL` controls the deployed model and the default is
`Systran/faster-whisper-small`. The remaining proof is to benchmark tiny vs small on the
same corpus so the default has numbers instead of a rationale-only recommendation.

**Q4: Should web interactive capture post audio to cloud STT, or keep browser
SpeechRecognition?**
A: Yes, and that wiring is now in place for the web/desktop capture layer: `eliza-cloud`
ASR records WAV and posts it to the cloud STT route through the app proxy. Browser
SpeechRecognition is fallback-only when WAV capture is unavailable. The remaining #14371
work is a browser-level live Railway + live-agent round trip, including failure paths.

**Q5: Does cloud Kokoro need streaming/caching work?**
A: No streaming work for MVP. The measured warmed short-ack TTFB is already under the
~1.5 s threshold, and the fresh run makes the cold-start case observable instead of
hidden. The Kokoro first-line cache is available behind `KOKORO_FIRST_LINE_CACHE` for
short whole-input openers; use it or a scheduled warmup if the live lane keeps seeing
cold-start p90 above target.

**Q6: Who owns keeping the Railway services alive?**
A: The definitions and lane now live in-repo, but the operational proof is still missing.
Before #14374 is done, attach fresh `railway up` logs for both committed service dirs, the
repo variable values used by the lane, one green `voice-railway-contract` run, and one
intentionally-red bogus-URL dispatch proving a dead service fails loudly.

## Recommendation (minimal-scope MVP plan, ordered)

1. **Benchmark and publish** (P0): done for the #14370 decision table above. Keep the raw
   JSON/Markdown and audible proof inline in the PR/issue, and rerun if Railway service
   images or model tiers change.
2. **Bidirectional voice e2e with real audio** (P0): one lane that proves mic-audio →
   STT → live agent → TTS → audible reply on (a) web against the Railway path and (b) the
   desktop local path — MP4 with audio posted inline; plus the failure paths: mic denied,
   silence, network drop mid-TTS-stream.
3. **Wire web `eliza-cloud` ASR** (P1): done in code; closeout evidence belongs with the
   browser-level #14371 round trip.
4. **Un-hardcode the Whisper model** (P1): done in code; #14373 still needs live
   non-English Railway proof/logs before human closeout.
5. **Make the Railway services first-class** (P1): code/docs/workflow landed; #14374 still
   needs owner deploy proof and green/red scheduled-lane evidence.
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
3. [voice] Wire web `eliza-cloud` ASR to actually POST audio to cloud STT (code landed; live round-trip evidence pending) (P1)
4. [voice] Cloud STT model is deploy-configurable; prove multilingual Railway behavior and logs (P1)
5. [voice] Railway Kokoro/Whisper services: in-repo service definitions + scheduled live contract lane (code landed; owner deploy proof pending) (P1)
6. [voice] Cloud Kokoro time-to-audio-start: extend first-line cache to the Kokoro branch (conditional on benchmark) (P2)
7. [voice] Voice hygiene: remove stale whisper.cpp submodule entry; fix provider-defaults vs capture-factory doc drift (P2)

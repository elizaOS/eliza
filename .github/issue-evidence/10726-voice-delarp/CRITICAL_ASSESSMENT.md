# Voice stack LARP audit — #10726 critical assessment

Skeptical staff-engineer review of the elizaOS voice test + source surface.
Every classification below is grounded in the actual file I read this session
(paths + line evidence inline). I read: all 11 `voice-workbench-*.spec.ts`,
`voice-workbench-cases.ts`, `voice-realaudio.spec.ts`, `transcript-realaudio.spec.ts`,
`voice-selftest-e2e.spec.ts`, `voice-desktop-selftest.spec.ts`, `tts-stt-e2e.spec.ts`;
the source: `voice-selftest/voice-workbench-player.ts`, `voice-selftest-harness.ts`,
`VoiceWorkbenchShell.tsx`, `local-asr-transcribe.ts`, `local-asr-capture.ts`,
`voice-provider-defaults.ts`, `@elizaos/shared/voice-wer.ts`; the real-service tier:
`scripts/voice-workbench.ts`, `workbench-real-services.ts`, `workbench-logic-services.ts`,
`acoustic-speaker-attribution.test.ts` + `__test-helpers__/synthetic-speech.ts`,
`voice-speaker-diarizer.test.ts`, `voice-speaker-encoder.test.ts`; the CI wiring:
`playwright.ui-smoke.config.ts`, `voice-workbench.yml`, `voice-live-e2e.yml`; and the
matrix doc `VOICE_LIVE_MATRIX.md`.

---

## A. Critical Assessment — what is wrong, why, and the risk

### The central finding: the voice stack is NOT uniformly larp — it is a three-tier pyramid, and the browser e2e tier (the one that "looks" like the real integration test) is the larp-heavy tier.

There are **three distinct test tiers** for the same voice pipeline, and they are
easy to conflate because they share names and vocabulary ("workbench", "self-test",
"scenario"):

1. **Browser e2e tier** (`packages/app/test/ui-smoke/*.spec.ts`, Playwright).
   Drives the **real client pipeline** (real `runVoiceSelfTest` / `runVoiceWorkbench`
   production functions, real WAV capture in the mic lane) but **mocks every model
   backend**: `/api/asr/local-inference`, `/api/conversations/.../messages/stream`,
   and `/api/tts/*` are all Playwright `page.route` fulfillments returning canned
   payloads. This is where the larp is.

2. **Headless real-decision tier** (`plugins/plugin-local-inference/src/services/voice/`,
   Vitest, CI-gated on PRs via `voice-workbench.yml`). `voice:workbench --logic`
   runs the **actual shipped decision modules** (`scoreEndOfTurnHeuristic`,
   `buildVoiceTurnSignal`, `OnlineSpeakerClusterer` blind clustering, `selfVoiceSimilarity`)
   against synthesized speech, with a committed regression **baseline** that fails CI
   on drift. `acoustic-speaker-attribution.test.ts` proves the DER gate is
   non-tautological (label comes from audio, gate trips on genuine misattribution).
   This tier is genuinely REAL for decision logic — no larp.

3. **Provisioned acoustic tier** (`*.real.test.ts`, `voice:workbench --real`,
   `voice-live-e2e.yml`, `voice:matrix`). Real fused `libelizainference` ASR + Kokoro
   TTS + WeSpeaker + pyannote. Nightly / self-hosted-GPU / hardware-gated. Correctly
   `skipped` (never false-`pass`) when the model bundle/ABI is absent. Cannot run in a
   keyless coding session; the honesty contract here is sound.

**The risk**: a reader who only looks at `packages/app/test/ui-smoke/` — the tests
named "voice-realaudio", "voice-selftest", "voice-workbench-diarization",
"voice-workbench-entity-extraction" — will believe the voice models are being tested.
They are not. Every one of those specs asserts against a **canned ASR transcript** and
a **canned agent reply** that the spec itself wrote into a `page.route` handler. The
"WER ≤ 0.34" assertion in the self-test is scored against a transcript the mock
returned verbatim, so WER is structurally 0.0 — it can never catch an ASR quality
regression. The word "REAL-AUDIO" in the file headers is accurate only for the
*audio-in + WAV-encode + POST* half; the ASR/agent/TTS half is mocked, and the file
headers do say so — but the test *names* and the DOM `data-overall="pass"` verdicts
overstate what is proven.

### Specific structural larp patterns found

1. **Canned-transcript WER (self-test + workbench e2e).** In
   `voice-selftest-e2e.spec.ts` the ASR mock returns the exact `EXPECTED_PHRASE`
   (`"what time is it"`), then `runVoiceSelfTest` scores `wordErrorRate(expectedPhrase, transcript)`
   → always 0.0. The WER gate is real code (`@elizaos/shared/voice-wer.ts` is a real
   Levenshtein) but the *input* is the ground truth, so the assertion is a tautology in
   the browser lane. Same in `voice-workbench-cases.ts` (`asrCursor` walks the turns and
   returns `turn.asrText ?? turn.text`).

2. **Diarization is structurally impossible to pass in the browser lane, and the spec
   asserts exactly that.** `VoiceWorkbenchShell.tsx` (line 105-130) calls
   `runVoiceWorkbench` **without** `resolvePredictedSpeakerLabel`. Per
   `voice-workbench-player.ts` `scoreWorkbenchDiarization`, no predicted label ⇒
   `unattributed` ⇒ `evaluated=false` ⇒ `status="skipped"`. `voice-workbench-cases.ts`
   then *asserts* `diarization.status === "skipped"` and `predictedSpeakerLabel === null`
   for every scenario. So the two "diarization" and "multi-speaker" browser specs prove
   the **absence** of a diarizer, dressed up with speaker labels in the scenario. This is
   honest (it reports skipped, not fake-pass) but it is **not diarization coverage** — the
   real diarization coverage is entirely in tier 2/3.

3. **Entity-extraction is not tested at all in the browser lane.**
   `voice-workbench-entity-extraction.spec.ts` sets `expectedEntity: "jordan"` /
   `"priya"`, but the player (`voice-workbench-player.ts` line 428) only copies
   `expectedEntity` into `detail.expectedEntity` "for the benchmark layer to score" —
   **nothing asserts the agent extracted the entity**. The agent reply is the mock's
   `"reply to owner"` string. There is zero entity-extraction assertion. The spec passes
   by scoring the respond-decision + a WER of 0 on the mocked transcript. Pure larp with
   respect to its stated purpose.

4. **voice-recognition (voice→entity) is not tested in the browser lane either.**
   `voice-workbench-voice-recognition.spec.ts` declares `entityId` per participant, but
   the player carries `expectedSpeakerLabel` only and the case file asserts
   `predictedSpeakerLabel === null` + `speakerAttributionRan === false`. There is no
   voice-enrollment, no speaker match, no entity resolution. It is a respond-decision
   test wearing a voice-recognition costume.

5. **Noise rejection / speaker isolation has NO browser-lane coverage at all.** There is
   no `voice-workbench-noise.spec.ts` (the task brief lists "noise" among the 11 but the
   filesystem has 11 workbench specs and none is noise/overlap; the acoustic classes live
   in tier 2/3 via `corpus-augment.ts` + the `--real` matrix). All noise/reverb/overlap/
   echo handling is exercised only by the synthetic-speech DSP tier-2 tests and the
   provisioned tier-3 matrix. The browser e2e feeds a clean 220 Hz sine `tinyWav()` (or
   the single clean `known-phrase.wav`) — never noisy or overlapping audio.

6. **`tts-stt-e2e.spec.ts` STT is a hand-written shim.** It installs a fake
   `window.webkitSpeechRecognition` and a `__sttSimulate()` global; the "STT" it tests is
   its own shim echoing the string back. It proves the *composer wiring* (mic button →
   `startListening` → interim transcript renders), which is legitimate wiring coverage,
   but it is not STT and the file header honestly says so.

7. **The strongest browser-lane test is real only on the audio-in half.**
   `voice-realaudio.spec.ts` genuinely runs Chromium `--use-file-for-fake-audio-capture`
   → real `getUserMedia` → real `startLocalAsrRecorder` (real `ScriptProcessor` PCM
   capture + `encodeMonoPcm16Wav`) → real base64 POST. The barge-in test even patches
   `AudioContext.createBufferSource` to prove the in-flight TTS source is disconnected on
   START_TRANSCRIPTION. That capture/barge-in machinery is real and valuable. But the ASR
   response is still `bytes > 1000 ? EXPECTED_PHRASE : ""` — a byte-count gate, not
   transcription. So it proves "we captured >1 KB of real audio and POSTed it," not "the
   model transcribed it."

### Why this accumulated

The keyless PR lane genuinely cannot run the fused models (no GPU, no `libelizainference`,
no bundles). The team's response — a real-decision tier-2 + a provisioned tier-3 with a
strict honesty contract (`skipped` never `pass`) — is architecturally correct. The debt is
that the **browser e2e tier was allowed to carry model-quality-sounding names and
assertions** (WER, diarization, entity-extraction, voice-recognition) while only proving
client wiring. The names write checks the mocks can't cash.

---

## B. Every voice test, classified

Legend: **REAL** = drives the actual audio/ASR/TTS/decision path under test.
**LARP** = asserts against a mock/shim standing in for the thing the test name claims.
**PARTIAL** = real for one half of the pipeline (usually client wiring / audio-in),
mocked for the model half.

### Browser e2e tier — `packages/app/test/ui-smoke/`

| Test file | Class | Verdict | Evidence (what is mocked) |
|---|---|---|---|
| `voice-realaudio.spec.ts` — mic-capture round-trip | capture | **PARTIAL** | Real fake-mic audio-in + real WAV capture/POST; ASR returns `EXPECTED_PHRASE` on `bytes>1000`, agent SSE + TTS mocked. Proves capture, not transcription. |
| `voice-realaudio.spec.ts` — barge-in during TTS | barge-in | **PARTIAL** (best in tier) | Real audio-in, real 2nd WAV drain, real `AudioContext` source disconnect probe. Genuinely proves barge-in silences playback. Backends still mocked. |
| `transcript-realaudio.spec.ts` (test 1: real-audio + linkage) | transcription | **PARTIAL** | Real capture → real `/api/transcripts` POST body; transcript/media/knowledge backends mocked; `segmentCount>0` comes from real client session accumulation, transcript text is canned. |
| `transcript-realaudio.spec.ts` (test 2: viewer/actions) | transcription-UI | **PARTIAL** | Real UI-flow coverage of viewer/player/attachment; audio is real, all persisted data is mock echo. |
| `voice-selftest-e2e.spec.ts` | round-trip | **LARP** (as ASR quality) / PARTIAL (as wiring) | ASR mock returns `EXPECTED_PHRASE` verbatim → WER structurally 0.0; SSE + TTS mocked. Real client round-trip wiring, zero model quality. |
| `voice-desktop-selftest.spec.ts` | round-trip (desktop cfg) | **LARP** (as ASR) / PARTIAL (as config) | Same mocks as above; the *real* thing proven is platform=desktop → `/api/tts/local-inference` route selection. That config assertion is real. |
| `voice-workbench-diarization.spec.ts` | diarization | **LARP** | No diarizer provided; asserts `diarization.status==="skipped"`, `predictedSpeakerLabel===null`. Proves absence of a diarizer, not diarization. |
| `voice-workbench-multi-speaker.spec.ts` | multi-speaker | **LARP** | Same mock lane; only respond-decision + canned-WER scored; no speaker separation. |
| `voice-workbench-multi-voice.spec.ts` | multi-voice | **LARP** | `ttsVoiceId` declared but TTS is one shared `tinyWav()`; no voice distinction asserted. |
| `voice-workbench-voice-recognition.spec.ts` | voice→entity | **LARP** | `entityId` declared, but `speakerAttributionRan===false` asserted; no enrollment/match/resolution. |
| `voice-workbench-entity-extraction.spec.ts` | entity-from-voice | **LARP** | `expectedEntity` only copied into report detail; **no assertion the agent extracted it**; agent reply is a canned string. |
| `voice-workbench-transcription-mode.spec.ts` | dictation WER | **LARP** (as WER) | `expectedTranscript` == mocked ASR text → WER 0.0. Proves dictation *plumbing*, not accuracy. |
| `voice-workbench-eot.spec.ts` | end-of-turn | **LARP** | EOT decision is encoded in `expectRespond` + the mock's per-turn respond/no-respond; the real EOT heuristic is never invoked in this lane. |
| `voice-workbench-respond-no-respond.spec.ts` | chime-in gate | **LARP** | Respond decision comes from the mock's per-turn cursor, not the shipped respond-gate; real gate lives in tier 2. |
| `voice-workbench-pauses.spec.ts` | pauses/timing | **LARP** | Injects `pausesMs` sleeps; asserts turns still respond via mock. No timing behavior verified against a real detector. |
| `voice-workbench-multi-agent-room.spec.ts` | multi-agent routing | **LARP** | Addressing decision from mock cursor; no real router. |
| `tts-stt-e2e.spec.ts` — provider matrix | selection | **REAL** | Imports and asserts the real `pickDefaultVoiceProvider` pure function. Genuine. |
| `tts-stt-e2e.spec.ts` — SSE token+done | wire format | **REAL** (of the fixture contract) | Asserts the live-stack fixture SSE shape; real transport contract, fixture reply. |
| `tts-stt-e2e.spec.ts` — TTS cloud payload | wire format | **PARTIAL** | Real renderer→endpoint payload shape asserted; TTS handler mocked (returns tiny mp3). |
| `tts-stt-e2e.spec.ts` — STT capture path (×2, incl. always-on) | STT wiring | **LARP** (as STT) / PARTIAL (as wiring) | `webkitSpeechRecognition` is a hand-written shim; `__sttSimulate` echoes the string. Proves composer wiring, not recognition. |

### UI unit/source tier — `packages/ui/src/voice/`

These are real unit tests of real pure logic (not larp), listed for completeness — they
test what they claim (VAD auto-stop math, WAV codec, wake-name matching, EOT scorer,
turn-signal gate, transcript session, capture factory). Notable REAL ones:
`voice-capture-factory.test.ts`, `local-asr-capture.test.ts`, `end-of-turn.test.ts`,
`should-respond.test.ts`, `voice-turn-signal.test.ts`, `wake-name-match.test.ts`,
`wake-controller.test.ts`/`.fuzz`, `voice-provider-defaults.test.ts`. Verdict for the
group: **REAL** (pure-logic units; no model claim to falsify).

### Headless decision tier — `plugins/plugin-local-inference/src/services/voice/` (Vitest, PR-gated)

| Test / lane | Verdict | Evidence |
|---|---|---|
| `voice:workbench --logic` (CI PR lane, w/ regression baseline) | **REAL** (decision logic) | Runs shipped `scoreEndOfTurnHeuristic`, `buildVoiceTurnSignal`, `OnlineSpeakerClusterer`, `selfVoiceSimilarity`; committed baseline fails CI on drift. No models, but no ground-truth echo. |
| `acoustic-speaker-attribution.test.ts` | **REAL** | Blind clusters synthetic-speech clips by timbre; DER scorer trips on genuine misattribution; same-voice cos-sim >0.9, cross-voice low. Non-tautological. |
| `voice-speaker-diarizer.test.ts` | **REAL** (reducer) | Golden cases for `classifyFramesToSegments` powerset reducer + pyannote constants. Real FFI coverage deferred to `diarizer-fused.real.test.ts`. |
| `voice-speaker-encoder.test.ts` | **REAL** (constants + centroid) | WeSpeaker dims/sample-rate/model-ids + `averageEmbeddings`. Real FFI in `encoder-fused.real.test.ts`. |
| `voice:workbench --mock` (CI plumbing) | **LARP by design** (honest) | Ground-truth echo; explicitly the runner→scorer→report plumbing lane, not a quality claim. |

### Provisioned acoustic tier — hardware-gated (nightly / self-hosted / `--real`)

| Lane | Verdict | Evidence |
|---|---|---|
| `*.real.test.ts` (asr-timed / diarizer-fused / encoder-fused / kokoro-engine-bridge) | **REAL** (gated) | Real fused `libelizainference` ABI; skipped without a built lib. |
| `voice:workbench --real` + `voice-live-e2e.yml` + `voice:matrix` | **REAL** (gated) | Real fused ASR + Kokoro TTS + WeSpeaker + pyannote + optional ElevenLabs; `--require-green` turns skip into failure on opted-in hardware. |

**Tallies (browser e2e tier — the tier #10726 is really about):**
20 discrete browser-lane test cases → **REAL: 2** (provider matrix, SSE wire), **PARTIAL: 5**
(both realaudio, both transcript-realaudio, TTS-cloud payload), **LARP: 13** (both selftests,
all 10 workbench specs, the STT-shim cases).

Counting the strongest interpretation of each *file* (rather than each case), and folding in
the genuinely-real decision/acoustic tiers as context: the browser e2e surface is
**~65% LARP / ~25% PARTIAL / ~10% REAL** for what its names claim.

---

## C. Recommendations, ranked

### HIGH confidence — achievable in a coding session (no hardware)

1. **Stop the browser workbench specs from claiming model classes they don't test.**
   The diarization/multi-speaker/multi-voice/voice-recognition/entity-extraction/eot/
   respond-no-respond browser specs are LARP relative to their names. Two options, both
   session-doable:
   (a) **Rename + re-scope** them to what they prove ("respond-decision plumbing over a
   mocked backend") and move the class name to the tier-2 `--logic` suite, OR
   (b) **Delete the redundant browser specs** and keep the tier-2 `workbench-logic-services`
   + `acoustic-speaker-attribution` tests as the canonical class coverage. The browser lane
   should keep only what needs a browser (capture, barge-in, transcript UI, provider matrix,
   SSE wire). This removes the misleading `data-overall="pass"` diarization/entity verdicts.

2. **Add a real entity-extraction assertion to tier 2 (or a `--logic` scenario), since the
   browser one asserts nothing.** The entity-extraction scenario currently only stashes
   `expectedEntity` in report detail. Wire the shipped name-extraction path
   (`workbench-logic-services.ts` already has inline patterns mirroring `IDENTIFY_SPEAKER`)
   into a scored assertion with a regression baseline. Session-doable — no model needed,
   the extraction is regex/heuristic in the logic tier.

3. **Make the self-test WER non-tautological in at least one CI-runnable lane.** Feed the
   ASR mock a *degraded* transcript (dropped/substituted words) in a dedicated spec and
   assert the WER gate actually *fails* at the boundary (e.g. WER 0.5 must fail the ≤0.34
   gate). Right now nothing proves the WER gate rejects bad ASR — only that it accepts
   perfect ASR. This is a session-doable negative test that gives the gate teeth.

4. **Add synthetic-noise mixing to the tier-2 acoustic tests (the "noise rejection" gap).**
   `synthetic-speech.ts` already generates formant-based speech; `corpus-augment.ts` exists.
   Add a `voice-workbench-noise` **tier-2** case that mixes additive noise / a second
   overlapping speaker into the synthetic clip and asserts the blind clusterer still
   separates speakers and the respond-gate still rejects the bystander at a target SNR.
   Fully session-doable (deterministic DSP, no models) and it closes the one class with
   literally zero non-hardware coverage.

5. **Kill the "REAL-AUDIO" overclaim in headers/names or qualify it.** `voice-realaudio.spec.ts`
   is real audio-*in* only. Rename to `voice-capture-realaudio` or add "(ASR mocked)" so the
   next reader doesn't take it as end-to-end transcription proof. Trivial, session-doable.

### MEDIUM confidence — session-doable but needs care

6. **Provide a `resolvePredictedSpeakerLabel` backed by the tier-2 `OnlineSpeakerClusterer`
   to the browser workbench player**, so the diarization browser spec can score a *real*
   (synthetic-audio) DER instead of asserting `skipped`. The clusterer is pure JS and
   already runs in Node; bundling it into the shell is plausible but risks pulling
   plugin-local-inference into the UI bundle (dependency-direction concern flagged in the
   player header). Prefer keeping diarization in tier 2 (rec #1b) unless a browser-native
   diarization demo is a product goal.

7. **Add a negative/adversarial suite to the barge-in + capture tests.** Empty capture
   (<1 KB), aborted mid-capture, ASR 502, TTS silent-buffer — the self-test harness already
   distinguishes these (silent-buffer → fail), but no browser spec exercises the failure
   branches. Session-doable with more `page.route` variants that return errors and assert
   the UI surfaces them (not a false pass).

### LOW confidence — genuinely needs hardware (honest N/A with the exact blocker)

8. **Pillar 2 — model loading on all devices (macOS/Linux/Windows/iOS/Android).**
   **N/A in this coding session.** Real multi-device model-load benchmarking requires: a
   built `libelizainference.so`/dylib per platform, the pinned Kokoro GGUF + eliza-1 ASR
   bundle staged on disk, and a booted simulator/device or Electrobun package per OS. The
   `VOICE_LIVE_MATRIX.md` already scaffolds this correctly (env gates
   `ELIZA_VOICE_{MACOS,WINDOWS}_ELECTROBUN_READY`, `ELIZA_VOICE_{IOS,ANDROID}_READY`,
   `ELIZA_INFERENCE_LIBRARY` + `ELIZA_ASR_BUNDLE`, `--require-green`). **Blocker:** no fused
   library, no model bundles, and no device/simulator are reachable from a keyless coding
   container. Concrete follow-up: run `bun run voice:matrix -- --run --require-green` on each
   provisioned self-hosted runner and attach the per-platform `voice-matrix.json` + screenshots;
   there is nothing to *build* in the harness — only to *execute on hardware*.

9. **Pillar 3 — STT quality / model selection (WER + latency benchmark).**
   Selection logic **exists and is REAL/testable now**: `pickDefaultVoiceProvider`
   (unit-tested) picks tts/asr per platform×runtime; `isLocalInferenceAsrReady` degrades to
   browser/cloud ASR when local isn't provisioned; the Stage-B matrix cells
   (`stt.stage-b.apple-sfspeech`, `stt.stage-b.evaluation`) define the WER/latency/RTF/battery
   schema. A real WER+latency harness needs: real ASR backends (SFSpeechRecognizer on macOS/iOS,
   Android SpeechRecognizer, fused ASR on Linux), a labelled speech corpus with noise variants,
   and per-device runs. **Blocker:** on-device ASR engines + labelled corpus + devices — not
   reachable here. The schema (`eliza_voice_stage_b_stt_eval_v1`) is already defined; the work is
   executing it on hardware and reviewing the reports, not writing new harness code.

10. **Pillars 4 & 5 on real audio (voice→entity + noise/isolation with real models).**
    The *logic* is coverable in-session (recs #2, #4). The *real-model* proof
    (WeSpeaker enrollment → entity resolution on real voices; pyannote separation under
    real reverb/overlap) is the tier-3 `--real` matrix. **Blocker:** WeSpeaker/pyannote
    fused ABI + real multi-speaker recordings + GPU runner. Already wired in
    `voice-live-e2e.yml`; execute nightly and attach `voice-matrix` artifacts.

### Bottom line

The voice stack is **not** a hollow larp — it has a genuinely rigorous tier-2 (real shipped
decision gates + non-tautological acoustic clustering, PR-gated with a regression baseline)
and a correctly-gated tier-3 (real fused models, honest skip). The problem #10726 should
target is narrow and fixable in a session: the **browser e2e tier carries model-quality
names over mocked backends**, producing ~13 LARP specs whose green `pass` verdicts imply
diarization / entity-extraction / voice-recognition / WER accuracy that they never exercise.
De-larp = rename/rescope those specs to "wiring," move the class claims to the real tier-2
suite (adding the missing entity-extraction assertion and a synthetic-noise case), and add a
negative WER test so the accuracy gate has teeth. Everything model-quality on real devices is
honest hardware N/A with the matrix already scaffolded to execute it.

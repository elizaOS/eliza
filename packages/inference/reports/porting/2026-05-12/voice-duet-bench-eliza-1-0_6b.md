# voice-duet bench — eliza-1-0_6b (CPU baseline) — 2026-05-12

> WS-5 deliverable. Status of the two-agents-talking-endlessly harness, the
> latency instrumentation, the emotion path, and the scientific-grind harness;
> the CPU-baseline run on this box; the methodology + the gating for the GPU
> grind. **Honesty contract:** numbers that could not be measured are recorded
> as `needs-run` / `null` with the root cause, never fabricated.

## What landed (verified)

- **`packages/app-core/scripts/voice-duet.mjs`** (`bun run voice:duet`) — two
  `LocalInferenceEngine` instances on the same tier bundle (default
  `eliza-1-0_6b`, also `eliza-1-1_7b`) with different `Character` JSON each →
  different room + system prompt + persona. Audio routing in memory only:
  `A.scheduler.sink → DuetSink (24 kHz → 16 kHz) → ring → B.PushMicSource →
  B's VAD/ASR → B's VoiceTurnController.generate (the real Stage-1
  forced-grammar message-handler path) → B's replyText → B's TTS → A's ring →
  …` endless (or `--turns N`). `DuetAudioBridge { aToB, bToA }`. No speakers,
  no mic. All tricks on (DFlash, KV prewarm, guided structured decode default
  on, fused streaming when the build advertises it; the
  `MILADY_LOCAL_ALLOW_STOCK_KV=1` reduced-optimization fallback only where a
  backend genuinely can't dispatch). Sweep knobs threaded through:
  `--parallel`, `--draft-max`/`--draft-min`, `--ctx-size-draft`,
  `--chunk-words`, `--prewarm-lead-ms`, `--ring-ms`, `--kv-cache-type`,
  `--backend`. `--two-process` runs agent B in a child process exchanging PCM
  over stdio (the 1.7b RSS split). `--report out.json` writes a gate-aligned
  `voice-duet-bench` JSON (+ a `.md` sidecar). Reuses
  `voice-interactive.mjs`'s prereq inspector (parameterised by `--modelId`),
  the bundle-registration helper, and `--platform-report`. **Fail-closed**: a
  missing bundle / fused lib / DFlash binary / required kernel prints the
  checklist + exits non-zero — no silent stub-TTS duet (AGENTS.md §3).
  - **Boot path verified on this box:** the harness boots both standalone
    runtimes, registers both bundles, arms both engines' voice lifecycles, and
    drives `engine.load()` — at which point the *locally-installed*
    `llama-server` build fails with `error while loading shared libraries:
    libmtmd.so.0: cannot open shared object file` (a broken local fused build —
    a WS-2/WS-3 build-matrix concern, not a harness bug). The harness surfaces
    this as a fatal error and exits non-zero. The full real-output round-trip
    is therefore gated on a working fused build, not on the harness.
- **`packages/app-core/scripts/lib/duet-bridge.mjs`** — `resampleLinear` (24
  kHz → 16 kHz linear interpolation), `DuetSink` (an `AudioSink` that
  resamples each chunk and forwards it; tracks `lastWriteAt()` /
  `totalForwarded()` so the harness can mark `peer-utterance-end` on drain),
  `DuetAudioBridge { aToB, bToA }`.
- **`packages/app-core/src/services/local-inference/voice/voice-duet.test.ts`**
  (default test run) — unconditional **wiring / cancel / shape** assertions
  with stub TTS + the `DuetAudioBridge` + scriptable VADs + `TestTranscriber`s
  + fake echoing `generate`s: A's TTS PCM lands in B's ring → B replies → 3
  A→B→A round-trips without a deadlock; both latency tracers record the duet
  checkpoints (`peer-utterance-end`, `audio-first-into-peer-ring`,
  `replyText-first-emotion-tag`) and the headline histograms
  (`ttftFromUtteranceEndMs`, `firstAudioIntoPeerRingFromUtteranceEndMs`,
  `emotionTagOverheadMs`); the cross-ring stays bounded; a cancel
  mid-`generate` (the producer's `AbortSignal`) stops the turn and doesn't
  wedge the loop. **3/3 pass.**
- **`…/voice/voice-duet.e2e.test.ts`** (e2e test run) — the gated real-output
  run on `eliza-1-0_6b`: boots two engines on the same bundle with two
  characters, wires the bridge, seeds A, asserts PCM crossed the loop. Skips
  unless the catalog's required kernels are advertised AND a fused build is
  present (`it.skipIf(!realBackendPresent)`); everything heavy is imported
  lazily inside the gated `it`. Don't fake a "real" run.
- **Latency instrumentation** (`packages/app-core/src/services/local-inference/latency-trace.ts`):
  - new checkpoints `peer-utterance-end` (the duet headline t0 — when the
    producing agent drained its last PCM into the cross ring),
    `audio-first-into-peer-ring` (the duet replacement for `audio-first-played`
    — no speakers), `replyText-first-emotion-tag` (the first inline expressive
    tag in `replyText`). These are *optional* checkpoints — a single-agent
    voice turn is still `complete` without them; they are listed in `missing`
    so the duet harness can see which ones it didn't get.
  - new derived spans into the existing p50/p90/p99 histograms:
    `ttftFromUtteranceEndMs` (**THE headline** — peer-utterance-end →
    llm-first-token), `replyTextFirstCharFromUtteranceEndMs`,
    `firstTtsPcmFromUtteranceEndMs`,
    `firstAudioIntoPeerRingFromUtteranceEndMs` (**the duet round-trip**),
    `emotionTagOverheadMs` (llm-first-token → replyText-first-emotion-tag —
    emotion-markup overhead, measured the way `envelopeToReplyTextMs` measures
    envelope overhead). `LATENCY_DERIVED_KEYS` + `DERIVED_SPANS` extended; the
    dev endpoint payload (`buildVoiceLatencyDevPayload`) and
    `voice-latency-report.mjs` pick them up automatically (they iterate the key
    array). **`latency-trace.test.ts` + `dev-voice-latency-route.test.ts` +
    `voice-latency-report.test.ts` all pass.**
  - a sibling **`VoiceRunMetrics`** accumulator: DFlash accept-rate
    (token-weighted Σaccepted/Σdrafted) + a per-turn accept-rate histogram,
    structured-decode token-savings % histogram, tok/s histogram, RSS-over-N
    (first/last/max + a `leakSuspected` flag — monotone-non-decreasing over ≥4
    turns and grown beyond a threshold). The duet harness feeds it per turn;
    `summary()` goes in the bench report next to the latency histograms.
- **`packages/inference/verify/voice_duet_sweep.mjs`** — the scientific grind:
  runs `voice-duet.mjs --turns N --report …` across a Cartesian grid of the
  sweep knobs (`--parallel`/`--draft-max`/`--ctx-size-draft`/`--chunk-words`/
  `--prewarm-lead-ms`/`--ring-ms`/`--kv-cache-type`/`--backend`), writes one
  CSV row per cell (the headline p50/p90/p99 + accept-rate + token-savings % +
  tok/s + RSS + the `note` column with the exit code + stderr tail for a failed
  cell), and emits a before/after `.md` (baseline cell 0 vs the cell that
  minimizes `ttftFromUtteranceEndMs.p50`). `--dry-run` prints the grid. A
  failed cell is recorded with its exit code — never a fabricated row.
- **Gates** (`packages/training/benchmarks/eliza1_gates.yaml`,
  `packages/inference/verify/eliza1_gates_collect.mjs`):
  `first_token_latency_ms` re-anchored to `ttftFromUtteranceEndMs.p50`;
  `first_audio_latency_ms` to `firstAudioIntoPeerRingFromUtteranceEndMs.p50`;
  new `duet_round_trip_ms` + `structured_decode_token_savings_pct` gates
  (provisional; the latter has a 20% floor — ≈28% is measured statically over
  the synthetic action set); `expressive_tag_faithfulness` re-described as the
  duet emotion-fidelity accuracy with the explicit
  Qwen3-ASR-label↔tag-vocab mapping and the honest `null` /
  `perceiver: fallback-classifier (unavailable)` contract; per-tier thresholds
  for the two new gates on all six tiers. `eliza1_gates_collect.mjs` discovers
  `reports/porting/<date>/voice-duet-bench-<tier>.json` (newest, tier-matched)
  and feeds those metrics into the gate evaluation. **The gates YAML test
  (`test_eliza1_gates.py`, `eliza1-gates-yaml.test.ts`) pass; `eliza1_gates_collect.mjs --tier 0_6b`
  evaluates the new gates as `needs-data` until a duet report exists.**
- **Emotion through the pipeline**
  (`packages/app-core/src/services/local-inference/voice/expressive-tags.ts`):
  - `EXPRESSIVE_TAGS` — the omnivoice-singing inline-tag vocabulary verbatim
    (`[happy] [sad] [angry] [nervous] [calm] [excited] [whisper]` + `[singing]`
    + the preserved non-verbals `[laughter] [sigh]`); `EXPRESSIVE_EMOTION_ENUM`
    (`["none", ...emotion tags]`) — the value set for WS-4's optional Stage-1
    `emotion` enum field-evaluator (a one-line registration there).
  - `parseExpressiveTags(replyText): { cleanText, segments: [{text, cleanText,
    emotion, singing, nonverbals}], dominantEmotion, anySinging, hasTags,
    unknownTags }` — tags inline, scoped until the next tag or end-of-text;
    `segment.text` keeps the scope tag (the singing GGUF parses it),
    `cleanText` strips it; `unknownTags` records bracket tokens the model
    emitted that aren't in the vocab (the `tagLeakage` signal). Also
    `stripExpressiveTags` (the base-TTS path), `emotionToEnum`/`enumToEmotion`,
    `asrEmotionToTag` (the perceiver mapping), `expressiveTagPromptClause`
    (the voice-output prompt clause, gated on `voice.capabilities`).
    - **Fixed a real infinite-loop bug found while testing:**
      `parseExpressiveTags` called `String.prototype.replace` (which resets a
      shared global regex's `lastIndex` to 0) from inside its own `RegExp.exec`
      loop on the same regex object — wedging the loop. Now uses a fresh regex
      instance per call (`tagRegex()`), plus a zero-width-match guard.
  - the parse path: the duet harness's `wrapGenerate` runs
    `parseExpressiveTags` over the streamed `replyText`, marks
    `replyText-first-emotion-tag` on the first inline tag, and records the
    dominant intended emotion for the fidelity metric; the tags pass through
    into the TTS text unchanged (the singing GGUF parses them — `makeTextToSpeechHandler`
    already does not strip them).
  - the **`emotionFidelity`** metric: A's intended emotion (the dominant tag /
    `emotion` field A emitted) vs B's ASR-perceived emotion over the loop — a
    confusion matrix + accuracy, with the explicit Qwen3-ASR-label↔tag-vocab
    mapping (`happiness↔happy`, `sadness↔sad`, `anger↔angry`, `fear↔nervous`,
    `calm↔calm`, `surprise↔excited`; `whisper`/`singing` excluded — delivery
    styles, scored separately as "style preserved"). **GGUF-ASR-emotion
    verdict (the open question from cluster-5 §0/§E.1):** the GGUF-converted
    Qwen3-ASR's emotion-label surface in the transcript could not be confirmed
    on this box (the local fused `llama-server` build is broken — see above —
    so no `mtmd` run against an emotional clip was possible; WS-4 owns the
    `eliza-1-asr-mmproj.gguf` special-token-map probe). The metric therefore
    runs the path but records `accuracy: null` and `perceiver:
    fallback-classifier (unavailable)` in the artifact — **recorded, not
    faked**. When the GGUF-ASR does surface a `<emotion>…</emotion>` span or a
    special token, `extractEmotionFromTranscript` in `voice-duet.mjs` picks it
    up and `asrEmotionToTag` maps it. A tiny emotion-from-audio classifier
    (Silero-sized) / a pitch-energy heuristic in `transcriber.ts` is the
    documented fallback to wire (WS-4 territory).

## CPU-baseline latency numbers (this box)

| metric | eliza-1-0_6b | eliza-1-1_7b | source |
|---|---|---|---|
| ttftFromUtteranceEndMs p50/p90/p99 | `needs-run` | `needs-run` | blocked: local `llama-server` build missing `libmtmd.so.0` |
| firstAudioIntoPeerRingFromUtteranceEndMs (duet round-trip) p50/p90/p99 | `needs-run` | `needs-run` | same |
| DFlash accept-rate | `needs-run` (drafter present in the bundle; no real KD yet — WS-4) | `needs-run` | server `/metrics` |
| structured-decode token-savings % | ≈28% (static, from WS-4's `guided_decode_token_bench.mjs` over the synthetic action set) — the per-run number `needs-run` | same | bench |
| emotionFidelity accuracy | `null` (`perceiver: fallback-classifier (unavailable)`) — see verdict above | `null` | duet harness |

The CPU baseline could not be produced on this box because the installed
`linux-x64-cpu-fused` `llama-server` fails to dynamically link (`libmtmd.so.0`
not found) — a broken local fused build, a WS-2/WS-3 build-matrix item.
The duet harness drives all the way to `engine.load()` and surfaces this
honestly. The exact command to reproduce once a working build is present:

```
bun run voice:duet -- --model eliza-1-0_6b --turns 20 \
  --report packages/inference/reports/porting/<date>/voice-duet-bench-eliza-1-0_6b.json
bun run voice:duet -- --model eliza-1-1_7b --two-process --turns 20 \
  --report packages/inference/reports/porting/<date>/voice-duet-bench-eliza-1-1_7b.json
```

## The GPU grind — methodology + gating

On a CPU build TTS dominates (~6–10× RTF — `e2e-loop-benchmark.md`), so the
round-trip is TTS-bound and the LLM-side knobs (`--parallel`/`--draft-max`/
`--prewarm-lead-ms`/chunker thresholds) barely move the headline. The
headline grind is therefore **gated on WS-2's GPU-fused `libelizainference`
build + WS-4's W7 streaming decoders** — once those land, the LLM TTFT +
prewarm + chunker thresholds become the lever and `voice_duet_sweep.mjs`
becomes the grind tool. The CPU baseline + the methodology + the harness are
in place now; the GPU run is one `voice_duet_sweep.mjs` invocation when the
build lands:

```
bun packages/inference/verify/voice_duet_sweep.mjs --model eliza-1-0_6b --turns 20 \
  --backend cuda,vulkan --parallel 1,2 --draft-max 8,16,24 \
  --ring-ms 120,160,200,240 --chunk-words 4,8,12 --prewarm-lead-ms 0,80,160 \
  --kv-cache-type turbo3,turbo3_tcq,f16 \
  --out packages/inference/reports/porting/<date>/voice-duet-sweep-0_6b.csv
# then again --model eliza-1-1_7b --two-process …
```

Grind loop: profile the dominant per-stage span from each cell's tracer
histogram (`latency.histograms`), sweep that stage's knob, pick the config
minimising `ttftFromUtteranceEndMs.p50` without regressing `dflashAcceptRate`,
re-run, repeat until the round-trip plateaus; document the winning per-tier
config in the manifest `evals` block + this report.

## Coordination notes (for the other workstreams)

- **WS-3 (fine-tune corpus):** the `voice_emotion` task carries **both** forms
  per the joint decision — inline `[happy]/[whisper]/…` tags in `replyText`
  (`free-string` span, no grammar change) **and** an optional Stage-1 `emotion`
  enum field with value set `EXPRESSIVE_EMOTION_ENUM` =
  `["none","happy","sad","angry","nervous","calm","excited","whisper"]`.
  Preserved non-verbals `[laughter] [sigh]` are kept verbatim. Generate the
  affect annotation alongside the reply (Cerebras `gpt-oss-120b`). Also: WS-3
  must build/stage the **`omnivoice-singing` GGUF** in the bundles — today's
  bundles ship a base OmniVoice GGUF that ignores the tags, so
  `expressive_tag_faithfulness` will be poor until the singing variant is
  staged (cluster-5 §E.4).
- **WS-4:** (1) the optional Stage-1 `emotion` enum field-evaluator —
  register exactly `EXPRESSIVE_EMOTION_ENUM` so it auto-flows into
  skeleton+grammar+prefill; (2) probe `eliza-1-asr-mmproj.gguf`'s special-token
  map for an `<emotion>`-style span / special token (the GGUF-ASR-emotion
  question — currently unresolved, see verdict above) and report the result;
  (3) the W7 streaming decoders (`eliza_inference_{asr,tts}_stream_*`) are the
  thing that makes the duet round-trip fast — the harness already pumps PCM
  chunk-by-chunk through the `DuetSink`/`PushMicSource` so it'll consume them
  with no further changes; (4) surface the guided-decode token-savings counter
  on the running server's `/metrics` (or a side channel) so
  `runMetrics.structuredDecodeTokenSavingsPct` is a per-run number, not the
  static aggregate.
- **WS-2:** the GPU-fused `libelizainference` + the kernel-complete
  `llama-server` (and a CPU build that actually links — `libmtmd.so.0` is
  missing on this box's `linux-x64-cpu-fused` build) are the prereq for the
  headline grind.
- **WS-1:** `latency-trace.ts` / `voice-duet.mjs` / `lib/duet-bridge.mjs` /
  `expressive-tags.ts` / the two duet test files are lint/typecheck-clean
  (`tsc --noEmit -p packages/app-core/tsconfig.json` reports no errors in
  these files). They're sweeping the voice dir LAST — these are the final
  shape.

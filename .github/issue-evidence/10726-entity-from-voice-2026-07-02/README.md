# #10726 — Entity-recognition-from-voice benchmark (real, Linux CPU)

Scope pillar 4 of the voice de-larp epic: recognizing known entities in speech, dynamically **creating** new entities and associating speech to them, inferring **attributes**, and **disambiguating** similar-sounding names. Real weights, no mocks; the extraction path is the shipped code, not reimplemented here.

`packages/benchmarks/entity-voice-bench/` — two lanes:
- **`kg`** (keyless, default): emits the production `VOICE_TURN_OBSERVED` event into a real `AgentRuntime` with `@elizaos/plugin-personal-assistant`; the voice-observer bridge folds each turn into the knowledge-graph `EntityStore`/`RelationshipStore` (match-or-create, partner claims, merges) and round-trips `VOICE_ENTITY_BOUND` — exactly what `plugin-local-inference` does when it attributes a live voice turn. Built by `scenario-runner`'s factory with the deterministic LLM proxy → **no API keys** (the merge-engine path makes no LLM calls).
- **`llm`**: feeds the same transcripts through `runtime.messageService.handleMessage` as owner chat turns (stage-1 extract + facts/relationships + reflection). Requires a live model key or `ELIZA_CHAT_VIA_CLI` — not run in this pass (documented gap below).

Inputs: `--input text` scores extraction over reference transcripts (isolates extraction quality); `--input audio` replays `asr-transcripts.json` produced by the **real Kokoro→ASR pipeline** — so the text↔audio delta is exactly the ASR-induced entity error.

## Real ASR corpus

`corpus:transcribe` over the synthesized clips: **42 transcripts, mean WER 0.019, name-survival 0.90** (`asr-transcripts.json`, committed — 16 KB). Real `eliza-1-asr` GGUF + host fused lib.

## Results — `kg` lane (P / R / F1)

| category | text input | audio input (real ASR) | Δ (ASR effect) |
|---|---|---|---|
| creation | 0.67 / 0.89 / **0.76** | 0.67 / 0.89 / **0.76** | none |
| recognition | 0.77 / 0.77 / **0.77** | 0.77 / 0.77 / **0.77** | none |
| attribute | — / 0.00 / — | — / 0.00 / — | n/a (see note) |
| disambiguation | 0.80 / 0.67 / **0.73** | 0.67 / 0.33 / **0.44** | **−0.29 F1** |
| relationships | 1.00 / 0.67 / **0.80** | 1.00 / 0.33 / **0.50** | **−0.30 F1** |
| false merges | **0** | **0** | — |

## Reading

- **Creation + recognition are ASR-robust** — identical text vs audio, because names survived ASR at 0.90. The merge engine binds/creates entities reliably from real transcribed speech.
- **Disambiguation and relationships degrade under real ASR** (F1 −0.29 / −0.30). This is the genuine, actionable finding: confusable names (the homophones corpus — Aaron / Erin / Dana) and relationship phrasing are exactly what the residual 1.9% WER corrupts, and the merge engine can't recover the intended distinction/link from a mistranscribed name. Improving voice→entity quality here means better ASR on proper nouns and/or an entity-aware rescoring pass, not merge-engine changes.
- **0 false merges** in both lanes — the store never conflates distinct people, even under ASR noise (the safety-critical property).
- **attribute R=0.00 is expected for this lane**: attribute inference (e.g. "Maria's birthday is in June") is an LLM-extraction capability, not a merge-engine one — it is measured by the `llm` lane, which needs a live model (gap below). The metric is reported (not hidden) so the epic tracks it.

## Reproduce

```bash
export ELIZA_INFERENCE_LIBRARY=<host libelizainference.so>
export ELIZA_ASR_BUNDLE=<asr-bundle dir>
export ELIZA_KOKORO_MODEL_DIR=<dir with kokoro gguf + voices/*.bin>
cd packages/benchmarks/entity-voice-bench
bun run corpus:transcribe        # real ASR over the clips → asr-transcripts.json
bun run bench:kg:text            # extraction quality (keyless)
bun run bench:kg:audio           # + real-ASR delta (keyless)
bun run bench:llm:{text,audio}   # attribute/LLM lane — needs a model key or ELIZA_CHAT_VIA_CLI
```

## Documented gap

- The **`llm` lane** (attribute inference + conversational extraction) needs a live model and was not exercised in this pass; `attribute` recall is therefore 0 here. Run it with a provider key or `ELIZA_CHAT_VIA_CLI=claude|codex` on a subscription host to populate the attribute baseline.
- `corpus:synth` currently references an `af_nicole.bin` voice not staged on this host; the committed `asr-transcripts.json` was produced from the existing synthesized corpus. Stage the full voice set to regenerate audio from scratch.

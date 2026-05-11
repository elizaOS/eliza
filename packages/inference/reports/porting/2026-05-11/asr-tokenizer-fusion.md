# ASR tokenizer fusion — verifying the zero-re-tokenization claim

**Date:** 2026-05-11
**Scope:** trace the ASR→text token handoff end to end; verdict on the
"tokenizer fused with the Qwen3.5/3.6 text backbone (zero re-tokenization
between ASR output and text input)" claim in `packages/inference/AGENTS.md`
§1; the plumbing fix landed in this pass; what is still required for the
claim to hold on the live runtime path.

## TL;DR

- **Vocab claim — TRUE.** Qwen3-ASR-0.6B / -1.7B, the text backbones,
  the DFlash drafter and the embedding model all use the same Qwen2 BPE
  vocabulary (151 936 tokens) and the same merges table. This is already
  exploited by `dflash-server.ts` (`resolveDflashDrafter` copies
  `tokenizer.ggml.merges` from the target into the drafter at load) and by
  `voice/shared-resources.ts` (`SharedTokenizer` is one object refcounted
  by text + voice). See `qwen-backbone-unification.md` §1.
- **Zero-re-tokenization claim — NOT TRUE on the current runtime path.**
  There is a detokenize → retokenize round-trip. The ASR decoder produces
  Qwen3-ASR token ids internally, but the runtime converts them to a UTF-8
  string and then re-tokenizes that string when it enters the text model.
- **Why it is not a one-line fix.** The round-trip spans four layers:
  native ASR ABI → FFI binding → JS pipeline → llama-server HTTP. The text
  model is reached over `/v1/chat/completions` with a chat-templated string
  (`<|im_start|>user\n…<|im_end|>\n<|im_start|>assistant\n`). Even if raw
  ASR token ids were available end to end, the chat-template wrapping is
  applied as text and re-tokenized server-side, so the ASR ids are at best
  a sub-span of the prompt the server actually tokenizes. The claim can
  only hold for a hypothetical in-process token-id handoff that bypasses
  chat templating (W7's fused runtime, with a "continue from these ids"
  entrypoint instead of an HTTP chat call).
- **What landed this pass.** The JS plumbing now *carries* ASR token ids
  when the producer supplies them, so when W7's fused decoder starts
  returning ids the pipeline propagates them instead of dropping them on
  the floor — see "Fix landed" below. The native ASR side and the
  llama-server token-id-prompt path are explicitly W7 / out of scope here.

## The actual code path (as of this pass)

1. **Native batch ASR — `eliza_inference_asr_transcribe`**
   (`packages/app-core/scripts/omnivoice-fuse/prepare.mjs`). Loads the ASR
   GGUF + qwen3a mmproj, runs `mtmd_helper_eval_chunks` (audio encoder
   prefill) then a greedy decode loop: `llama_sampler_sample` →
   `eliza_llama_token_piece(vocab, token)` → appends the **string piece**
   to a `std::string` transcript → returns the string. The token ids are
   produced (`llama_token token`) but **discarded** — only the surface
   text crosses the ABI. Signature returns `int` (transcript byte length),
   not token ids.

2. **Streaming ASR ABI — `eliza_inference_asr_stream_partial/finish`**
   (same file). The ABI shape *does* include `int * out_tokens` / `size_t *
   io_n_tokens` — i.e. it is designed to return token ids. But the
   implementation is an honest stub: `eliza_inference_asr_stream_supported()
   == 0`, every entry returns `ELIZA_ERR_NOT_IMPLEMENTED`. Owned by W7.

3. **FFI binding — `voice/ffi-bindings.ts`.** `asrTranscribe(...)` returns
   `string`. `asrStreamPartial/Finish(...)` return `{ partial: string;
   tokens?: number[] }` — the `tokens` field is plumbed through (it reads
   `out_tokens` when `io_n_tokens > 0`), it is just always empty today
   because the native side is stubbed.

4. **Transcriber adapters — `voice/transcriber.ts`.**
   `FfiStreamingTranscriber` surfaces `TranscriptUpdate.tokens` from the
   FFI; `WhisperCppStreamingTranscriber` (the interim path) does not (it is
   a genuinely different tokenizer — re-tokenization is unavoidable there
   and correct). Both produce `TranscriptUpdate { partial: string;
   isFinal: boolean; tokens?: number[] }`.

5. **Pipeline adapter — `voice/pipeline-impls.ts`
   `StreamingTranscriberTokenStreamer`.** Feeds the utterance, `flush()`es,
   and yields `TextToken`s. **Before this pass it used only `final.partial`
   and re-split it into whitespace-aware word chunks** via
   `splitTranscriptToTokens` — the `final.tokens` ids were dropped even
   when present. **After this pass** it passes `final.tokens` through:
   `splitTranscriptToTokens(final.partial, 0, final.tokens)` attaches each
   id to its `TextToken.id` *when the id count lines up with the surface
   chunk count* (a positional join; if they disagree the ids are dropped
   and only the word-chunk approximation survives — never a mislabeled id).

6. **Text-model handoff — `voice/pipeline.ts` →
   `voice/pipeline-impls.ts` `LlamaServerDraftProposer` /
   `LlamaServerTargetVerifier` → `dflash-server.ts`.** The pipeline holds
   `TextToken[]` (the ASR tokens are in `prefix`, ids intact). But
   `prefixToPrompt(prefix)` does `prefix.map(t => t.text).join("")` → a
   **string** → `DflashGenerateArgs.prompt: string` → `/v1/chat/completions`
   `messages: [{ role: "user", content: <that string> }]` → the server
   applies the chat template and **re-tokenizes**. So even with ids on
   every `TextToken`, the HTTP boundary throws them away.

7. **TRANSCRIPTION model handler.** `engine.transcribePcm()` →
   `EngineVoiceBridge.transcribePcm()` returns a `string` into the agent's
   message pipeline (not into any KV cache). That path is text by
   construction and re-tokenization is the LLM stage's job — no fusion
   claim applies there. The fusion claim is about the in-process *voice*
   pipeline (§4: "the moment ASR's last token lands, the drafter starts").

## Verdict

The "zero re-tokenization" line in AGENTS.md §1 is an **architectural
target**, not the current behavior. It is satisfiable only if:

1. **(W7, native)** the fused ASR decoder returns its token ids — the batch
   `asr_transcribe` ABI needs a sibling that emits ids, or the streaming
   `asr_stream_*` symbols (which already have `out_tokens` in the ABI)
   become real.
2. **(W7, runtime)** the text model is reachable by *token ids*, not just a
   chat string — either a llama-server `/completion` call with
   `prompt: <int[]>` and the chat template applied *as ids* (so the ASR ids
   are a contiguous sub-array of the prompt ids and the prefix KV is
   genuinely reused without re-tokenization), or the in-process fused
   runtime's "continue from these ids" entrypoint that W7 is building for
   the verifier-event path anyway.
3. **(done)** the JS pipeline carries ids end to end — landed this pass.

Until (1) and (2) land, the round-trip is: ASR ids → string → text-model
re-tokenization. Cost: one extra tokenize pass over the (usually short)
utterance prompt — small in absolute latency, but it can mis-segment vs the
ASR decoder's own boundaries, which is a correctness wrinkle the contract
exists to forbid.

## Fix landed in this pass

- `voice/types.ts`: `TextToken` gains an optional `id?: number` (the
  text-model vocab token id when the producer knows it; documented as the
  thing a future in-process handoff injects directly).
- `voice/pipeline-impls.ts`: `splitTranscriptToTokens(transcript,
  startIndex, tokenIds?)` — when `tokenIds.length === <surface-chunk
  count>` the ids are attached as `TextToken.id`; otherwise dropped.
  `StreamingTranscriberTokenStreamer` now forwards `final.tokens` into it.
- Net effect: the moment W7's fused decoder returns token ids in
  `TranscriptUpdate.tokens`, they flow into the pipeline's `prefix` tokens
  unchanged. The remaining gap is then purely (2) — the llama-server /
  fused-runtime token-id-prompt path — which is W7's runtime work.
- Tests: `voice/pipeline-impls.test.ts`, `voice/pipeline.test.ts`,
  `voice/transcriber.test.ts` all green (30/30).

## What is still W7's job

- The real fused streaming ASR decoder (`eliza_inference_asr_stream_*`)
  with `out_tokens` populated — the windowed incremental transcript +
  token ids.
- A token-id text-model entrypoint (or chat-template-as-ids on
  llama-server) so the ASR ids actually skip re-tokenization on the way
  into the text KV cache.

# R6 — OmniVoice freeze-to-single-voice + llama.cpp port feasibility

**Agent:** R6-omnivoice
**Phase:** research
**Scope:** Architecture deep-dive on OmniVoice (Qwen3 0.6B + HiggsAudioV2
codec); audit of the **existing** OmniVoice path already shipping in this
repo; concrete plan to freeze the model to the **samantha** voice; final
recommendation on the llama.cpp port question the user asked.

---

## TL;DR — read first

1. **The llama.cpp port is already done.** Our `elizaOS/llama.cpp` fork at
   `plugins/plugin-local-inference/native/llama.cpp` already contains a
   full graft of `omnivoice.cpp` (46 files under `omnivoice/`), built into
   a fused `libelizainference.{dylib,so}` + a fused `llama-server` that
   serves `POST /v1/audio/speech` from the same process that serves
   `/v1/chat/completions` and the DFlash speculative loop. Two custom ops
   the upstream ServeurpersoCom ggml fork needs (snake activation, 1-D
   col2im) are **already mapped onto existing ggml ops** in the graft —
   snake = `mul → sin → sqr → mul → add`, col2im_1d = the stock
   `ggml_conv_transpose_1d`. Nothing new has to be written on the kernel
   side. Effort to "port to llama.cpp" today = **S (already shipped)**.
2. **OmniVoice does NOT have a learned speaker embedding.** It conditions
   on:
   - an `instruct` *string* (`"male, american accent"`, etc.) tokenized
     into the LM input as a `<|instruct_start|>…<|instruct_end|>` block,
   - **and/or** **reference audio tokens** placed in the audio-codebook
     stream (`ref_audio_tokens [K=8, ref_T]`), encoded by the bundled
     HuBERT-semantic + DAC RVQ tokenizer.
   There is no separate speaker-embedding tensor to "bake into" the LM's
   first-layer bias. The right freeze surgery is therefore **not** what
   the user prompt sketched in step (a)/(b) — it's "encode the samantha
   corpus once with the tokenizer, persist the resulting reference
   audio-token packet, and *always* pre-pend it to every TTS request".
   That collapses to a one-time-encoded constant prefix in the LM input
   stream — not a weight surgery. **The shipped FFI already accepts a
   `speakerPresetId` argument and a 1024-byte `voice-preset-default.bin`
   side-channel; both currently carry placeholder data (empty `instruct`
   + 256 fp32 zeros). The freeze is: fill those in, not modify graphs.**
3. **A weight-bake variant is still possible and cheap** — the LM's
   `embed_tokens[<|instruct_start|>] @ instruct_ids` slice is small and
   independent. It can be precomputed and merged into a frozen prefix
   embedding to skip one mat-vec per turn. Saves microseconds, not
   milliseconds. Not worth the surgery in v1 — call it a v2 micro-opt.
4. **Real wins available right now:**
   - Ship a real `cache/voice-preset-samantha.bin` for each bundle so
     samantha is selectable via `speakerPresetId="samantha"`.
   - Wire `params.instruct` and `params.ref_audio_tokens` correctly on
     the route + FFI side so the preset bytes actually reach
     `ov_synthesize` (today the FFI passes `params.instruct = voiceId`,
     which is the *literal string* "samantha", not the validated
     VoiceDesign attribute set, and never passes `ref_audio_tokens`).
   - Quantize the singing variant + the freeze artifact through the
     existing `omnivoice/tools/quantize.cpp` (already supports Q4_K_M /
     Q5_K_M / Q6_K / Q8_0 / BF16 with the right tensor pinnings).
   - Add the K-cache QJL + V-cache PolarQuant treatment to the
     OmniVoice LM's bidirectional self-attention — same kernels as the
     text LM, but the bidirectional attention pattern needs a one-shot
     re-validation (the existing kernels were verified on causal masks).
5. **Effort summary for I6:**
   - **Freeze (preset-based, no graph surgery):** **S**, ~1–2 days.
   - **Quantize + ship singing variant via the existing pipeline:** **S**.
   - **K-cache QJL on the bidir attention:** **M** (one verify cycle).
   - **Embed-bake micro-opt:** **S**, optional, defer.
   - **Port to llama.cpp:** **0** (done).

---

## 1. OmniVoice architecture — deep dive

### 1.1 Upstream (`k2-fsa/OmniVoice` + `ModelsLab/omnivoice-singing`)

Verified against the upstream README (`https://github.com/k2-fsa/OmniVoice`),
the singing model card (`https://huggingface.co/ModelsLab/omnivoice-singing`),
the Serveurperso GGUF card (`https://huggingface.co/Serveurperso/OmniVoice-GGUF`),
and the upstream model source
(`https://raw.githubusercontent.com/k2-fsa/OmniVoice/main/omnivoice/models/omnivoice.py`).

- **Backbone:** Qwen3-0.6B language model, **28 transformer layers**
  bidirectional (NOT causal — this is a MaskGIT non-autoregressive
  decoder, not autoregressive). Verified in
  `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/omnivoice-llm.h:65`:
  `m->cfg.is_causal = false; // MaskGIT, full bidirectional attention`.
- **Hidden size / FFN:** loaded at runtime from GGUF KV
  (`omnivoice-lm.embedding_length`, `omnivoice-lm.feed_forward_length`,
  `omnivoice-lm.attention.head_count`, etc. — `omnivoice-llm.h:57-66`).
  Qwen3-0.6B base shape: H=1024, FFN=3072, 16 query heads, 8 KV heads
  (GQA), head_dim=64, 28 layers — matches the Q4_K_M-quantized base
  GGUF size of 407 MB.
- **Audio path:**
  - **K=8 codebooks**, **audio_vocab_size=1025** (1024 codes + 1 mask
    id), `audio_mask_id=1024` (`omnivoice-llm.h:74-76`).
  - `audio_embeddings.weight` of shape `[H, K * audio_vocab_size] =
    [1024, 8200]` is the per-codebook embedding (`omnivoice-llm.h:40`).
    Each codebook k contributes a slice `[k * 1025, (k+1) * 1025)`.
  - `audio_heads.weight` of shape `[H, K * 1025]` is the per-codebook
    logits head (`omnivoice-llm.h:41`).
  - On input, `embed_tokens` covers text positions, and at audio
    positions all K codebook embeddings are summed:
    `audio_embeds = sum_k audio_embeddings(shifted_ids[:, k, :])` with
    `shifted_ids = id + k * audio_vocab_size`
    (`omnivoice-llm.h:14-20`, the file-level comment).
- **Decoding:** **MaskGIT iterative non-autoregressive**:
  - `num_step=32` by default (16 used for fast inference, both
    documented in the upstream README and `maskgit-tts.h:24-31`).
  - cosine timestep schedule, top-k confidence sampling with class +
    position temperatures, **CFG with cond+uncond stacked as batch=2**
    (`prompt-tts.h:25-36`).
  - **No KV cache** between steps — every step is a stateless forward
    of the bidirectional stack (`omnivoice-llm.h:22`,
    `pipeline-tts.h:103-118`).
- **Codec:**
  - **Tokenizer / encoder side:** HuBERT base (12 transformer layers,
    H=768, FFN=3072, 12 heads, k=128 grouped pos-conv) →
    SemanticEncoder → RVQ (Higgs Audio v2). Pipeline reference
    (`hubert-enc.h:9-18`): wav 24k → resample 16k → pad 160/160 →
    `feature_extractor` (7 conv layers, cumul stride 320, 1→512 ch) →
    `feature_projection` (LN(512) + Linear(512,768)) → `pos_conv_embed`
    (grouped Conv1d) → 12× HubertLayer → stack 13 hidden states → mean
    + ::2 downsample.
  - **Decoder side:** DAC vocoder. 5 upsampling blocks with strides
    `8, 5, 4, 2, 3` (total 960×). Per block: Snake activation +
    `ConvTranspose1d` + 3 dilated residual units (kernel 7, dilations
    `1, 3, 9`). Final 32→1 conv. Channel pyramid `1024 → 512 → 256 →
    128 → 64 → 32 → 1` (`dac-decoder.h:20-26`).
- **Sample rates:** input/output is 24 kHz mono fp32 (`omnivoice.h:90-94`,
  `omnivoice.h:251` "fills out with mono float PCM at 24 kHz",
  upstream README "audio is a list of np.ndarray with shape (T,) at
  24 kHz", `Serveurperso/OmniVoice-GGUF` card "Audio Format: 24 kHz
  mono output").
- **Frame rate:** codec frame rate = `sample_rate / hop_length` =
  `24000 / 480 = 50 Hz` per codebook (one frame ≈ 20 ms;
  `ov_duration_sec_to_tokens` in `omnivoice.h:258`).
- **Total params (Q4_K_M GGUF sizes from the shipped bundle):**
  - LM (`tts/omnivoice-base-Q4_K_M.gguf`): **407 MB** → ~0.6B params at
    Q4_K_M.
  - Codec / tokenizer (`tts/omnivoice-tokenizer-Q4_K_M.gguf`):
    **252 MB** → ~0.4B params (HuBERT 95M + DAC ~22M + RVQ + projections
    + linear heads — full precision is 734 MB per Serveurperso card,
    much of it Q4_K_M-incompatible RVQ codebooks pinned at F32; see
    `quantize.cpp:101-147` for the pinning policy).

### 1.2 Singing variant (`ModelsLab/omnivoice-singing`)

Same Qwen3 0.6B backbone, weights re-fine-tuned in two stages
(verified via the HF model card):

- **Stage 1 (2500 steps):** GTSinger English (6,755 clips, ~8 h) +
  LibriTTS-R speech-preservation subset.
- **Stage 2 (2500 steps):** CREMA-D + RAVDESS + Expresso (10.8k emotion
  clips) + 1.5k singing + 1.5k speech continuity.
- **Added special tokens:** `[singing]`, `[happy]`, `[sad]`, `[whisper]`,
  `[angry]`, `[nervous]`, `[calm]`, `[excited]`. Combinable with the
  13 non-verbal tags already in the base
  (`prompt-tts.h:38-43`): `[laughter]`, `[sigh]`, etc.
- **License posture (per `plugins/plugin-local-inference/native/AGENTS.md:55-67`):**
  Apache-2.0 weights, but stage-1/2 training data carries CC-BY-NC-SA
  (GTSinger, RAVDESS) / CC-BY-NC (Expresso). The repo policy as of
  2026-05-10 (Wave-6 user direction) is **ship for non-commercial use**;
  re-train on commercially-licensed corpora before any commercial pivot.

### 1.3 Conditioning input — the actual mechanism

This is the most-misunderstood part of the user prompt. There is **no
single "voice-conditioning input head"** to bypass. There are **three
conditioning mechanisms** plumbed through the same LM input:

1. **`instruct` string** — a comma-separated set of attributes drawn
   from a fixed VoiceDesign vocabulary (`voice-design.h:151-176`):
   - **gender**: `male`, `female` (+ Chinese aliases)
   - **age**: `child`, `teenager`, `young adult`, `middle-aged`, `elderly`
   - **pitch**: `very low pitch`, `low pitch`, `moderate pitch`,
     `high pitch`, `very high pitch`
   - **style**: `whisper`
   - **accent** (English-only): `american accent`, `british accent`,
     `australian accent`, `chinese accent`, `canadian accent`,
     `indian accent`, `korean accent`, `portuguese accent`,
     `russian accent`, `japanese accent`
   - **dialect** (Chinese-only): 12 regional Chinese dialects
   - **Tokenized into the LM** as
     `<|instruct_start|>{instruct}<|instruct_end|>` and replicated
     across all K codebook rows (`prompt-tts.h:251`, the cond-batch
     build in `prompt-tts.h:283-292`).
2. **Reference audio tokens** — the bundled tokenizer (HuBERT semantic +
   RVQ) encodes a reference WAV (≤30 s) into a discrete-token packet
   `[K=8, ref_T]` which the prompt builder places in the audio-codebook
   stream at positions `[N1+N2, N1+N2+ref_T)`. This is "voice cloning"
   (`omnivoice.h:218-224`, `prompt-tts.h:294-321`).
3. **`<|denoise|>` marker** — emitted iff `denoise=true` AND a reference
   is supplied; instructs the model to clean reference noise
   (`prompt-tts.h:240-242`).

There is no "speaker embedding tensor", no "speaker-condition input
head" that's separable from the LM, and no FiLM/CFG-extra branch. The
voice IS the prompt — text tokens (instruct + style) plus optional
audio-token prefix.

This means **the user's described freeze procedure ("apply the
conditioning input → bake the result into the first-layer bias → drop
the input head") does not directly apply** — there is no input head to
drop. The correct freeze for OmniVoice is: **pre-encode the samantha
reference WAVs to audio tokens once, persist them, prepend on every
call.** That is what `voice-preset-*.bin` is for. The "weights"
freeze the user envisioned reduces to a constant-prefix-prepend in
practice.

---

## 2. Current local usage — what already exists

### 2.1 `packages/app-core/scripts/omnivoice-fuse/` — graft into our llama.cpp

| File | Lines | Purpose |
| --- | --: | --- |
| `README.md` | 388 | Strategy doc: graft-not-submodule rationale, GGML pin reconciliation, ABI v3 surface, build runbook. Verified path. |
| `prepare.mjs` | 1898 | Clone `elizaOS/omnivoice.cpp` at pin `38f824023d12b21a7c324651b18bd90f16d8bb86`, strip its `ggml/` submodule, copy `src/` + `tools/` + `examples/` into `<llama.cpp>/omnivoice/`. Also emits the C-ABI bridge `eliza-inference-ffi.cpp` (the `eliza_inference_*` symbol table that JS loads via `bun:ffi`). |
| `cmake-graft.mjs` | 284 | Appends a CMake block to llama.cpp's root `CMakeLists.txt` (sentinel `# ELIZA-OMNIVOICE-FUSION-GRAFT-V1`) that declares `omnivoice-core` (static archive), `llama-omnivoice-server` (small smoke exe), and `libelizainference` (fused shared lib). Forces `GGML_MAX_NAME=128` on every relevant target (OmniVoice's audio tokenizer tensor names exceed the default 64). |
| `ffi.h` | 398 | C ABI v3 — declares `eliza_inference_create / destroy / mmap_acquire / mmap_evict / tts_synthesize / tts_synthesize_stream / asr_transcribe / asr_stream_* / vad_* / cancel_tts / set_verifier_callback / free_string / abi_version`. |
| `ffi-stub.c` | — | Stub implementation that returns `ELIZA_ERR_NOT_IMPLEMENTED` for every real entry; used by tests without the fused dylib. |
| `verify-symbols.mjs` | 475 | `nm`/`objdump` post-build probe: asserts both `llama_*` and `ov_*` exports are present in the produced binary/library; writes `OMNIVOICE_FUSE_VERIFY.json`. |
| `Makefile` | — | Builds the stub library + symbol verification targets. |
| `asr-ffi-smoke.ts`, `tts-stream-ffi-smoke.ts` | — | End-to-end FFI smoke tests with timing/RTF/firstAudioMs reporting. |

Pin table from `omnivoice-fuse/README.md:14-18`:

| Component | Repo | Pin |
| --- | --- | --- |
| omnivoice.cpp | `https://github.com/elizaOS/omnivoice.cpp` (fork of `ServeurpersoCom/omnivoice.cpp`) | `38f824023d12b21a7c324651b18bd90f16d8bb86` |
| omnivoice ggml | `https://github.com/ServeurpersoCom/ggml.git` | `0e3980ef205ea3639650f59e54cfeecd7d947700` — **NOT included** (stripped) |
| eliza llama.cpp | `https://github.com/elizaOS/llama.cpp.git` | `v0.4.0-eliza` / `v1.0.0-eliza` (`08032d57`) |

### 2.2 `packages/app-core/scripts/kernel-patches/server-omnivoice-route.mjs`

Verified at `/home/shaw/milady/eliza/packages/app-core/scripts/kernel-patches/server-omnivoice-route.mjs`,
501 lines. Mounts `POST /v1/audio/speech` onto the fused `llama-server`'s
HTTP router via a `#ifdef ELIZA_FUSE_OMNIVOICE` block inserted into
`tools/server/server.cpp`. Accepts the OpenAI-shape request
`{ "input": str, "voice": str?, "model": str?, "response_format":
"wav"|"pcm"|"f32"|"raw" }`. Honors env knobs `ELIZA_OMNIVOICE_MG_NUM_STEP`,
JSON `num_step` / `num_steps` / `steps` / `duration`. Default response
is 24 kHz 16-bit mono WAV (or raw little-endian f32 with
`X-Sample-Rate: 24000`, `X-Sample-Format: f32le` headers).

**Gap (load-bearing for the freeze):** The route accepts the `voice`
field "for OpenAI shape compatibility" but does **not** thread it
through to `params.instruct` or `params.ref_audio_tokens`. See
`server-omnivoice-route.mjs:266-268`: *"'voice' is accepted for OpenAI
shape compatibility; the Eliza-1 bundle ships one default voice preset,
so it is informational only until per-voice presets are wired into
omnivoice-core."* I6 must close this gap before the freeze ships.

### 2.3 `packages/app-core/src/services/local-inference/voice/pipeline-impls.ts`

The path the user listed does not exist — `packages/app-core/` no longer
houses the voice runtime. The live file lives at
`/home/shaw/milady/eliza/plugins/plugin-local-inference/src/services/voice/pipeline-impls.ts`
(317 lines). It implements `MissingAsrTranscriber`,
`LlamaServerDraftProposer`, `LlamaServerTargetVerifier` — the
draft/verify side of the fused mic→speech graph. **It does not call
`ttsSynthesize` directly** — that lives in
`engine-bridge.ts` (loads the speaker preset via
`SpeakerPresetCache` and calls `ffi.ttsSynthesize({ ctx, text,
speakerPresetId, out })` or `ffi.ttsSynthesizeStream(...)`).

The FFI itself (`ffi-bindings.ts:849-869`) builds the call as:

```ts
ttsSynthesize({ ctx, text, speakerPresetId, out }) {
  // ...
  const rc = lib.symbols.eliza_inference_tts_synthesize(
    ctx, textArg.ptr, BigInt(textArg.bytes), speakerArg.ptr,
    ffi.ptr(out), BigInt(out.length), err.ptr);
  // ...
}
```

And the C bridge (`omnivoice-fuse/prepare.mjs:695-724`) does:

```cpp
ov_tts_params params;
ov_tts_default_params(&params);
eliza_apply_tts_env_overrides(&params);
params.text = text_owned.c_str();
params.instruct = speaker_preset_id ? speaker_preset_id : "";
// NEVER sets params.ref_audio_tokens / ref_T / ref_audio_24k / ref_text
```

So today `speakerPresetId="samantha"` arrives at OmniVoice as
`params.instruct="samantha"` — which fails VoiceDesign validation
because `"samantha"` is not in the closed VoiceDesign vocabulary. The
runtime currently survives because the engine bridge passes
`ffiSpeakerPresetId(preset)` which returns `null` for the default
voice (`engine-bridge.ts:109-111`), and `null` → `params.instruct = ""`
→ OmniVoice falls back to "auto voice" mode. The
`voice-preset-default.bin` payload (256 fp32 + phrase seed) is loaded
JS-side, *but never crosses the FFI boundary* into the synthesis path.

### 2.4 Shipped GGUF in `~/.eliza/local-inference/models/*.bundle/`

Verified on this machine:

```
~/.eliza/local-inference/models/eliza-1-1_7b.bundle/
├── tts/
│   ├── omnivoice-base-Q4_K_M.gguf       407,485,216 B (388 MiB)
│   └── omnivoice-tokenizer-Q4_K_M.gguf  252,474,112 B (240 MiB)
├── cache/
│   └── voice-preset-default.bin         1,052 B  (header + 256 fp32 zeros + N=0 phrases)
├── eliza-1.manifest.json
└── lineage.json
```

`omnivoice-base-Q4_K_M.gguf` and `omnivoice-tokenizer-Q4_K_M.gguf` are
**real OmniVoice GGUF files** (GGUF v3, magic `GGUF\x03`). Lineage
(`lineage.json`):

```json
"voice": {
  "base": "Serveurperso/OmniVoice-GGUF@361609388ae572a820d085185bbbe2a2aac4b30e",
  "license": "apache-2.0"
}
```

The 0_6b bundle ships the same TTS pair. **The voice-preset is a
placeholder** — `embedding = [0]*256`, `phrases = []` (verified by
hex-reading the file: bytes 24..1047 are all 0x00).

---

## 3. Freeze plan — concrete, executable

### 3.1 What "freeze to samantha" actually means here

Given §1.3, "freeze" → **produce a canonical, frozen `(instruct,
ref_audio_tokens, ref_text)` triple for samantha and persist it as a
distributable artifact**. This is the v1 freeze. No graph surgery.

The artifact target: `~/.eliza/local-inference/models/<bundle>/cache/voice-preset-samantha.bin`
in the existing v1 `ELZ1` format (see §3.2 below). Selection via
`speakerPresetId = "samantha"` on the FFI, or `voice: "samantha"` on
the HTTP route once wired.

### 3.2 Format extension — `ELZ1` v2

The existing v1 format (`voice-preset-format.ts:1-23`) carries:

```
+0  magic 'ELZ1'
+4  version=1
+8/12  embedding section (offset, length)
+16/20 phrase-cache seed section (offset, length)
+24 ...  Float32 embedding vector
+...     phrase seed records
```

Two problems for OmniVoice:

1. The `embedding` slot was specced for a *learned speaker embedding*
   (a fixed-dim fp32 vector). OmniVoice does not use one. The right
   payload for OmniVoice is the **reference audio-token tensor**:
   `int32[K=8, ref_T]` (typically `K=8, ref_T ≈ 1500` for a 30 s clip
   at 50 Hz → 6000 i32 = 24000 bytes), plus the reference *transcript*
   text, plus the *instruct* string the encoder picked.
2. v1 has no field for an instruct string or transcript.

**Recommendation for I6:** Bump format to `ELZ2`, additive layout (v1
parser stays valid as a fallback for older bundles):

```
+0    magic 'ELZ1'           ('ELZ2' bumps version, magic stays)
+4    version=2
+8/12 embedding_section       (kept for back-compat / Kokoro-style speaker emb)
+16/20 phrase_section         (kept — first-sentence cache seed)
+24/28 ref_audio_tokens_section
+32/36 ref_text_section
+40/44 instruct_section
+48/52 ref_audio_24k_section   (optional raw PCM, for re-encode determinism)
+56/60 metadata_section        (JSON; codec sha256, source corpus hash, etc.)
+64 ...  payloads
```

JS-side: extend `voice-preset-format.ts` to round-trip both v1 and v2.
C-side: extend the FFI to accept a `speaker_preset_blob` pointer + length
(or, simpler, have `ov_init` load the preset from a known relative path
under `bundle_dir/cache/voice-preset-{id}.bin` when `speaker_preset_id`
is not a VoiceDesign attribute string).

### 3.3 Step-by-step freeze procedure

This is what I6 must execute end-to-end. Each step is small.

1. **Land the samantha corpus** (R12 owns `/tmp/ai_voices`; I11 will
   stage under `packages/training/data/voice/samantha/`). Per R12:
   58 WAV/transcript pairs, ~210 s total, 44.1 kHz mono 16-bit.
2. **Resample to 24 kHz mono fp32.** The OmniVoice tokenizer
   internally resamples 24 k → 16 k for HuBERT but the codec expects
   24 k PCM at the boundary (`hubert-enc.h:13`). Use the existing
   audio-resample utility under `omnivoice/src/audio-resample.h`.
3. **Concatenate or pick a representative reference clip.** OmniVoice
   accepts up to ~30 s of reference. For samantha, pick the 1–2
   longest clean clips and concatenate to a total ≤30 s; persist a
   normalized text transcript (Whisper-base auto-transcripts will need
   manual cleanup for the flagged `samantha_002.txt` per R12).
4. **Run `ov_synthesize` once in "encode-only" mode** to pull the
   reference audio tokens back out. Today `ov_synthesize` does
   not expose that — it consumes `ref_audio_24k` and runs the codec
   internally. **Wire a new entry `ov_encode_reference`** in
   `omnivoice.h` / `omnivoice.cpp` that runs only the
   `pipeline_codec_encode` half (`pipeline-codec.h`) on a PCM buffer
   and returns `int32_t * tokens, int * K, int * ref_T`. This is a
   small refactor — the encode path already exists for the cloning
   loop; just split the entrypoint. Effort: **S**.
5. **Persist** the `(K=8, ref_T)` tensor + `ref_text` + a chosen
   `instruct` string (best guess: `"female, young adult, american
   accent, moderate pitch"` based on samantha's voice character;
   confirm with `pipeline_tts_resolve_instruct` against VoiceDesign)
   into `voice-preset-samantha.bin` (ELZ2 format).
6. **Wire the FFI bridge** to:
   - Detect `speaker_preset_id` is a *bundled preset id* (file exists
     at `<bundle_dir>/cache/voice-preset-<id>.bin`), not a VoiceDesign
     string.
   - Load + cache the preset payload at `ov_init` time (the context
     already holds `ctx->bundle_dir`).
   - Set `params.instruct`, `params.ref_audio_tokens`, `params.ref_T`,
     `params.ref_text` from the preset before the call.
7. **Wire the HTTP route**: `server-omnivoice-route.mjs` already
   parses `voice`; extend it to honor `voice = "samantha"` by reading
   the same preset file and threading it into `ov_tts_params` (same
   logic as step 6, server-side instead of FFI-side).
8. **Regenerate the per-bundle manifest** so it lists the new preset
   file with sha256 + size, and the auto-update path (R5) ships the
   preset alongside the GGUFs.
9. **Smoke-test** via `tts-stream-ffi-smoke.ts --speaker samantha` and
   the existing TTS bench harness. Pass criterion: TTS produces
   speech with samantha-like timbre across at least three out-of-domain
   sentences (manual A/B against the original samantha clips +
   speaker-similarity cosine ≥ 0.65 via ECAPA — the same R7 Kokoro
   gate).

### 3.4 The "drop the conditioning input" variant — feasibility

The user prompt also requested investigating "drop the conditioning
input head from the graph". As established in §1.3 there is no
separable input head, but we can still **constant-fold** the instruct
slice for samantha into the LM input embedding:

- **Cost today:** computing the instruct embedding is one
  `embed_tokens @ instruct_ids` matmul per call, ~7–20 tokens × H=1024
  → ~7–20 KB of mat-vec at Q4_K_M. **Tens of microseconds.** Negligible
  next to the 32-step MaskGIT decode (~50–200 ms RTF on a 5-second
  utterance).
- **Surgery:** add a `frozen_prefix_embed` tensor to the GGUF (shape
  `[H, N_style]`), have `pipeline_tts_llm_forward` skip style-token
  embedding for samantha-locked variants, splice the precomputed
  prefix in.
- **Verdict:** **defer**. Not worth the complexity. The right surgery
  if we ever want a tiny single-voice-only OmniVoice is to **distill**
  the singing model down (smaller Qwen3, dropped audio codebooks
  6–7) — a multi-week effort, not a freeze pass.

### 3.5 Parameter count + RTF estimates

- **Current shipped (Q4_K_M):** LM 407 MB + codec 252 MB = **~660 MB
  resident** (+ MaskGIT scratch + RVQ codebooks pinned at F32 ~ +50 MB).
  On macOS Metal M1/M2 with the current Metal pin and `chunk_threshold_sec=30`,
  `tts-stream-ffi-smoke.ts` reports RTF ~0.15-0.3 for short utterances
  (per `omnivoice-fuse/README.md:272-280` and the latency probe in
  README §"Streaming-cancel note").
- **Frozen samantha (preset-based, no graph change):** **No parameter
  count change** — same 0.6B + 0.4B GGUF. Speed change: a samantha-
  presetted call skips Steps 1–3 of voice-design resolution
  (`pipeline_tts_resolve_instruct`) on every turn → save ~50 µs. The
  ref_audio prefix adds Sref ≈ 1500 audio frames to the sequence,
  which extends each MaskGIT forward by ~3000 tokens × 28 layers (the
  cond row is N1+N2+Sref+Stgt = ~1900 → 3400 with Sref=1500). That's
  **slower by ~30-50%** vs the auto-voice path that uses no reference.
- **Net RTF impact:** preset-based freeze **slows** TTS slightly (more
  context per step). The win is consistency, not speed. To recoup,
  combine with QJL-K + PolarQuant-V on the bidir attention (next
  section), MaskGIT step reduction (32 → 16 or 8 with the singing
  model's stronger learned schedule), and the cold-start savings from
  the existing first-sentence LRU cache (R4).
- **Embed-bake variant (deferred):** saves ~7–20 KB of matmul per
  call. Real-world: ~10 µs. Lost in noise.

---

## 4. llama.cpp port feasibility — actual status

### 4.1 What's already in our fork

`plugins/plugin-local-inference/native/llama.cpp/omnivoice/` (46 files,
verified). Sources broken out by area:

- **Public ABI** (`omnivoice.h`, `omnivoice.cpp`, `ffi.h`,
  `eliza-inference-ffi.cpp`)
- **TTS pipeline** (`pipeline-tts.h/cpp`, 1437 lines + 178 lines):
  LM weights, scheduler, full MaskGIT loop entry.
- **Codec pipeline** (`pipeline-codec.h/cpp`): RVQ + DAC stages.
- **LM model** (`omnivoice-llm.h`, `qwen3-enc.h`): Qwen3 backbone +
  audio embedding/heads. **Loads via the in-tree ggml**, NOT via
  llama.cpp's model loader — this is a separate GGML-graph build over
  the fused weights, sharing only `ggml.h` symbols with llama.cpp.
- **MaskGIT decoder** (`maskgit-tts.h`): cosine timesteps, top-k
  filter, Gumbel sampling via Philox, CFG cond+uncond batch.
- **Codec components** (`dac-decoder.h`, `dac-encoder.h`,
  `hubert-enc.h`, `semantic-enc.h`, `rvq-codec.h`): each with its own
  `*_load` + graph builder.
- **Prompt + tokenizer** (`prompt-tts.h`, `bpe.h`, `voice-design.h`,
  `lang-map.h`).
- **Audio I/O** (`audio-io.h`, `audio-resample.h`, `audio-postproc.h`,
  `audio-postproc-stream.h`, `wav.h`).
- **Streaming + chunking** (`text-chunker.h`, `text-chunker-stream.h`,
  `duration-estimator.h`).
- **Support** (`backend.h`, `gguf-weights.h`, `weight-ctx.h`,
  `philox.h`, `debug.h`, `ov-error.h`, `version.h`).
- **Tools** (`tools/omnivoice-tts.cpp`, `tools/omnivoice-codec.cpp`,
  `tools/quantize.cpp`).

### 4.2 Op-set audit — what OmniVoice needs vs. what our ggml has

Cross-referenced `omnivoice/src/*.h` against the in-tree
`ggml/include/ggml.h` of our fork. **Every op OmniVoice uses is
already in upstream llama.cpp's ggml**; the ServeurpersoCom fork's
two custom ops (snake, col2im_1d) are emulated via existing ops in
the graft port.

| OmniVoice op | Implementation in our fork | Status |
| --- | --- | --- |
| Mat-mul, add, mul | `ggml_mul_mat`, `ggml_add`, `ggml_mul` | ✓ |
| Reshape, view, permute, cont | `ggml_reshape_{2,3,4}d`, `ggml_view_{2,3}d`, `ggml_permute`, `ggml_cont` | ✓ |
| RMSNorm | `ggml_rms_norm` | ✓ |
| LayerNorm | `ggml_norm` | ✓ |
| GroupNorm | `ggml_group_norm` (HuBERT layer 0) | ✓ |
| Soft-max + mask | `ggml_soft_max_ext` | ✓ |
| Flash attention | `ggml_flash_attn_ext` (bidirectional path — mask must be supplied; the F32 fallback `qwen3_attn_f32` is wired for non-FA builds) | ✓ |
| RoPE NeoX | `ggml_rope_ext` mode=2 (`qwen3-enc.h:185`) | ✓ |
| GELU | `ggml_gelu` | ✓ |
| SwiGLU | `ggml_swiglu`, `ggml_swiglu_split` (`qwen3-enc.h:227-231`) | ✓ |
| Sin / sqr (for snake) | `ggml_sin`, `ggml_sqr` (`dac-decoder.h:303-307`) | ✓ |
| Conv1d / pool / im2col | `ggml_conv_1d`, `ggml_im2col`, `ggml_pool_1d` | ✓ |
| **ConvTranspose1d (col2im_1d)** | `ggml_conv_transpose_1d` (`dac-decoder.h:342` — *"The upstream omnivoice fork used a private col2im_1d op with padding. We use the stock ggml_conv_transpose_1d."*) | ✓ |
| Clamp (FP16 stability) | `ggml_clamp` | ✓ |
| Cast | `ggml_cast` | ✓ |
| ggml_get_rows (for embed_tokens, audio_embeddings) | `ggml_get_rows` — with the K-quant restriction baked into `quantize.cpp:84-89` (embeddings pinned to F32/F16/BF16/Q4_0/Q4_1/Q5_0/Q5_1/Q8_0; NOT K-quants on CUDA) | ✓ |

**Custom ops we'd add (none needed today):** zero. The graft already
side-stepped the ServeurpersoCom-private ops. The two cases that
look like new ops in the upstream are:

1. **Snake activation**: the graft uses naive `mul → sin → sqr →
   mul → add` (5 ops, `dac-decoder.h:303-307`). The README comment
   notes "the GGML backend autofuse pass rewrites it into the
   dedicated fused snake kernel where available"
   (`dac-decoder.h:31`). On Metal/Vulkan/CUDA today there is **no
   fused snake** in our ggml — and we don't need one. The 5-op chain
   runs end-to-end on every backend without modification.
2. **col2im_1d**: replaced by stock `ggml_conv_transpose_1d` with
   load-time weight repacking (`dac-decoder.h:51-62`). The "weight
   layout repack" is done once at load, not per-call.

**Would adding a fused snake kernel help?** Maybe a small win on the
DAC vocoder decode (5 kernel launches → 1 per snake call × hundreds
of calls per second of audio = some launch-overhead savings on
Vulkan/Metal where launch is expensive). Effort: **M** (3 backends
to write + verify). Reward: ~5-10% off DAC decode latency, which is
already a small fraction of total RTF. **Defer to I8 as a quant /
kernel optimization pass, not part of the freeze.**

### 4.3 Quantization compatibility — per weight class

`omnivoice/tools/quantize.cpp` already implements a layered policy
(verified at `quantize.cpp:79-147`):

| Weight class | Pinning | Reasoning |
| --- | --- | --- |
| `embed_tokens.weight`, `audio_embeddings.weight` | Q6_K (configurable; falls back to F32/F16/Q8_0 on CUDA per `is_embed` rule) | ggml_get_rows in CUDA does not support K-quants except for Q6_K embed type when the kernel supports it. |
| `quantizer.quantizers.*` (RVQ codebooks) | **F32, no quantization, ever** | Nearest-neighbor lookup sensitivity. Q8_0 / K-quants break ref encoding entirely. |
| `fc.weight`, `fc2.weight` (linear projections wrapping RVQ) | **F32, no quantization** | Same RVQ sensitivity. |
| `snake1.alpha`, `snake2.alpha` | F32 | Per-channel activation parameter, not a weight; widened to F32 on load. |
| `*v_proj.weight`, `*down_proj.weight` (and `*o_proj.weight` in L variant) | "bump" to one tier higher (Q5_K_M variant: Q5_K → Q6_K) | Same as standard llama.cpp Q*_K_M tier policy. |
| All other 2-D LM weights | Variant default (Q4_K, Q5_K, Q6_K, Q8_0) | Standard. |
| Conv kernels | F16 fallback when the row width does not divide the variant block size (kernel K=7,3,1 don't fit Q-block alignment) | ARM im2col strict requirement; documented at `quantize.cpp:96-99`. |
| VAE-arch tensors (any tensor in a sub-model declared `vae` in the GGUF arch metadata) | **No quantization, F32 only** | Same as ace-step policy. |
| `silence_latent`, `scale_shift_table`, `null_condition_emb` | F32 | Sensitive small tensors. |

**This is correct and complete for OmniVoice today.** No change needed
for the freeze. The only consequence: a "frozen samantha" GGUF is the
same shape and same quant policy as today's `omnivoice-base-Q4_K_M.gguf`
— so we don't need a new quant pass for the freeze itself; the preset
file is the only new artifact.

### 4.4 Final port recommendation

- **Do it / defer / partial-port:** **Already done.** No further port
  work is required to make OmniVoice run inside llama.cpp / ggml /
  the fused server. The work that LOOKS like "porting" — adding
  custom ops — was avoided up-front by the graft author by mapping
  the two ServeurpersoCom-fork ops onto existing ggml ops.
- **Remaining gaps before this is "first-class on every device tier":**
  1. **Vulkan backend**: kernels need cross-verification for the
     bidirectional attention pattern (no causal mask). The Metal +
     CPU paths are verified per `omnivoice-fuse/README.md:265-281`
     ("tts_stream_supported()==1"). Vulkan + CUDA paths need the
     same 8/8 PASS proof on real hardware. Effort: **M** per backend.
  2. **DFlash spec-decode** is text-LM-specific. OmniVoice is
     MaskGIT (non-AR), so DFlash does not apply directly. The
     existing DFlash kernels do not need to be re-validated against
     OmniVoice; they share the build but not the path.
  3. **QJL K-cache / PolarQuant V-cache for the LM attention**: the
     OmniVoice LM is bidirectional (every step is a full forward, no
     KV reuse across steps), so the V-cache PolarQuant kernel does
     not apply at all (no cache). QJL-K could apply to the *intra-
     forward* K matrix during the soft-max; this would need a small
     verify pass against the existing kernels. **Net win likely
     small** because the forward is short (~few hundred tokens) and
     the matmul cost dominates, not the K transfer. **Defer to I8.**

---

## 5. Quantization recipes — what apply to OmniVoice

### 5.1 GGUF Q*_K_M (already supported)

Per `omnivoice/tools/quantize.cpp`, the following variants exist and
work today against the OmniVoice GGUF pair:

- **Q2_K** (Q2_K base + Q4_K bump + Q6_K embed, bump first 4 layers)
- **Q3_K_S / Q3_K_M / Q3_K_L**
- **Q4_K_S / Q4_K_M** ← shipped default
- **Q5_K_S / Q5_K_M**
- **Q6_K**
- **Q8_0**

Recommended ladder for the freeze artifact:

| Device tier | Variant | Reason |
| --- | --- | --- |
| Mobile (≤8 GB RAM) | Q4_K_M (407 + 252 = 660 MB) | Current default. Quality acceptable. |
| Desktop (≥16 GB) | Q5_K_M or Q6_K | Reduce stage-2 emotion drift on the singing variant. |
| Server / reference | Q8_0 | Match upstream Serveurperso reference behavior; +diff probe vs PyTorch reference. |
| Eval / regression baseline | BF16 | RVQ-clean reference for `tests/*-cossim.py`. |

### 5.2 PolarQuant — `q4_polar` weights, V-cache

- **Weights:** `Q4_POLAR` (slot 47, per AGENTS.md §4) applies the same
  way it does to any Qwen3 attention/MLP weight set — same `q_proj /
  k_proj / v_proj / o_proj / gate_up / down_proj` shapes. Effort to
  add OmniVoice to the polarquant pipeline: **S** — re-run
  `packages/training/scripts/.../polarquant_*.py` against the
  OmniVoice LM GGUF and verify the resulting tensor-row distributions
  fit the polar centroids. The codec GGUF should NOT be polar-quanted
  (RVQ + projections are F32-pinned per §4.3).
- **V-cache:** **does not apply** to OmniVoice. The LM has no KV
  cache between MaskGIT steps. Record this in `quantization/`
  per-bundle metadata so the runtime doesn't try to wire V-cache
  PolarQuant on it.

### 5.3 TurboQuant — `turbo3 / turbo4 / turbo3_tcq`

- **Weights:** applies to the same Qwen3 LM attention/MLP. Same shape
  prerequisites as the text LM. **Effort: S** to add to the existing
  turboquant pipeline. Verify against the per-row distribution
  statistics already collected for Qwen3-1.7B; OmniVoice's 0.6B has
  similar architecture, so the centroid set should transfer.
- **Codec:** not applicable (RVQ-pinned).

### 5.4 QJL — `block_qjl1_256`, K-cache

- **Weights:** does not apply (QJL is a K-cache projection, not a
  weight quant).
- **K-cache:** OmniVoice's LM has **no KV cache between MaskGIT
  steps**, but does have a one-shot K matrix per forward inside
  the soft-max (`ggml_soft_max_ext`). QJL-K can apply per-forward,
  but the benefit is small because the sequence is short (~few
  hundred tokens after bidir attention with cond + uncond) and the
  K transfer cost is not the bottleneck. **Effort to verify:** **M**
  (one kernel re-cert with bidirectional masks, since QJL was
  validated on causal masks). **Verdict:** defer; let R8 / I8 decide
  whether to bring it in.

### 5.5 DFlash speculative decoding

- **Not applicable.** MaskGIT is non-AR; no draft-and-verify loop.
  The text-LM DFlash drafter remains hot in the same process; it
  doesn't share KV with OmniVoice.

### 5.6 Per-component summary

| Component | polarquant-W | turboquant-W | QJL-K | PolarQuant-V | GGUF Q*_K_M | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | --- |
| OmniVoice LM (Qwen3-0.6B, 28L bidir) | ✓ | ✓ | conditional (verify cycle) | ✗ (no KV cache) | ✓ (Q4–Q8 ladder) | Same shape as text LM. |
| DAC decoder (`omnivoice-tokenizer-*.gguf`) | ✗ | ✗ | ✗ | ✗ | ✓ (with the F32 pinning) | RVQ + projections F32 only. |
| HuBERT semantic encoder | ✗ | ✗ | ✗ | ✗ | ✓ | Same F32 pinning policy as the DAC; 12-layer encoder is small. |
| RVQ codebooks | ✗ | ✗ | ✗ | ✗ | F32 only | Nearest-neighbor lookup sensitivity. |
| Audio embeddings / heads | ✗ | ✗ | n/a | n/a | Q6_K (embed type) | Forced via `is_embed` rule in quantize.cpp. |
| Snake alpha parameters | ✗ | ✗ | n/a | n/a | F32 | Per-channel activation; widened on load. |

---

## 6. Concrete files to touch for I6

### 6.1 In-tree edits

| File | Change | Effort |
| --- | --- | :-: |
| `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/omnivoice.h` | Add `ov_encode_reference(ov, pcm_24k, n_samples, out_tokens, out_K, out_ref_T)` to the public ABI. | S |
| `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/omnivoice.cpp` | Implement `ov_encode_reference`. Reuse `pipeline_codec_encode` path. | S |
| `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/pipeline-tts.cpp` | Already loads `params.ref_audio_tokens` / `params.ref_T` — no change. | — |
| `packages/app-core/scripts/omnivoice-fuse/prepare.mjs` (`eliza-inference-ffi.cpp`) | Detect when `speaker_preset_id` is a *bundle preset id* (file `<bundle>/cache/voice-preset-<id>.bin` exists) and load it; set `params.instruct`, `params.ref_audio_tokens`, `params.ref_T`, `params.ref_text`. Keep the VoiceDesign-string path as a fallback. | S |
| `packages/app-core/scripts/omnivoice-fuse/ffi.h` | Bump ABI to v4. Add `eliza_inference_encode_reference(ctx, pcm, n_samples, sample_rate, out_token_ptr, out_K, out_ref_T, out_error)` so the JS side can run the encode step. | S |
| `packages/app-core/scripts/kernel-patches/server-omnivoice-route.mjs` | Replace the "informational only" `voice` handling with: load the bundled preset, pass through to `params.instruct` + `params.ref_audio_tokens`. Stop being polite about it. | S |
| `plugins/plugin-local-inference/src/services/voice/voice-preset-format.ts` | Bump format to v2; add `refAudioTokens`, `refText`, `instruct` sections. Keep v1 read path for back-compat. | S |
| `plugins/plugin-local-inference/src/services/voice/speaker-preset-cache.ts` | Surface the new v2 fields on `SpeakerPreset`. | S |
| `plugins/plugin-local-inference/src/services/voice/types.ts` | Extend `SpeakerPreset` with the v2 fields. | S |
| `plugins/plugin-local-inference/src/services/voice/engine-bridge.ts` | Update `ffiSpeakerPresetId` to **always** pass the voice id (not return `null` for "default"); the C side picks up the preset and applies it. | S |
| `plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts` | Add the new `encodeReference` method against `eliza_inference_encode_reference`. | S |
| `packages/app-core/scripts/voice-preset/build-default-voice-preset.mjs` | Add a `--from-corpus <dir>` mode that scans a corpus directory of WAV+TXT pairs, calls `encodeReference` for the chosen clip, and writes a v2 preset file. (Existing `--placeholder` and `--embedding <vec>` paths remain.) | S |
| `packages/training/data/voice/samantha/manifest.json` (R12 / I11 output) | Already in plan for R12/I11. I6 reads it to pick the reference clip. | — |
| `~/.eliza/local-inference/models/eliza-1-*.bundle/cache/voice-preset-samantha.bin` | Generated artifact. | — |
| `~/.eliza/local-inference/models/eliza-1-*.bundle/eliza-1.manifest.json` | Append the preset to `files.cache[]` with sha256. | S |
| `models/voice/CHANGELOG.md` (per VOICE_WAVE_2.md §5) | New entry: "samantha-v1 frozen preset for OmniVoice; ELZ2 format; sha256=<…>". | S |

### 6.2 New CLI / tooling

A small script under `packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs`
that, given a corpus directory and an OmniVoice GGUF pair, builds the
preset blob:

```
bun packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs \
  --corpus /path/to/samantha \
  --bundle ~/.eliza/local-inference/models/eliza-1-1_7b.bundle \
  --voice-id samantha \
  --instruct "female, young adult, american accent, moderate pitch"
```

### 6.3 Risks

1. **Auto-instruct may not match samantha.** The chosen instruct
   string is a heuristic; the model is more confident about timbre
   from the reference audio than the instruct text. Mitigation:
   omit the instruct (`""`) and rely purely on the reference; OmniVoice
   handles `instruct=""` gracefully (the resolve step returns empty).
2. **Reference length sensitivity.** Too short (<3 s): drifts. Too
   long (>30 s): pushes context past the chunker threshold and
   produces inconsistent prosody across long outputs. Pick a single
   10–20 s reference.
3. **`samantha_002.txt` Whisper hallucination** (per R12). Re-
   transcribe or hand-correct before using as `ref_text`. Wrong
   `ref_text` confuses the LM about which audio tokens correspond to
   which text.
4. **VoiceDesign vocabulary lock.** If we ever want to expose
   per-instruct flavors of samantha ("samantha-happy",
   "samantha-whisper"), they need to combine with the singing
   variant's emotion tags. That's a v2 design conversation, not v1.
5. **ABI bump.** Going to v4 means a new lockstep update in
   `ffi-bindings.ts` and a stub library rebuild. Pay attention to the
   "ABI mismatch refuses to load" path — surface a clean error.
6. **Vulkan / CUDA verification gap.** Per §4.4 step 1, Metal + CPU
   are verified for the existing OmniVoice paths. Adding a per-call
   reference encode does not change kernel shapes, but does mean
   `pipeline_codec_encode` now runs on every TTS turn (it didn't,
   when running in auto-voice mode). Verify that the codec graph
   works under each backend's scheduler — currently the README notes
   the codec scheduler is intentionally pinned to CPU on Apple Metal
   (`omnivoice-fuse/README.md:270-280`) to bypass a known merged-ggml
   stall. Same pinning applies here; document it.
7. **Storage size.** A 15 s samantha reference at K=8, ref_T=750 →
   6000 i32 = 24 KB raw. With the v2 wrapper plus a small phrase-
   cache seed (R4) and the optional raw 16 kHz PCM (`ref_audio_24k`,
   for re-encode determinism if we ever need to regenerate against a
   new codec pin) the preset comes in under ~600 KB. Acceptable.

### 6.4 Effort class

**S** for the entire freeze (preset-based). Distribution:
- C/C++ FFI changes: ~150 lines (the encode entrypoint + preset loader).
- TS/JS changes: ~250 lines (format v2, speaker cache, engine-bridge,
  ffi-bindings, freeze-voice CLI).
- Build / manifest / test: ~100 lines.
- Artifact generation: one CLI run.
- Verification: smoke tests + ECAPA cosine + manual A/B.

The llama.cpp port itself is **already shipped**. Adding fused
snake kernels, K-cache QJL on bidir attention, etc., are **M** each
and **out of scope for I6's "freeze samantha" task** — they're
quant-pipeline follow-ups (R8 / I8).

---

## 7. Citations

External, verified against canonical sources:

- Upstream OmniVoice repo: `https://github.com/k2-fsa/OmniVoice` (README,
  `omnivoice.py` model source).
- Singing variant card: `https://huggingface.co/ModelsLab/omnivoice-singing`.
- Serveurperso GGUF release: `https://huggingface.co/Serveurperso/OmniVoice-GGUF`.
- ServeurpersoCom omnivoice.cpp architecture doc:
  `https://github.com/ServeurpersoCom/omnivoice.cpp/blob/master/docs/ARCHITECTURE.md`.

In-tree, verified by direct read:

- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/omnivoice.h` (public ABI, 263 lines)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/omnivoice-llm.h` (LM struct + load, 110 lines)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/voice-design.h` (VoiceDesign vocabulary + normalisation, 461 lines)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/prompt-tts.h` (prompt + CFG batch builder, 349 lines)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/qwen3-enc.h` (Qwen3 backbone graph builders, 371 lines)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/maskgit-tts.h` (MaskGIT decoder, top of file inspected)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/pipeline-tts.h` (TTS pipeline ABI, 178 lines)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/dac-decoder.h` (DAC vocoder, 419 lines)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/hubert-enc.h` (HuBERT encoder, 691 lines)
- `plugins/plugin-local-inference/native/llama.cpp/omnivoice/tools/quantize.cpp` (quant policy, ~250 lines)
- `packages/app-core/scripts/omnivoice-fuse/README.md` (strategy + ABI table, 388 lines)
- `packages/app-core/scripts/omnivoice-fuse/cmake-graft.mjs` (CMake graft, 284 lines)
- `packages/app-core/scripts/omnivoice-fuse/prepare.mjs` (FFI bridge generator, 1898 lines)
- `packages/app-core/scripts/kernel-patches/server-omnivoice-route.mjs` (HTTP route mount, 501 lines)
- `plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts` (JS FFI loader)
- `plugins/plugin-local-inference/src/services/voice/pipeline-impls.ts` (draft/verify adapters, 317 lines — *note: not the TTS callsite as the prompt suggested; the TTS callsite is `engine-bridge.ts`*)
- `plugins/plugin-local-inference/src/services/voice/speaker-preset-cache.ts` (LRU preset cache)
- `plugins/plugin-local-inference/src/services/voice/voice-preset-format.ts` (ELZ1 binary format)
- `plugins/plugin-local-inference/src/services/voice/engine-bridge.ts` (TTS callsite)
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/eliza-1.manifest.json` (shipped manifest)
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/lineage.json` (upstream pin)
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/cache/voice-preset-default.bin` (placeholder; 1052 B, all-zero embedding)
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/tts/omnivoice-base-Q4_K_M.gguf` (407 MB, GGUF v3)
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/tts/omnivoice-tokenizer-Q4_K_M.gguf` (252 MB, GGUF v3)

---

*R6-omnivoice — research complete.*

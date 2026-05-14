# DAC ConvTranspose1d parity fixture (#7660)

`elizaOS/llama.cpp@78c4fb190` ("tools/omnivoice: migrate dac_conv_t1d to
ggml_conv_transpose_1d") collapsed the 5-step host-side decomposition
inside `tools/omnivoice/src/dac-decoder.h`:

```
transpose → mul_mat → col2im_1d → pad → add_bias
```

into a single `ggml_conv_transpose_1d` call. Compile + shape were
verified at merge time; numerical parity against the pre-merge build
was **not** gated by a test. This fixture closes that gap.

The decoder graph runs `dac_conv_t1d` once per upsampling block (5
blocks), so a deterministic decode through `omnivoice-codec` exercises
every collapsed-op site at once.

## Files

- `dac_conv_t1d_parity.json` — git-tracked metadata + small inline
  prefix samples for fast smoke comparison.
- `dac_conv_t1d_parity.input.rvq` — git-tracked deterministic RVQ
  code blob (synthesized when the capture is bootstrapped without an
  explicit input).
- Baseline WAV — written by the capture script into
  `plugins/plugin-local-inference/native/verify/bench_results/` by
  default (gitignored). The JSON's `baseline_wav_path` points at the
  exact file used.

## Schema (`dac_conv_t1d_parity.json`)

```jsonc
{
  "kernel": "dac_conv_t1d_parity",
  "issue": "elizaOS/eliza#7660",
  "schema_version": 1,
  "notes": "...",
  "codec_gguf_basename": "omnivoice-tokenizer-0.8b.gguf",
  "codec_gguf_repo": "Serveurperso/OmniVoice-GGUF",
  "input_rvq_basename": "dac_conv_t1d_parity.input.rvq",
  "input_rvq_bytes": 132,
  "input_rvq_synthesized": true,
  "input_rvq_k": 8,
  "input_rvq_t": 12,
  "baseline_wav_path": "<absolute path>",
  "baseline_wav_basename": "dac_conv_t1d_parity.baseline.wav",
  "baseline_wav_bytes": 23068,
  "baseline_sample_rate": 24000,
  "baseline_n_samples": 11520,
  "baseline_inline_prefix_samples": 256,
  "baseline_inline_prefix": [/* f32 PCM samples in [-1, 1) */],
  "baseline_build_sha": "<pre-merge llama.cpp SHA>",
  "baseline_build_label": "v1.2.0-eliza",
  "tol_mse": 1e-5,
  "tol_cosine_sim_min": 0.9999,
  "tol_l1_max": 1e-2,
  "generated_at": "<ISO timestamp>"
}
```

The inline prefix lets CI smoke the first 256 samples without needing
the full baseline `.wav` on disk. Full-sample comparison runs when the
test can resolve `baseline_wav_path`.

## Capture (bootstrap against the pre-merge build)

"Pre-merge" means before `elizaOS/llama.cpp@78c4fb190`. The eliza
fork's known-good reference tag is `v1.2.0-eliza`; alternatively any
commit before `79079c25e` ("merge: upstream/master into milady/main")
works. The exact SHA goes into the fixture's `baseline_build_sha`.

```sh
# 1. Check out and build the pre-merge llama.cpp omnivoice-codec
#    (in a SEPARATE worktree — the submodule in this checkout is
#    off-limits per the parent task constraint).
git -C /tmp/llama-baseline clone https://github.com/elizaOS/llama.cpp .
git -C /tmp/llama-baseline checkout v1.2.0-eliza
cmake -B /tmp/llama-baseline/build -S /tmp/llama-baseline \
  -DLLAMA_OMNIVOICE=ON
cmake --build /tmp/llama-baseline/build --target omnivoice-codec -j

# 2. Capture the baseline against a locally cached OmniVoice GGUF.
node plugins/plugin-local-inference/native/verify/gen_dac_parity_fixture.mjs \
  --omnivoice-codec /tmp/llama-baseline/build/bin/omnivoice-codec \
  --codec-gguf "$HOME/.eliza/local-inference/models/eliza-1-2b.bundle/tts/omnivoice-tokenizer-0.8b.gguf" \
  --baseline-build-sha "$(git -C /tmp/llama-baseline rev-parse HEAD)" \
  --baseline-build-label "v1.2.0-eliza"
```

The script writes the JSON + input `.rvq` blob into this directory and
the baseline `.wav` into the gitignored `verify/bench_results/` dir.

## Companion test

`plugins/plugin-local-inference/__tests__/dac-parity.test.ts` loads
the JSON, runs the current `omnivoice-codec` against the same input
`.rvq`, and asserts:

- `mse(current, baseline) <= tol_mse`
- `cosine_sim(current, baseline) >= tol_cosine_sim_min`
- `max(|current - baseline|) <= tol_l1_max`

When the JSON is absent (no capture yet) or the referenced baseline
WAV / current `omnivoice-codec` cannot be located, the test skips with
a clear message — CI never fails for a missing capture.

Override knobs the test honors:

- `OMNIVOICE_CODEC` — path to the current `omnivoice-codec` binary.
- `OMNIVOICE_TOKENIZER_GGUF` — path to the codec GGUF.
- `DAC_PARITY_FIXTURE` — override the JSON path.

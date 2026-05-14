# omnivoice fetch CLI

User-facing entry point for staging the GGUFs that
`@elizaos/plugin-omnivoice` auto-detects at agent boot.

## Quick start

```bash
# Singing model — fully automated end-to-end (HF download + convert + quantize).
node scripts/inference/omnivoice-fetch.mjs --singing --quantize Q8_0

# Speech model — manual staging (see "Speech variant" below).
node scripts/inference/omnivoice-fetch.mjs --variant speech --quantize Q8_0
```

After the script finishes, the plugin discovers the artifacts under the
conventional path:

```
<state-dir>/models/omnivoice/speech/   omnivoice-base-*.gguf + omnivoice-tokenizer-*.gguf
<state-dir>/models/omnivoice/singing/  omnivoice-singing-base-*.gguf + omnivoice-singing-tokenizer-*.gguf
```

`<state-dir>` defaults to `$MILADY_STATE_DIR` / `$ELIZA_STATE_DIR` /
`~/.milady`. Override with `--state-dir <path>`.

## Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--variant <speech\|singing>` | `speech` | Which model family to fetch. |
| `--singing` | — | Shortcut for `--variant singing`. |
| `--quantize <type>` | `Q8_0` | One of `none`, `F16`, `BF16`, `Q8_0`, `Q4_K_M`. |
| `--state-dir <path>` | env or `~/.milady` | Per-user state root. |
| `--out-dir <path>` | `<state-dir>/models/omnivoice/<variant>` | Override target dir. |
| `--hf-cache <path>` | `<out-dir>/.hf-cache` | Where huggingface-cli writes safetensors. |
| `--dry-run` | — | Print plan; do not execute. |
| `-h`, `--help` | — | Show usage. |

## Singing variant

Delegates to `scripts/inference/convert-omnivoice-singing.mjs`, which:

1. Probes `python3` (>= 3.10) + `huggingface-cli` + `numpy` / `gguf` /
   `safetensors`.
2. Downloads `ModelsLab/omnivoice-singing` into the HF cache.
3. Runs `packages/inference/omnivoice.cpp/convert.py` against the
   checkpoint.
4. Renames the outputs to `omnivoice-singing-base-F32.gguf` +
   `omnivoice-singing-tokenizer-F32.gguf`.
5. Optionally quantizes the base via the omnivoice.cpp `quantize` binary.
6. Writes a `manifest.json` with sha256 + sizes.

Pre-reqs:

- Python >= 3.10 with `numpy`, `gguf`, `safetensors` (the script prints
  the exact `pip install` line if anything is missing).
- `huggingface-cli` (`pip install --user --upgrade huggingface_hub`).
- For `--quantize` != `none`: the omnivoice.cpp `quantize` binary built
  at `packages/inference/omnivoice.cpp/build/quantize`.

## Speech variant

The speech wrapper is **not yet automated end-to-end**. Two ways to
stage artifacts today:

1. **Drop in pre-built GGUFs.** Copy `omnivoice-base-*.gguf` and
   `omnivoice-tokenizer-*.gguf` into
   `<state-dir>/models/omnivoice/speech/`. Discovery picks the
   highest-quality build it finds (Q8_0 / Q4_K_M / BF16 win the tie over
   F32).
2. **Use the singing model for both codepaths.** If you only ran
   `--singing`, the plugin's `loadSettings()` fallback chain uses the
   singing codec for speech as well, so non-singing TTS still works.

The full speech wrapper (`ModelsLab/omnivoice-base` HF pull + convert.py
+ quantize, mirroring the singing path) is tracked as a follow-up.

## How discovery works

`plugin-omnivoice/src/discover.ts` does a sync, network-free scan:

- Files containing `tokenizer` or `codec` (case-insensitive) → codec path.
- Files containing `base` or `model` → LM path.
- Extension must be `.gguf`.
- Both files required per variant; otherwise that variant is reported
  as `null` and a warning is logged.

`auto-enable.ts` activates the plugin when:

- `OMNIVOICE_MODEL_PATH` + `OMNIVOICE_CODEC_PATH` are set, **or**
- `features.localTts` / `features.tts.provider = "omnivoice"` is set, **or**
- Discovery finds a valid speech pair under `<state-dir>/models/omnivoice/speech/`.

Set `OMNIVOICE_AUTO_DETECT=0` to disable the filesystem fallback.

## Sanity check

```bash
node scripts/inference/omnivoice-fetch.mjs --help
node scripts/inference/omnivoice-fetch.mjs --singing --dry-run
```

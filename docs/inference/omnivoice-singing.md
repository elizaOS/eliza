# OmniVoice singing model — conversion + hosting plan

The `ModelsLab/omnivoice-singing` checkpoint adds singing and emotion
tags (`[singing]`, `[happy]`, `[sad]`, `[angry]`, `[nervous]`,
`[whisper]`, `[calm]`, `[excited]`) to the base
[`k2-fsa/OmniVoice`](https://huggingface.co/k2-fsa/OmniVoice) model.
It ships as Hugging Face safetensors (I64 / F32, ~0.6B params) and
must be converted to the GGUF pair that
[omnivoice.cpp](../../packages/inference/omnivoice.cpp/README.md) and
[plugin-omnivoice](../../plugins/plugin-omnivoice/RESEARCH.md) consume.

This page covers:

1. The one-command conversion via the bundled wrapper.
2. The expected outputs, disk usage, and runtime cost.
3. Where the converted artifact will be mirrored so end users do not
   need a Python toolchain on first run.
4. License terms inherited from the upstream model + training data.
5. How to wire the resulting GGUFs into plugin-omnivoice.

## 1. One-command conversion

```bash
node scripts/inference/convert-omnivoice-singing.mjs \
  --out-dir ~/.milady/models/omnivoice/singing \
  --quantize Q8_0
```

Flags (full list via `--help`):

| Flag | Default | Notes |
| --- | --- | --- |
| `--out-dir <path>` | `~/.milady/models/omnivoice/singing` | Final destination for GGUFs + `manifest.json`. |
| `--hf-cache <path>` | `<out-dir>/.hf-cache` | Where `huggingface-cli` stores the safetensors download. Re-used on re-runs. |
| `--quantize <type>` | `Q8_0` | One of `none`, `F16`, `BF16`, `Q8_0`, `Q4_K_M`. `none` keeps F32 only. |
| `--dry-run` | _off_ | Prints the plan and exits. Use to sanity-check before a long download. |

Prerequisites (the script probes and prints actionable install
instructions if any are missing):

- Python `>= 3.10` in `PATH`.
- `pip install --user --upgrade huggingface_hub numpy gguf safetensors`.
- `huggingface-cli login` (the model is public but a token raises the
  per-IP rate limit; required for the eventual upload step).
- A built `omnivoice.cpp` if `--quantize` is anything other than
  `none` — the wrapper calls
  [`packages/inference/omnivoice.cpp/build/quantize`](../../packages/inference/omnivoice.cpp/quantize.sh).
  Build it first with `./packages/inference/omnivoice.cpp/buildcpu.sh`
  (CPU) or one of the GPU-specific scripts.

## 2. What gets produced

After a successful run the out-dir contains:

```
omnivoice-singing-base-F32.gguf            ~2.46 GB   Reference base, always written.
omnivoice-singing-base-<QUANT>.gguf        varies     Only if --quantize != none.
omnivoice-singing-tokenizer-F32.gguf       ~0.73 GB   Higgs Audio v2 codec, kept at F32.
manifest.json                              <1 KB      sha256 + byte size per file.
```

Approximate sizes per quant (mirrors the
[`Serveurperso/OmniVoice-GGUF`](https://huggingface.co/Serveurperso/OmniVoice-GGUF)
non-singing release):

| Quant | Base size | Tokenizer size |
| --- | --- | --- |
| F32 | ~2.46 GB | ~0.73 GB |
| BF16 | ~1.23 GB | ~0.37 GB |
| Q8_0 | ~656 MB | ~289 MB |
| Q4_K_M | ~407 MB | ~252 MB |

Disk peak during conversion: roughly `2 * F32-size` (download +
intermediate). Wall-clock on an M-series Mac: ~3 minutes for the HF
download on a fast link, ~30 seconds for `convert.py`, ~10 seconds per
quant pass.

`manifest.json` shape:

```json
{
  "schema": 1,
  "model": "ModelsLab/omnivoice-singing",
  "convertedAt": "2026-05-12T00:00:00.000Z",
  "files": [
    { "name": "omnivoice-singing-base-Q8_0.gguf", "bytes": 687194767, "sha256": "..." },
    { "name": "omnivoice-singing-tokenizer-F32.gguf", "bytes": 770178048, "sha256": "..." }
  ]
}
```

The Milady runtime downloader (see
[`packages/app-core/src/services/local-inference/downloader.ts`](../../packages/app-core/src/services/local-inference/downloader.ts))
can verify a mirror download against this manifest before swapping the
file into `~/.milady/models/`.

## 3. Milady mirror plan

End users should not need Python + `transformers` to use the singing
voice. We will publish the converted GGUFs to a Milady-controlled mirror
so the regular GGUF downloader can fetch them like any other model.

### Recommended: Hugging Face mirror under `elizaOS/`

```bash
# One-time: create the mirror repo
huggingface-cli repo create OmniVoice-Singing-GGUF --type model --organization elizaOS

# Upload the converted artifact
huggingface-cli upload \
  elizaOS/OmniVoice-Singing-GGUF \
  ~/.milady/models/omnivoice/singing \
  . \
  --repo-type model \
  --commit-message "Convert ModelsLab/omnivoice-singing -> GGUF (base Q8_0 + tokenizer F32)"
```

Tradeoffs:

- **HF mirror (preferred).** Inherits HF's CDN, range-request support
  (resumable downloads work out of the box with the existing Node
  downloader), and discoverability. Same path users already trust for
  `Serveurperso/OmniVoice-GGUF`. Free for public models. License must
  be set to Apache 2.0 and the README must reproduce the dataset
  restrictions in section 4 below.
- **Cloudflare R2 / S3 bucket.** Cheaper at scale and avoids HF rate
  limiting, but loses range-request resume unless the bucket is
  fronted by a CDN that supports it, and forces us to operate a
  separate model index. Use only if HF rate limiting becomes a real
  problem in production telemetry.
- **GitHub releases.** Hard 2 GB per-file cap and no range requests.
  Not suitable for the F32 artifacts; viable for Q4_K_M only.

The pragmatic plan: HF mirror first, R2 only if we measure pain.

Once the mirror is live, the GGUF file list belongs in
[`packages/shared/src/local-inference/catalog.ts`](../../packages/shared/src/local-inference/catalog.ts)
so the in-app downloader can resolve it by id.

### Required HF repo metadata

The mirror README must include, at minimum:

- A pointer back to `ModelsLab/omnivoice-singing` and a note that the
  weights are unchanged — only the on-disk format differs.
- The Apache 2.0 license tag.
- A `non-commercial-restriction` warning block reproducing the
  dataset-license table from section 4.
- The `manifest.json` sha256s so downstream verifiers can pin the
  release.

## 4. License

The model weights themselves are **Apache 2.0**. The training data the
upstream author used to derive the singing + emotion behavior carries
extra restrictions that propagate to anyone using the model for those
behaviors:

| Dataset | Drives tags | License |
| --- | --- | --- |
| GTSinger | `[singing]` | CC BY-NC-SA 4.0 (non-commercial, research-only) |
| CREMA-D | `[happy]`, `[sad]`, `[angry]`, `[nervous]` | ODbL |
| RAVDESS | `[happy]`, `[sad]`, `[angry]`, `[nervous]`, `[calm]`, `[excited]` | CC BY-NC-SA 4.0 |
| Expresso | `[happy]`, `[sad]`, `[whisper]` | CC BY-NC 4.0 |
| LibriTTS-R | general TTS | CC BY 4.0 |

In practice: any voice clone or singing sample produced from this
model that relies on GTSinger / RAVDESS / Expresso behavior should be
treated as non-commercial unless the operator brings their own
training data or licenses. The weights file itself can ship with
permissive software because Apache 2.0 covers the parameters; the
restrictions attach to outputs derived from the non-commercial
datasets.

When in doubt, surface the restriction in the user-facing UI before
allowing publish/export actions.

## 5. After conversion: wire into plugin-omnivoice

`plugin-omnivoice` already resolves two paired GGUFs at runtime via
env vars. The singing build follows the same pairing — only the file
paths change:

```bash
export OMNIVOICE_SINGING_MODEL_PATH="$HOME/.milady/models/omnivoice/singing/omnivoice-singing-base-Q8_0.gguf"
export OMNIVOICE_SINGING_CODEC_PATH="$HOME/.milady/models/omnivoice/singing/omnivoice-singing-tokenizer-F32.gguf"
```

The plugin loads a separate `OmnivoiceContext` for the singing model
and selects it when `params.singing === true` is passed to the TTS
handler (see `src/singing.ts` in
[`plugins/plugin-omnivoice`](../../plugins/plugin-omnivoice/RESEARCH.md)).

Verification after wiring:

```bash
echo "[singing] [sad] Quiet rain falls on the stone." \
  | packages/inference/omnivoice.cpp/build/omnivoice-tts \
      --model "$OMNIVOICE_SINGING_MODEL_PATH" \
      --codec "$OMNIVOICE_SINGING_CODEC_PATH" \
      --lang English -o out.wav
```

A successful run produces a 24 kHz mono WAV. If the binary errors with
"unknown tensor", the GGUF schema upstream changed — re-run the
conversion with the latest `omnivoice.cpp` checkout.

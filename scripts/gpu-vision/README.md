# GPU vision service (`scripts/gpu-vision/`)

Stands up the local GPU vision lane for the evidence analyzer registry
([#14543](https://github.com/elizaOS/eliza/issues/14543), epic
[#14541](https://github.com/elizaOS/eliza/issues/14541)): **one resident
`llama-server` + a job queue**, not a model load per image.

The default model is **Baidu Unlimited-OCR** — a 3B DeepSeek-OCR-based VLM (MIT),
served from GGUF `sahilchachra/Unlimited-OCR-GGUF` (Q4_K_M weights + F16 mmproj).
Note the GGUF repo is a personal HF account's conversion of Baidu's released
weights, not a Baidu-official artifact: the revision + sha256 pin in
`models.lock.json` guarantees **immutability** (what we serve can never silently
change), not upstream **provenance**. An optional **Qwen3-VL-4B-Instruct** GGUF
(`Qwen/Qwen3-VL-4B-Instruct-GGUF`, Qwen-official) covers the offline VLM Q&A
fallback. Both are served over the same OpenAI-compatible HTTP API.

This directory is **only the service half** of #14543. The analyzer-registry
integration (enqueue images, stream results into `analysis.json`, `skipped-tier`
records when no GPU service is reachable) is a separate task in `packages/evidence`.

## Scripts

| Script | Purpose |
| --- | --- |
| `setup.mjs` | Idempotent, revision-pinned model download with sha256 verification against `models.lock.json`. |
| `serve.mjs` | Launch / stop a resident `llama-server`; free-port bind, `/health` readiness, PID file, optional `--verify` re-hash. |
| `smoke.mjs` | Real end-to-end OCR test: render a fixture PNG with known text, POST it, assert the text comes back. |
| `lib.mjs` | Shared pure logic (model pins, lockfile, version gate, arg/port helpers, readiness poller). |
| `models.lock.json` | Pinned sha256/size/URL per blob. First real download records it; later runs verify and fail loud on drift. |

Root `package.json` wiring is limited to one entry — `test:gpu-vision`,
mirroring `test:evidence-review` (the repo's mechanism for making a
`scripts/<family>` unit suite runnable). The operational scripts are invoked
directly by path: `node scripts/gpu-vision/<script>.mjs`.

## Quick start

```bash
# 1. Fetch the OCR model (+ mmproj) into the cache, verified against the lockfile.
node scripts/gpu-vision/setup.mjs
#    …or also fetch the Qwen3-VL VLM:
node scripts/gpu-vision/setup.mjs --with-vlm

# 2. Serve it (resident, OpenAI-compatible). Prints the base URL + PID file.
node scripts/gpu-vision/serve.mjs --parallel 2
#    …or serve the VLM instead (second instance, its own PID entry):
node scripts/gpu-vision/serve.mjs --vlm
#    …optionally re-hash the blobs against models.lock.json before launch.
#    Catches on-disk corruption between setup and serve, at the cost of hashing
#    ~2.7 GiB (a few seconds); the default stays presence-only for boot speed:
node scripts/gpu-vision/serve.mjs --verify

# 3. Prove it actually transcribes pixels.
node scripts/gpu-vision/smoke.mjs

# Stop the resident server.
node scripts/gpu-vision/serve.mjs --stop        # add --vlm to stop the VLM instance

# One-shot: setup (if needed) → serve → smoke → stop.
node scripts/gpu-vision/smoke.mjs --start
```

## Requirements

- **llama.cpp ≥ build b8525** (2026-03-25, upstream PR 17400 — DeepSeek-OCR
  support). `serve.mjs` parses `llama-server --version` and refuses to launch on
  anything older, with an actionable `brew upgrade llama.cpp` message.
  - macOS: `brew install llama.cpp` (Metal backend, no extra flags).
  - Linux CUDA: build llama.cpp with `-DGGML_CUDA=on` (or install a CUDA-enabled
    package) so the model runs on the GPU; the CPU backend works but is slow.
- **`hf` CLI** (from `huggingface_hub`) is used for downloads when present
  (resumable, revision-pinned). Without it, `setup.mjs` falls back to direct
  HTTPS `resolve/<revision>` URLs. Either path enforces the same sha256 gate.
- **`sharp`** (already a workspace dependency) renders the smoke fixture.

## VRAM / RAM expectations

| Model | Weights (Q4_K_M) | mmproj (F16) | Resident footprint |
| --- | --- | --- | --- |
| Unlimited-OCR (3B) | 1.82 GiB | 0.76 GiB | **~4–6 GiB** VRAM (Metal unified / CUDA) |
| Qwen3-VL-4B-Instruct | 2.33 GiB | 0.78 GiB | ~5–7 GiB VRAM |

On Apple Silicon these live in unified memory via Metal; an 8 GiB machine runs
the OCR model comfortably, 16 GiB is roomy enough to co-resident both.

## MLX alternative (Apple-Silicon-only environments)

For Apple-Silicon local certifiers that prefer MLX over llama.cpp/Metal, the
same personal HF account that publishes the GGUF conversion also publishes MLX
quants (`sahilchachra/unlimited-ocr-*-mlx`); serve them with `mlx_vlm.server`
(also OpenAI-compatible). These scripts target the GGUF + `llama-server` path
because it is identical across macOS Metal and Linux CUDA (one code path for
both certifier types); MLX is a drop-in swap at the endpoint level if a box has
no working llama.cpp build.

## How the analyzer registry consumes this

The registry treats the service as an **OpenAI-compatible chat completions
endpoint** and never loads a model itself:

- **Endpoint**: `POST {baseUrl}/v1/chat/completions`, where `baseUrl` is
  `http://127.0.0.1:<port>`. The running port/PID/model are recorded in
  `~/.cache/eliza/gpu-vision/serve.json` (respecting `ELIZA_GPU_VISION_CACHE`);
  a fixed port can be forced with `ELIZA_GPU_VISION_PORT`.
- **Request shape**: one user message with a `text` part (the grounding OCR
  prompt, exported as `OCR_PROMPT` from `lib.mjs`) and an `image_url` part whose
  URL is a `data:image/png;base64,…` inline image. `temperature: 0` for
  reproducible transcription.
- **Output normalization**: Unlimited-OCR decorates its transcription with
  grounding markers of its own accord — lines come back like
  `title [50, 128, 595, 262]ELIZA VISION LANE`. This is model behavior, not
  something `OCR_PROMPT` requests, so consumers must strip/normalize the
  `<tag> [x1, y1, x2, y2]` decorations (or treat them as free layout metadata)
  before exact-matching text. `smoke.mjs` handles it with a
  lowercase/whitespace-collapse + substring check.
- **Doctrine**: one resident server holds the model in memory and drains a queue
  via `--parallel N` slots — **no per-job model loads, no GPU sharing between
  containers**. When no service is reachable, the registry records `skipped-tier`
  honestly rather than faking a result; the cpu tier is unaffected.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELIZA_GPU_VISION_CACHE` | `~/.cache/eliza/gpu-vision` | Model + state cache root. |
| `ELIZA_GPU_VISION_PORT` | free port | Force the serve port. `smoke.mjs` prefers the per-model `serve.json` entry and uses this only as a fallback (validated, never `:NaN`). |

## Tests

`bun run test:gpu-vision` (i.e. `node --test scripts/gpu-vision/*.test.mjs`,
mirroring `test:evidence-review`) — covers the pure logic: lockfile
reconciliation, the llama.cpp version-gate boundary (b8524 rejected / b8525
accepted), port and arg parsing, the torn-download size floor, the setup
skip-path wiring (a present-but-wrong blob still fails the sha256 gate), and
the readiness poller against a real in-process HTTP stub (including the
accepts-but-never-responds abort). The download, process launch, and OCR
request are proven by the real `smoke.mjs` run, not mocked in the unit suite.

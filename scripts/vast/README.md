# vast.ai certification runner

Automated full-tier certification on rented vast.ai GPUs, plus the local
fallback (#14548, epic #14541). The product of a run is a **signed
`certification.json`** — the artifact the develop→main promotion gate
(`.github/workflows/certification-verify.yml`) verifies. Whether it was
signed on a vast instance or on a laptop is invisible to the gate by design;
the Ed25519 signature is what matters (trust model:
[`.github/certification/README.md`](../../.github/certification/README.md)).

## Files

| File | What |
| --- | --- |
| `run-certification.mjs` | The vast driver: search → create → poll → pull → **destroy** (plain node, zero workspace deps) |
| `run-certification.test.mjs` | Unit tests for the pure pieces (`bun run test:vast` / `node --test scripts/vast/*.test.mjs`) |
| `local-certify.mjs` | One-command local fallback (same chain, same output) |
| `../../docker/certification/Dockerfile.gpu` | The prebuilt image the instance boots (models + toolchain baked; onstart is capped at 16 KB) |
| `../../.github/workflows/certification-vast.yml` | Dispatch/nightly workflow that drives the driver |
| `../../.github/workflows/certification-image.yml` | Builds + pushes `ghcr.io/elizaos/certification-gpu` |

## Automated run (vast.ai)

Preferred path: dispatch **certification-vast** in the Actions tab (inputs:
`sha`, `tier`, `max_dph`, `max_attempts`, `timeout_minutes`). Nightly runs
happen only while the repo variable `ELIZA_VAST_CERT_ENABLED` is `'true'`.
Required repo secrets: `VAST_API_KEY` (scoped vast key) and
`ELIZA_CERT_SIGNING_KEY`; optional `ELIZA_CERT_PUSH_CMD` (shell run on the
instance with `CERT_BUNDLE_DIR`/`CERT_FILE` exported, e.g. an `rclone copy`
to R2) — without it the signed certification still travels back via the
instance logs, but the full bundle stays on the instance and dies with it.

From a laptop:

```bash
export VAST_API_KEY=...            # https://cloud.vast.ai/ → account → API keys
export ELIZA_CERT_SIGNING_KEY=...  # PEM or base64-wrapped PEM
node scripts/vast/run-certification.mjs --sha <full-sha> --tier full
```

Always available with **zero API calls and zero secrets**:

```bash
node scripts/vast/run-certification.mjs --sha <sha> --dry-run
```

prints the complete plan: offer query, client-side re-filters, redacted
create payload, the exact onstart script (with its byte count vs the 16 KB
vast cap), poll/timeout config, budget worst case, and the exit-code table.

What a real run does, in order:

1. `POST /search/asks/` — verified, rentable, `reliability2 > 0.98`,
   `inet_down > 500`, `gpu_name` (default `RTX_4090`), `num_gpus 1`, priced
   `<= --max-dph`, sorted cheapest-first. Results are **re-checked
   client-side**; offers missing a field are rejected, never assumed fine.
2. `PUT /asks/{offer}/` — boots `ghcr.io/elizaos/certification-gpu:latest`
   (override: `--image`). The signing key and push command ride **only** in
   the create-payload env; the onstart text contains no secret material.
3. The onstart script clones the repo at exactly `--sha`, `bun run
   install:light`, starts the baked gpu-vision `llama-server` when present,
   then `bundle:create --tier <tier>` → `certify:rollup` → `certify:sign`
   (reviewer kind `agent`), prints the signed certification between log
   markers, and runs the push command if configured.
4. Poll `GET /instances/{id}/` every 15 s, pulling log tails: success/failure
   markers, `exited`, debounced `offline`/`unknown`, a loading-phase cap and
   a hard `--timeout-minutes` wall clock all terminate the run.
5. Pull final logs, extract `certification.json` into `--out`
   (`vast-certification-output/` by default).
6. **DESTROY the instance in a `finally`** — never stop (stopped vast
   instances keep billing disk). 3 retries; if all fail the script exits 12
   and prints an unmissable banner with the instance id and a one-line
   `curl -X DELETE` to kill it by hand.

## Costs

| Item | Figure |
| --- | --- |
| RTX 4090 offer band (verified, reliable) | ~$0.31–0.40/hr; default budget cap `--max-dph 0.60` |
| Typical full-tier run | 1–2 h ≈ **$0.35–0.80** |
| Worst case per dispatch | `max_dph × max_attempts × timeout` = 0.60 × 3 × 2 h = **$3.60**, and retries only fire on host-side failures (stuck loading / instance lost), which bill minutes, not hours |
| Nightly (if enabled) | ≈ $12–25/month |

Every run logs its estimated spend (`elapsed × dph` per attempt, then the
total) so the workflow log doubles as the cost record.

## Kill paths

Every failure destroys (or at minimum attempts to destroy) the instance
first, then exits with a distinct code:

| Exit | Meaning | What to do |
| --- | --- | --- |
| 2 | usage / missing key env / onstart over 16 KB | fix the invocation |
| 3 | `VAST_API_KEY` dead or unscoped (HTTP 401/403) | rotate the key; run the local fallback meanwhile |
| 4 | no eligible offers after client-side re-check | raise `--max-dph`, relax `--gpu-name`, or retry later |
| 5 | `--max-attempts` exhausted on retryable host failures | vast is having a day; local fallback |
| 6 | create rejected on every tried offer | as above |
| 7 | instance stuck in `loading` past `--loading-timeout-minutes` | auto-retries next offer; else local fallback |
| 8 | hard `--timeout-minutes` wall clock hit | check pulled logs — the chain is too slow or hung; not auto-retried (expensive) |
| 9 | instance went `offline`/`unknown` (debounced ×3) | auto-retries next offer |
| 10 | onstart chain failed (marker names the step in pulled logs) | fix the chain — deterministic, so **not** retried on another machine |
| 11 | run succeeded but no parseable certification in logs | inspect `--out` logs; likely truncated tail — re-dispatch |
| 12 | **destroy failed after 3 retries — instance still billing** | kill it NOW: `https://cloud.vast.ai/instances/` or `curl -X DELETE -H "Authorization: Bearer $VAST_API_KEY" https://console.vast.ai/api/v0/instances/<id>/` |

The workflow mirrors any failure as a red run whose summary says exactly:
*local certification required*, with the command below.

## Local fallback (one command)

Same chain, same signed output — on your machine (M-series covers the cpu
tier; a CUDA box with `llama-server` + `bun run test:gpu-vision` models for
gpu/full):

```bash
export ELIZA_CERT_SIGNING_KEY=...   # from the keyholder; never committed
node scripts/vast/local-certify.mjs --tier full
```

It runs `bundle:create → certify:rollup → certify:sign` from
`packages/evidence`, then copies `certification.json` to the repo root ready
to commit on the promotion branch (plus prints the `evidence/bundle/` copy
command the gate requires). `--no-sign` stops after rollup so you can
hand-review `verdicts.json` first — signing refuses to mark mechanically
non-pass subjects as `pass` either way, so the one-command path cannot
fabricate green.

## Image

`docker/certification/Dockerfile.gpu` bakes CUDA `llama-server` (pinned to
llama.cpp `b8525`, the minimum `scripts/gpu-vision` accepts), the
sha256-pinned OCR/VLM GGUFs via `scripts/gpu-vision/setup.mjs --with-vlm`,
Node 24, Bun 1.3.14, Playwright Chromium (+ OS deps), tesseract, and ffmpeg.
Rebuilds publish from `.github/workflows/certification-image.yml`
(dispatch, or automatically when the Dockerfile / model pins change) to
`ghcr.io/elizaos/certification-gpu:{latest,sha-<short>}` using the
workflow's own `GITHUB_TOKEN` — no extra registry secret. Secrets are never
baked into the image.

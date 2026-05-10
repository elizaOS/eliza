# On-device inference profiling harness

The `scripts/benchmark/profile-inference.mjs` script profiles the on-device
chat agent across a configurable matrix of models, KV-cache configurations,
DFlash drafter pairings, and prompts. It exists to satisfy the **Validation
matrix (per port)** section of
[`docs/porting/on-device-quantization-porting-plan.md`](./on-device-quantization-porting-plan.md):
the harness is the recurring runner for "End-to-end agent chat" across each
quantization path the porting plan ships.

The harness is HTTP-only — it talks to whatever agent is reachable at the
target URL. That means the same script runs against:

- A host-side dev server (`bun run dev`) for kernel/runtime work that
  doesn't need a phone.
- The cuttlefish AOSP image, once the chat round-trip fix lands (tracked
  separately under Agent E's branch).
- A real arm64 device (e.g. `ZL8325M37K`) when the on-device chat path is
  green and the device is reachable on loopback via `adb forward`.

## How to run

```sh
node scripts/benchmark/profile-inference.mjs [options]
```

Common invocations:

```sh
# Dev server on localhost, default config + output to reports/porting/<today>/
node scripts/benchmark/profile-inference.mjs

# Cuttlefish (after Agent E lands the fix), with a custom output dir
node scripts/benchmark/profile-inference.mjs \
  --target http://127.0.0.1:31337 \
  --label cuttlefish-x86_64 \
  --out reports/porting/2026-05-09-cuttlefish

# Real device via adb forward
adb forward tcp:31337 tcp:31337
node scripts/benchmark/profile-inference.mjs \
  --target http://127.0.0.1:31337 \
  --label arm64-ZL8325M37K
```

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--target <url>` | `http://localhost:31337` | Agent API base URL |
| `--config <path>` | auto-detected per host (see below) | Matrix config |
| `--token <str>` | `MILADY_API_TOKEN` / `ELIZA_API_TOKEN` env | API token if the server is auth-gated |
| `--out <dir>` | `reports/porting/<YYYY-MM-DD>` | Output directory for `profile.json` + `profile.md` |
| `--non-streaming` | streaming on | Use sync `/messages` instead of SSE; no first-token latency |
| `--load-timeout-ms <n>` | `120000` | Per-load timeout |
| `--request-timeout-ms <n>` | `180000` | Per-message timeout |
| `--label <str>` | `null` | Optional label embedded in the report (e.g. host name, device id) |

Auth: the harness sends both `Authorization: Bearer <token>` and
`X-API-Token: <token>` when a token is provided, matching every header
shape the server's `getProvidedApiToken` helper accepts.

### Per-host config matrix

The default config is auto-picked at startup via the same hardware
hints used by `plugin-local-embedding`'s `chooseBackend`:

| Host | Default config |
|---|---|
| `CUDA_VISIBLE_DEVICES` set & not `-1` | `configs/host-cuda.json` |
| Darwin | `configs/host-metal.json` |
| Linux/Windows (no CUDA) | `configs/host-cpu.json` |

Pass `--config` explicitly to override. The shipped configs are:

- `configs/host-cpu.json` — small matrix that runs in <2 min on a
  laptop CPU. Used by the PR-level CI gate in
  `.github/workflows/local-inference-bench.yml`.
- `configs/host-cuda.json` — full matrix including `qjl-tbq3` and
  DFlash drafter pairings. Use against a CUDA workstation.
- `configs/host-metal.json` — Apple Silicon matrix; excludes the
  `qjl-tbq3` leg until the MSL kernel lands.
- `configs/aosp-arm64.json` — cuttlefish + connected real arm64 device
  matrix; replaces the previous `aosp-default.json`.
- `configs/ios-metal.json` — iOS / iPadOS Capacitor matrix.

### CI hookup

`.github/workflows/local-inference-bench.yml` runs the harness:

- Every PR + every nightly cron at 05:00 UTC: stub-validation job
  (boots `stub-agent-server.mjs` on a free port, runs `host-cpu.json`).
  Cheap regression gate.
- Nightly cron only (or `workflow_dispatch run_real_agent=true`): boots
  `bun run dev`, runs the harness, uploads `reports/porting/<date>/`
  as the `profile-nightly-<run_id>` artifact, opens / updates a
  tracking issue labelled `nightly-local-inference`.
- `workflow_dispatch run_cuttlefish=true`: profile against a
  cuttlefish AVD that the operator booted via
  `elizaos-cuttlefish.yml`. Writes
  `reports/porting/<date>-cuttlefish/`.

## Validating the harness without the real path

A stub HTTP server lives next to the harness and implements just enough of
the agent surface to drive the matrix end-to-end with synthetic responses:

```sh
node scripts/benchmark/stub-agent-server.mjs --port 31337 &
node scripts/benchmark/profile-inference.mjs --label stub-validation
```

The stub serves `/api/health`, `/api/local-inference/active`,
`/api/conversations`, and the `/messages` + `/messages/stream` endpoints.
Use it to catch harness regressions before pointing at a real agent.

## Config schema

The matrix config is a JSON file with the following shape (validated by
`validateConfig` at startup; invalid configs fail fast with a clear
message):

```jsonc
{
  "models": ["llama-3.2-1b", "bonsai-8b-1bit"],
  "kvCacheConfigs": [
    { "name": "baseline-fp16", "k": "f16", "v": "f16" },
    { "name": "tbq4-tbq3",     "k": "tbq4_0", "v": "tbq3_0" },
    { "name": "qjl-tbq3",      "k": "qjl1_256", "v": "tbq3_0" }
  ],
  "dflashConfigs": [
    { "name": "no-dflash",     "drafter": null },
    { "name": "dflash-bonsai", "drafter": "bonsai-8b-dflash-drafter" }
  ],
  "prompts": [
    { "id": "short-q",   "text": "What is the capital of France?", "maxTokens": 50 },
    { "id": "long-gen",  "text": "Write a 200-word story...",      "maxTokens": 250 }
  ],
  "iterations": 3,
  "warmupIterations": 1
}
```

The total run count is `models × kvCacheConfigs × dflashConfigs × prompts`,
each repeated `warmupIterations + iterations` times. The default matrix is
`2 × 3 × 2 × 4 = 48` combinations.

### Adding new entries

- **Prompts:** add an object to `prompts[]`. `id` must be unique and is
  what shows up in the report; `text` is the user message; `maxTokens` is
  recorded in the report (the chat endpoint enforces its own limits, so
  `maxTokens` is currently advisory).
- **Models:** add the canonical catalog id from
  `eliza/packages/app-core/src/services/local-inference/catalog.ts`. The
  agent must already have the model installed (or downloadable) for the
  load to succeed; otherwise the run is captured as an error.
- **KV cache configs:** each entry is `{ name, k, v }`. See **API gaps**
  below for the current limitation: per-load overrides aren't accepted by
  the server yet, so `k` / `v` are recorded in the report and the catalog
  default is what actually loads.
- **DFlash configs:** `{ name, drafter }`. `drafter: null` skips
  speculative decoding. Same gap applies — drafter pairing is read from
  the catalog, not the request.

## Output format

Each run produces two files:

### `profile.json`

Full structured matrix output. Schema:

```jsonc
{
  "schemaVersion": 1,
  "target": "http://localhost:31337",
  "label": "...",
  "streaming": true,
  "configPath": ".../host-cpu.json",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "config": { /* echoed input config */ },
  "runs": [
    {
      "key": "<model>__<kvCache>__<dflash>__<prompt>",
      "model": "llama-3.2-1b",
      "kvCache": { "name": "baseline-fp16", "k": "f16", "v": "f16" },
      "dflash":  { "name": "no-dflash", "drafter": null },
      "prompt":  { "id": "short-q", "maxTokens": 50 },
      "startedAt": "ISO-8601",
      "finishedAt": "ISO-8601",
      "loadMs": 320,
      "loadResult": { "modelId": "...", "status": "ready", ... },
      "configGaps": [ { "kind": "...", "requested": {...}, "workaround": "..." } ],
      "warmupIterations": [ { "index": 0, "totalLatencyMs": 412, ... } ],
      "iterations": [ { "index": 0, "totalLatencyMs": 401, "tokensPerSecond": 42.1, ... } ],
      "summary": {
        "successCount": 3,
        "errorCount": 0,
        "totalLatencyMs":      { "count": 3, "median": 401, "p95": 442, "min": 380, "max": 442 },
        "firstTokenLatencyMs": { "count": 3, "median":  72, "p95":  88, ...           },
        "tokensPerSecond":     { "count": 3, "median":  42, "p95":  47, ...           },
        "estimatedTokens":     { "count": 3, "median":  64, ...                         }
      },
      "error": null
    }
  ]
}
```

A run is considered successful at the harness level whenever
`runOneCombination` completed; a model that fails to load or every
iteration erroring is captured as a populated `error`/`iterations[*].error`
field rather than aborting the matrix. This is intentional: the porting
plan expects some kvCache configs (e.g. `qjl1_256`) to fail until the
kernel lands, and the report should record those gaps.

Token counts are estimates (`Math.ceil(text.length / 4)`); the streaming
SSE surface doesn't emit canonical token counts. The estimate is recorded
as `estimatedTokens` so it isn't conflated with a real count.

### `profile.md`

Markdown summary table. Columns: model, kvCache, dflash, prompt, load
latency, first-token median, total median, total p95, tokens/s median,
OK/total iteration count, notes (errors + config gaps).

## API gaps

The current `POST /api/local-inference/active` endpoint **does not** accept
per-load overrides for `cacheTypeK`, `cacheTypeV`, or the dflash drafter
pairing. Those values are read from the catalog entry's `runtime` block
inside `resolveLocalInferenceLoadArgs`
(`eliza/packages/app-core/src/services/local-inference/active-model.ts`).

**Implication:** any `kvCacheConfig` whose `k` / `v` differ from the
loaded model's catalog defaults, or any `dflashConfig` whose `drafter`
differs from the catalog's `runtime.dflash.drafterModelId`, won't actually
take effect at load time. The harness records each such mismatch in the
run's `configGaps[]` array with a documented workaround:

- For KV cache overrides: set
  `ELIZA_LLAMA_CACHE_TYPE_K` / `ELIZA_LLAMA_CACHE_TYPE_V` on the agent
  process before starting it, then re-run the harness against that agent.
  This is the same env-var path the AOSP shim already supports — see
  `eliza_llama_context_params_set_type_k` in
  `eliza/packages/app-core/platforms/android/...`.
- For drafter pairing: edit the catalog entry's
  `runtime.dflash.drafterModelId` (or pick a model whose catalog block
  already references the desired drafter).

When the load endpoint grows programmatic overrides (likely as part of
the QJL kernel landing), drop the `configGaps` synthesis from
`runOneCombination` and pass the values directly in the load body.

## Where the report goes

- The full matrix lives at `reports/porting/<YYYY-MM-DD>/profile.json`
  (and `.md`).
- Nightly CI uploads it as the `profile-nightly-<run_id>` workflow
  artifact (90-day retention) and posts the `profile.md` body to a
  tracking issue labelled `nightly-local-inference` in
  [the issue list](https://github.com/elizaOS/eliza/issues?q=is%3Aissue+label%3Anightly-local-inference).
- The headline numbers from `profile.md` should be appended to the
  `## Current state on the AOSP image` section of
  [`docs/porting/on-device-quantization-porting-plan.md`](./on-device-quantization-porting-plan.md)
  as numbers come in. The porting plan is the cross-port comparison table;
  this directory is the per-run archive.

## Re-running across sessions

The harness has no machine-specific state. Pointing at a different
`--target` is the only thing needed to compare runs across hosts. The
output directory defaults to today's date so two runs on the same day
without `--out` overwrite each other; pass `--out` (or `--label` for a
distinguishing label inside the report) when running multiple matrices in
a single day.

# Single-machine parallel certification

Runs the entire certification stack (epic #14541, this piece #14549) on one
beefy Linux box in reasonable wall-clock: container-parallel CPU test lanes
plus pipelined GPU vision work. macOS certifiers keep the native path
(`bun run test` + `scripts/gpu-vision/serve.mjs`) — compose is the Linux/vast
lane; the orchestrator only cares that lanes report and the queue drains.

## Quick start (Linux, docker + compose v2, NVIDIA container toolkit)

```bash
# cpu tier: all test lanes containerized, per-lane timings collected
node docker/certification/certify-parallel.mjs

# full tier: cpu lanes + resident GPU vision service + queue worker
node docker/certification/certify-parallel.mjs --tier full

# knobs (also accepted by the generator)
node docker/certification/certify-parallel.mjs --cores 32 --unit-shards 6 --e2e-shards 3
```

`certify-parallel.mjs` writes `timings.json` beside this file: per-lane exit
codes, ISO start/finish stamps, and a flat `timings` record
(`Record<phase, milliseconds>`) that `packages/evidence` can merge verbatim
into `BundleMeta.timings`.

## Where the lane list comes from (there is no second registry)

`generate-compose-lanes.mjs` derives the `cpu`-profile services from
`node packages/scripts/run-all-tests.mjs --plan=json --all` — the test
runner's own plan:

- each distinct `scriptName` in `summary.byScript` becomes a lane
  (`test` → `unit`, `test:e2e` → `e2e`, `test:ui` → `ui`, …); a package adding
  a brand-new test script surfaces as a new lane on regeneration, with zero
  edits here;
- the big groups are split with the runner's own `TEST_SHARD=N/M`
  (deterministic package-dir hashing), so shard membership is never listed in
  the compose file;
- the plan's `cloudStep` becomes the `cloud` lane (`bun run test:cloud`), which
  is why every other lane can pass `--no-cloud` without losing coverage.

`compose.yml` is generated-then-committed. The drift gate
(`generate-compose-lanes.mjs --check`, enforced by
`compose-lanes.test.mjs`) fails when the committed file no longer matches
regeneration — regenerate and commit, never hand-edit.

## Cores → lane mapping

Defaults (`cores=16 unit-shards=4 e2e-shards=2`) produce 10 lanes; cpusets are
contiguous, remainder cores go to the earliest (heaviest) lanes:

| Lane          | cpuset | cpus | runs                                       |
| ------------- | ------ | ---- | ------------------------------------------ |
| unit-1of4     | 0-1    | 2    | `TEST_SCRIPT_FILTER=^test$ TEST_SHARD=1/4` |
| unit-2of4     | 2-3    | 2    | shard 2/4                                  |
| unit-3of4     | 4-5    | 2    | shard 3/4                                  |
| unit-4of4     | 6-7    | 2    | shard 4/4                                  |
| e2e-1of2      | 8-9    | 2    | `TEST_SCRIPT_FILTER=^test:e2e$ 1/2`        |
| e2e-2of2      | 10-11  | 2    | shard 2/2                                  |
| integration   | 12     | 1    | `^test:integration$`                       |
| live          | 13     | 1    | `^test:live$` (pr lane → guarded skips)    |
| ui            | 14     | 1    | `^test:ui$`                                |
| cloud         | 15     | 1    | `bun run test:cloud`                       |

Sizing guidance: ~1 lane per 1.5–2 physical cores. 32 cores → `--cores 32
--unit-shards 6 --e2e-shards 3` is a good starting point; more than ~8 unit
shards hits diminishing returns because `bun install` + `build:core` dominate
short shards. Memory: budget ~4 GiB per unit/e2e lane (vitest + browsers),
~8 GiB for `cloud`.

Each lane gets the repo **read-only** at `/repo`, syncs it into its private
`scratch-lane-*` volume (incremental after the first run), installs through
the shared `build-cache` volume (`BUN_INSTALL_CACHE_DIR=/cache/bun`), and runs
its lane command via `lane-entry.sh`.

## GPU profile: one service owns the device

```
capture lanes ──(job files)──▶ queue/pending ──▶ gpu-queue-worker ──HTTP──▶ gpu-vision
                                                       │                    (both llama-servers)
                                                       └──▶ queue/results/<id>.json
```

- **Doctrine: containers do NOT share the GPU; they share the GPU *service*
  over HTTP.** Exactly one container (`gpu-vision`) reserves the device and
  runs both resident `llama-server` instances (`gpu-entry.sh`); lanes and the
  worker talk to `http://gpu-vision:8090` (Unlimited-OCR) and `:8091`
  (Qwen3-VL) with `--parallel N` slots each.
- **VRAM budget ~6–10 GiB at Q4** (fits a single RTX 4090-class card with
  headroom; both models resident, from `scripts/gpu-vision/models.lock.json`):

  | Blob                          | Bytes      |
  | ----------------------------- | ---------- |
  | Unlimited-OCR Q4_K_M          | ~1.95 GiB  |
  | Unlimited-OCR mmproj F16      | ~0.81 GiB  |
  | Qwen3-VL-4B Q4_K_M            | ~2.50 GiB  |
  | Qwen3-VL mmproj F16           | ~0.84 GiB  |
  | KV cache + compute (2× serve) | ~1–4 GiB   |

- **MPS is the escape hatch, not the default.** The two llama-server processes
  in the one `gpu-vision` container time-slice the device, which is fine for a
  drain-the-queue workload. If kernel-level concurrency between resident
  processes ever becomes the bottleneck, enable NVIDIA MPS on the host —
  do not hand the device to more containers. MIG is N/A on consumer cards.
- Models mount read-only from `${ELIZA_GPU_MODELS_DIR:-~/.cache/eliza/gpu-vision}`
  — populate with `node scripts/gpu-vision/setup.mjs --with-vlm` (hash-pinned).

## Pipelined queue (filesystem, no redis)

Producers drop `{ id?, model: "ocr"|"vlm", request, imagePath? }` JSON into
`queue/pending/` (`enqueueJob()` from `queue-worker.mjs` does this atomically
with max-pending backpressure). The worker claims by rename, POSTs
`request` to the model's `/v1/chat/completions` (inlining `imagePath` as a
data URI at the `queue:image` placeholder), and writes
`queue/results/<id>.json` — `ok` (with response + duration), `failed` (with
reason), or `skipped`. Analysis therefore finishes shortly after the last
capture instead of serializing behind it.

Degradation is explicit: while the service is unreachable jobs bounce back to
pending and retry; past `--drain-after-ms` (default 120 s) the worker drains
every pending job to an honest `skipped` record naming the outage. All state
transitions are pure functions in `queue-lib.mjs` with unit tests.

## Exit codes (`certify-parallel.mjs`)

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| 0    | all lanes exited 0 (and queue drained at `--tier full`)             |
| 1    | one or more lanes failed (timings.json still written)               |
| 4    | `EXIT_NO_DOCKER` — serial native fallback printed, nothing ran      |
| 5    | `EXIT_DRIFT` — committed compose.yml stale vs the live plan         |
| 6    | `EXIT_TIMEOUT` — `--timeout-min` elapsed with lanes still running   |

## Image

Services reference `ghcr.io/elizaos/certification-gpu` (override with
`ELIZA_CERT_IMAGE` / `ELIZA_CERT_GPU_IMAGE`), the prebuilt CUDA + bun +
node + playwright + llama-server image owned by the vast.ai runner work
(#14548) — this directory consumes that image and never defines a competing
Dockerfile. Lane containers additionally expect `rsync` and `git`;
`lane-entry.sh` falls back to a slow full copy and says so if rsync is absent.

## Tests

`bun test docker/certification` (outside workspace discovery; CI runs it as an
explicit step): generator drift, plan→lane derivation, cpuset math, YAML/
`docker compose config` validation, queue state machine, real worker process
against a stub HTTP service (success/failure/backpressure/drain-to-skip), and
orchestrator degradation (no docker → exit 4). The full containerized run is
the owner-gated on-Linux acceptance for #14549.

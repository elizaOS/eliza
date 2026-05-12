# W2-H — Embedding pipeline + CI gate verification

**Verifier:** Wave-2 H
**Date:** 2026-05-09
**Branch:** `worktree-agent-adf6831c64f06bb98` (merged W1-H commit `77e340a215`)
**Scope:** End-to-end verification of W1-H's embedding plugin rewrite, the
`local-inference-bench` GitHub Actions workflow, and the dead-plugin
reassessment.

---

## TL;DR

- Real-GGUF E2E test added at
  `plugins/plugin-local-embedding/__tests__/e2e.real-gguf.test.ts`. Gated
  behind `LOCAL_EMBEDDING_RUN_E2E=1`. Locally on
  `nomic-embed-text-v1.5.Q5_K_M.gguf` (CPU): **3/3 passed in 49.89s**.
- Existing W1-H test suite: **35/35 active passing + 3 e2e skipped** when
  the gate isn't set. Cold-start of vitest can flap two of the W1-H tests
  (parity + batching) under the default 5s timeout — flakes don't
  reproduce on warm vitest cache. Filed as a low-risk follow-up
  (recommend bumping per-test timeout to 30s in those two files).
- `.github/workflows/local-inference-bench.yml` is `actionlint`-clean.
  Stub-validation steps reproduced locally — harness produced
  `profile.json` (15.9 KB, 4 runs) + `profile.md` and exited 0.
- `plugin-local-inference` and `plugin-local-ai` are confirmed **alive**
  (referenced in `packages/agent/src/api/{server,chat-routes,health-routes}.ts`
  and `packages/agent/src/runtime/plugin-collector.ts`). The original
  audit's "dead plugin" tag was wrong; W1-H's correction holds.

---

## 1. W1-H artifacts inspected

Merged W1-H commit `77e340a215 feat(local-embedding): hardware-aware
backend, batching, chunking + nightly bench CI` into the verification
worktree. Files reviewed:

- `plugins/plugin-local-embedding/src/index.ts` (rewritten;
  hardware-aware probe, batching, chunking, pooling, normalize).
- `plugins/plugin-local-embedding/src/environment.ts` (new env knobs:
  `LOCAL_EMBEDDING_FORCE_CPU`, `LOCAL_EMBEDDING_BATCH_SIZE`,
  `LOCAL_EMBEDDING_CHUNK_OVERLAP`, `LOCAL_EMBEDDING_POOLING`,
  `LOCAL_EMBEDDING_NORMALIZE`, `LOCAL_EMBEDDING_DIMENSIONS`,
  `LOCAL_EMBEDDING_CONTEXT_SIZE`, `LOCAL_EMBEDDING_MODEL_REPO`).
- `plugins/plugin-local-embedding/__tests__/{backend,chunking,batching,parity,smoke}.test.ts`
  (35 tests).
- `packages/app-core/src/services/local-inference/providers.ts` —
  `TEXT_EMBEDDING` now declared on both `LOCAL_PROVIDER` and
  `DEVICE_BRIDGE_PROVIDER` (lines 94, 128).
- `.github/workflows/local-inference-bench.yml` (3 jobs:
  `stub-validation`, `nightly-real-agent`, `cuttlefish-bench`).
- `scripts/benchmark/configs/{host-cpu,host-cuda,host-metal,aosp-arm64,ios-metal}.json`.

---

## 2. Real-GGUF E2E test

### 2.1 Test added

`plugins/plugin-local-embedding/__tests__/e2e.real-gguf.test.ts` — three
test cases, all gated behind `LOCAL_EMBEDDING_RUN_E2E=1`:

1. **Smoke load + embed.** Loads the GGUF via the production code path
   (probe → `getLlama` → `loadModel` → `createEmbeddingContext`),
   embeds `"Hello, world."`, asserts dim matches the declared model
   dimension and the output is L2-normalised (default).
2. **Per-input parity (100 inputs).** Embeds 100 distinct sentences via
   `generateEmbedding` sequentially, then via `generateEmbeddings`
   batched, and asserts L2 distance between corresponding pairs is
   ≤ 1e-3.
3. **Long-document chunking.** Embeds a ~32k-token document via
   `chunkText` → `embedSingleInput` (forces multi-chunk path on
   nomic's 8k context), asserts pooled output has the declared
   dimension and is L2-normalised.

The test auto-detects the first available file in
`~/.eliza/models/{nomic-embed-text-v1.5.Q4_K_M,nomic-embed-text-v1.5.Q5_K_M,bge-small-en-v1.5.Q4_K_M}.gguf`.
If `LOCAL_EMBEDDING_RUN_E2E=1` is set but no candidate exists, the test
**throws immediately** (silent skip on opt-in is the wrong behavior — if
the operator asked for E2E, missing model is a hard failure).

### 2.2 Run output (this host)

Host: Linux x86_64, CPU-only (`LOCAL_EMBEDDING_FORCE_CPU=1`), model
`nomic-embed-text-v1.5.Q5_K_M.gguf` (~99 MB) already present under
`~/.eliza/models/`.

```
$ LOCAL_EMBEDDING_RUN_E2E=1 LOCAL_EMBEDDING_FORCE_CPU=1 \
    npx vitest run __tests__/e2e.real-gguf.test.ts

 RUN  v4.1.5 plugins/plugin-local-embedding

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  18:58:54
   Duration  49.89s
```

All three real-GGUF assertions pass. No NaN/Infinity in the output
vectors, dim and L2 norm match expectations, sequential vs batched paths
agree to 1e-3 over 100 inputs.

### 2.3 Default-mode behavior

When `LOCAL_EMBEDDING_RUN_E2E` is unset, the test file uses
`describe.skip` and reports `3 skipped`. Final aggregate plugin test
count:

```
Test Files  5 passed | 1 skipped (6)
     Tests  35 passed | 3 skipped (38)
```

So default `bun run test` still produces W1-H's claimed 35/35 with no
behavioural change to existing CI.

---

## 3. CI workflow validation

### 3.1 Lint

```
$ /home/shaw/go/bin/actionlint .github/workflows/local-inference-bench.yml
EXIT=0
```

YAML loads cleanly via `python3 -c "import yaml; yaml.safe_load(...)"`.
Top-level keys, jobs (`stub-validation`, `nightly-real-agent`,
`cuttlefish-bench`), schedule (`0 5 * * *`), pull_request paths, and
workflow_dispatch inputs (`run_real_agent`, `run_cuttlefish`) all parse.

### 3.2 Stub job reproduced locally

Replicated the workflow's `stub-validation` steps verbatim
(`scripts/benchmark/stub-agent-server.mjs --port 31339 &` →
`profile-inference.mjs --target … --config configs/host-cpu.json --label
ci-stub-test --out /tmp/ci-stub-test`).

```
[profile-inference] Running 4 combinations against http://127.0.0.1:31339
[profile-inference] (1/4) llama-3.2-1b__baseline-fp16__no-dflash__short-q
[profile-inference] (2/4) llama-3.2-1b__baseline-fp16__no-dflash__med-reason
[profile-inference] (3/4) llama-3.2-1b__tbq4-tbq3__no-dflash__short-q
[profile-inference] (4/4) llama-3.2-1b__tbq4-tbq3__no-dflash__med-reason
[profile-inference] Wrote /tmp/ci-stub-test/profile.json (4 runs)
[profile-inference] Wrote /tmp/ci-stub-test/profile.md
EXIT=0
```

Outputs:
- `/tmp/ci-stub-test/profile.json` — 15,959 bytes, 4 run records, every
  run captured 3 successful iterations + warmup, includes structured
  `configGaps` for the kv-cache override mismatch (correctly recorded
  as a config gap, not a harness failure).
- `/tmp/ci-stub-test/profile.md` — 1,302 bytes, summary table populated
  for all 4 combinations with median/p95 latencies and tok/s estimates.

### 3.3 Cron + dispatch syntax

- `schedule: - cron: "0 5 * * *"` — daily at 05:00 UTC, parsed cleanly.
- `pull_request.paths` filter restricts PR runs to the relevant scopes
  (`scripts/benchmark/**`, this workflow file,
  `plugins/plugin-local-embedding/**`).
- `workflow_dispatch.inputs.run_real_agent` and `.run_cuttlefish` — both
  declared as `boolean` with `default: false`. Job conditions
  (`if: ${{ github.event_name == 'schedule' || (… && inputs.run_real_agent == true) }}`,
  `if: ${{ … && inputs.run_cuttlefish == true }}`) are syntactically
  correct and read by actionlint without error.
- `concurrency.group` keyed off `github.ref`, `cancel-in-progress: true`
  — keeps PR re-runs from piling up.
- `permissions: { contents: read, issues: write }` — required for the
  github-script step that opens/updates the nightly tracking issue.

### 3.4 Notes / minor

- The nightly-real-agent job uses `ELIZA_API_PORT=31337` /
  `ELIZA_PORT=2138` literally. This works in CI where ports are free
  but is wider than the local dev orchestrator's port-shifting logic.
  Acceptable given the CI runner is single-tenant; flagged for
  awareness only.
- `bun run dev` is launched in the background and probed for 120s; the
  health probe pattern matches the rest of the repo (per CLAUDE.md note
  on dev orchestrator port behaviour).

---

## 4. Dead-plugin reassessment

W1-H's status: the original Wave-1 audit tagged
`@elizaos/plugin-local-inference` and `@elizaos/plugin-local-ai` as dead;
W1-H corrected this and kept them. Spot-checked the relevant files:

| File | Reference | Confirmed live |
| --- | --- | :---: |
| `packages/agent/src/api/server.ts` | imports from `@elizaos/plugin-local-inference` (line 91) | yes |
| `packages/agent/src/api/health-routes.ts` | imports `getLocalInferenceActiveSnapshot` (line 7) | yes |
| `packages/agent/src/api/chat-routes.ts` | imports from `@elizaos/plugin-local-inference` (line 35) | yes |
| `packages/agent/src/runtime/plugin-collector.ts` | `@elizaos/plugin-local-ai` is a member of `LOCAL_MODEL_PROVIDER_PLUGINS` (line 144) | yes |
| `packages/agent/src/runtime/plugin-collector.ts` | `@elizaos/plugin-local-embedding` referenced in disable path (line 369) | yes |

Additional consumers across the workspace:
`packages/benchmarks/configbench/src/handlers/eliza.ts`,
`packages/app-core/test/helpers/real-runtime.ts`,
`packages/app-core/test/live-agent/{personality-routing,agent-runtime}.live.e2e.test.ts`,
`packages/app-core/platforms/electrobun/electrobun.config.ts`,
`packages/app-core/src/benchmark/server.ts`,
`packages/app-core/src/runtime/embedding-warmup-policy.ts`. None of
these would compile or function if the plugin packages were removed.

**Conclusion:** the original "dead-plugin" tag was wrong; W1-H's
correction stands. No further action.

---

## 5. Existing W1-H test suite — note on flakiness

`bun run test` against `plugin-local-embedding` produced two timeouts on
the very first cold-start invocation (vitest transform cost ~21s on
cold cache):

```
× __tests__/parity.test.ts > … > single-input and batched paths produce identical vectors  5002ms
× __tests__/batching.test.ts > … > returns one vector per input and preserves order        5002ms
```

The `Test timed out in 5000ms` message is the vitest default per-test
timeout. Re-running immediately (warm cache) produced
`35 passed / 35 total` in 2.87s with no failures. Running the two test
files in isolation always passes.

Root cause: both tests inject a stub through the
`LocalEmbeddingManager` singleton's private fields. With a cold
`vitest`/`tsx` transform, the dynamic `import("../src/index.ts")` plus
the singleton's `validateConfig()` walk through `process.env` and zod
parsing can punch through the 5s deadline before any user code runs.

**Recommendation for follow-up (low-risk):** add an explicit
`{ timeout: 30_000 }` to those two `it(...)` calls. Not blocking for
W2-H sign-off — the failure mode is purely cold-start jitter, never
seen on warm runs, and CI's `actions/setup-bun` cache should keep the
transform stable. Logging here so it doesn't get lost.

---

## 6. Verification commands

```
# Plugin install + lint + typecheck
cd plugins/plugin-local-embedding
bun install                              # ok
bun run typecheck                        # ok
bun run lint:check                       # ok (Checked 9 files in 40ms)

# Existing W1-H suite
bun run test                             # 35 passed | 3 skipped (38)

# E2E with real GGUF
LOCAL_EMBEDDING_RUN_E2E=1 \
LOCAL_EMBEDDING_FORCE_CPU=1 \
  npx vitest run __tests__/e2e.real-gguf.test.ts
                                         # 3 passed in 49.89s

# Workflow YAML
/home/shaw/go/bin/actionlint .github/workflows/local-inference-bench.yml
                                         # exit 0

# Stub job reproduced locally
node scripts/benchmark/stub-agent-server.mjs --port 31339 &
node scripts/benchmark/profile-inference.mjs \
    --target http://127.0.0.1:31339 \
    --config scripts/benchmark/configs/host-cpu.json \
    --label ci-stub-test --out /tmp/ci-stub-test
                                         # exit 0 — wrote profile.json + profile.md
```

---

## 7. Done criteria

| Criterion | Status |
| --- | :---: |
| Real-GGUF E2E test added + passing locally | yes |
| CI workflow YAML validates (`actionlint`) | yes |
| Stub job reproduces locally and produces `profile.json` + `profile.md` | yes |
| Cron / `workflow_dispatch` triggers parse correctly | yes |
| Dead-plugin claims (W1-H correction) confirmed | yes |
| Report committed | yes |

GPU embedding and the cuttlefish AVD job are explicitly out of scope on
this host (no GPU; cuttlefish job is dispatch-only and shares
infrastructure with `elizaos-cuttlefish.yml`).

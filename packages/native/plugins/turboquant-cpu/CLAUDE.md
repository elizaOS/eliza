# turboquant-cpu — AGENTS

Standalone C library for the **TurboQuant** weight/value-cache
quantization formats (`block_tbq3_0`, `block_tbq4_0`, and
`block_tbq3_tcq`). Sibling of `qjl-cpu` (K-cache) and
`polarquant-cpu` (V-cache + Q4 weights). The combined fork that ships
all three is **`elizaOS/llama.cpp @ v0.1.0-eliza`** (vendored at
`plugins/plugin-local-inference/native/llama.cpp/`).

## Source of truth

The fork's authoritative declarations live at:

| File | Contains |
|---|---|
| `plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h`        | `GGML_TYPE_TBQ3_0=44`, `GGML_TYPE_TBQ4_0=45`, `GGML_TYPE_TBQ3_TCQ=48` |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-common.h`     | `block_tbq3_0` (14 B), `block_tbq4_0` (18 B) |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-quants.c`     | `quantize_row_tbq{3,4}_0`, `dequantize_row_tbq{3,4}_0` |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-cpu/fused-attn-qjl-tbq.c` | `GGML_OP_FUSED_ATTN_QJL_TBQ` (QJL K + TBQ3 V kernel) |
| `plugins/plugin-local-inference/native/reference/turbo_kernels.{c,h}`        | bit-exact CPU reference (the math this library copies) |

This standalone library is the **user-space** mirror of those kernels:
GGUF converters, off-llama.cpp parity tests, and the fused-attn
verification harness link `libturboquant.a` directly so they don't
need to pull the full ggml dependency.

## Layout (mirrors qjl-cpu / polarquant-cpu exactly)

```
include/turboquant/turboquant.h    Public API: block layouts, codebooks, encode/decode.
src/tbq_block_ref.c                Scalar reference — bit-exact to the fork's
                                   ggml-quants.c::quantize_row_tbq*_0 and
                                   dequantize_row_tbq*_0.
test/turboquant_smoke.c            Block-encode/decode round-trip smoke test.
                                   Asserts sizeof(block_tbq3_0)==14, sizeof(block_tbq4_0)==18.
scripts/turboquant_to_gguf.py      Metadata-only GGUF writer for turboquant.json
                                   runtime-cache sidecars.
fork-integration/                  Reserved for in-fork drop-ins; the elizaOS
                                   fork already has TBQ baked in upstream
                                   of this directory, see the patches/README.md).
CMakeLists.txt                     Builds libturboquant.a + turboquant_smoke.
```

## Build + smoke

```bash
cd packages/native/plugins/turboquant-cpu
cmake -S . -B build
cmake --build build --target turboquant_smoke
./build/turboquant_smoke
```

The smoke test must print `[turboquant_smoke] PASS` and exit 0.

## Current tier coverage (W3 quant-matrix — 2026-05-14)

This library is the user-space half of TBQ3/TBQ4 V-cache support.
Every shipping Eliza-1 tier (`2b`, `4b`, `9b`, `27b`,
`27b-256k`) defaults to QJL K + Q4_POLAR V at >8k context
and falls back to QJL K + TBQ3_0 V at ≤8k context (see
`packages/shared/src/local-inference/CONTEXT_SCALING.md` table 1 +
`packages/shared/src/local-inference/catalog.ts::runtimeForTier`).

The TBQ types themselves are **shipped in the fork**. This library
provides the user-space block reference, RVV lane where supported, and
metadata writer used by tooling:

| Tier         | TBQ3_0 V-cache | TBQ4_0 W-cache | TBQ3_TCQ K (≥64k ctx) |
|--------------|---------------:|---------------:|----------------------:|
| eliza-1-2b   |          ✓ shipped | n/a | n/a |
| eliza-1-4b   |          ✓ shipped | n/a | required ≥65k |
| eliza-1-9b   |          ✓ shipped | ✓ buildable via fused_turboquant_apply | required ≥65k |
| eliza-1-27b  |          ✓ shipped | ✓ buildable | required ≥65k |
| eliza-1-27b-256k | ✓ shipped | ✓ buildable | required (256k) |

See `packages/training/reports/eliza1-quant-matrix-2026-05-14.md` for
the full tier × quant-type matrix and per-cell evidence (shipped
artifact paths, build commands, kernel-contract test references).

## What this library is not

- Not a llama.cpp integration. The fork already contains TBQ.
- Not a complete SIMD library for every CPU. The scalar reference is
  always present and the RVV lane is wired for RISC-V builds; x86 and arm64
  hosts currently use the scalar reference beside `tbq_block_ref.c`.
- Not the K-cache compressor. That's `qjl-cpu`. TBQ4_0 keys are an
  alternative path the fork supports for callers that want a stricter
  4-bit K format than QJL's 1-bit JL sketch.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->

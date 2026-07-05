# polarquant-cpu — AGENTS

Standalone C library for **PolarQuant Q4** (`block_q4_polar`,
fork-side `GGML_TYPE_Q4_POLAR=47`). Used as both the Q4 weight quant
and the V-cache quant in the >8k-context default cache layout.
Sibling of `qjl-cpu` (K-cache) and `turboquant-cpu` (TBQ V-cache /
W-cache).

The combined fork that ships QJL + Q4_POLAR + TBQ is
**`elizaOS/llama.cpp @ v0.1.0-eliza`**, vendored at
`plugins/plugin-local-inference/native/llama.cpp/`. See `README.md`
for the algorithm, block format, and SIMD parity numbers.

## Source of truth

| File | Contains |
|---|---|
| `plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h`              | `GGML_TYPE_Q4_POLAR=47` |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-common.h`           | `block_q4_polar` (82 B) |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-cpu/quants.{c,h}`   | fork CPU implementation |
| `plugins/plugin-local-inference/native/reference/qjl_polar_ref.{c,h}`              | bit-exact CPU reference |

This standalone library is the user-space mirror; the GGUF converter
at `scripts/polarquant_to_gguf.py` packs PolarQuant safetensors
sidecars into Q4_POLAR=47 GGUF files using the same block layout.

## Current tier coverage (W3 quant-matrix — 2026-05-14)

PolarQuant Q4 is the **V-cache default for every shipping Eliza-1
tier at >8k context** — see
`packages/shared/src/local-inference/CONTEXT_SCALING.md` table on
`qjl1_256` K + `q4_polar` V being the shipping default. The
TurboQuant TBQ3_0 V is the ≤8k-context fallback.

| Tier              | Q4_POLAR V-cache (default >8k ctx) | Q4_POLAR weights (Q4 path) |
|-------------------|-----------------------------------:|---------------------------:|
| eliza-1-2b        | shipped | buildable via `polarquant_apply.py` |
| eliza-1-4b        | shipped | buildable |
| eliza-1-9b        | shipped | buildable |
| eliza-1-27b       | shipped | buildable |
| eliza-1-27b-256k  | shipped | buildable |

The full tier × quant-type matrix (rows = tier, columns = QJL-K +
PolarQuant-V + TurboQuant-W variants) lives at
`packages/training/reports/eliza1-quant-matrix-2026-05-14.md`.

## Tests + parity

- `polar_roundtrip_test` — round-trip a float[128] vs the Python
  reference's measured per-block error (~9–10%).
- `polar_dot_test` — dot product against an unquantized fp32 reference.
- `polar_simd_parity_test` — AVX2 vs scalar over 100 random blocks
  (max-abs ≤ 5e-7 dequant; rel-err ≤ 2e-7 dot).
- `polar_preht_*` — pre-Hadamard variants the fused-attn path needs.
- `make -C plugins/plugin-local-inference/native/verify kernel-contract`
  lists `polarquant` in `manifestKernelNames` /
  `requiredRuntimeCapabilityKeys` and reads the JSON fixture this
  library generates.
- `scripts/test_converter.py` — synthesise a 128×128 fp32 linear,
  encode + GGUF-write, read back via `gguf.GGUFReader`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../../PR_EVIDENCE.md)**. Read it.
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

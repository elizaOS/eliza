# Benchmark suite review — parity, gaps, and open work

Date: 2026-05-28. Scope: `packages/benchmarks`. Method: discovered adapters via
`orchestrator.discover_adapters`, inspected per-harness factory coverage, and
ran live BFCL smoke runs on Cerebras `gpt-oss-120b`.

## Harness coverage at a glance

`discover_adapters` registers **53 benchmark adapters**. Registration-level
harness compatibility:

| harness | benchmarks compatible |
| --- | --- |
| eliza | 48 |
| hermes | 48 |
| openclaw | 48 |
| smithers | 1 (bfcl) — newly added |

5 benchmarks are compatible with **nobody** because they are gated behind live
infrastructure that is not present:

| benchmark | why disabled |
| --- | --- |
| `hyperliquid_bench` | needs `HL_PRIVATE_KEY` + live execution |
| `vision_language` | needs a multimodal runtime/input bundle |
| `voicebench` | needs real audio assets |
| `voicebench_quality` | needs real audio inputs |
| `voiceagentbench` | needs real audio dataset |

## Does eliza lack parity with hermes/openclaw?

**No — the asymmetry runs the other way.** At the registration level eliza,
hermes, and openclaw are symmetric (48 each, no eliza-only and no
hermes-XOR-openclaw benchmarks). At the *factory* level eliza is the **superset**:
it has per-benchmark adapters for the full suite (osworld, evm, hyperliquid,
social_alpha, vending, visualwebbench, mmau, …), whereas hermes/openclaw only
implement the ~13 tool-calling / agentic benchmarks:

| harness | explicit per-benchmark factories |
| --- | --- |
| hermes (14) | action_calling, agentbench, bfcl, clawbench, context_bench, gauntlet, lifeops_bench, mind2web, mint, swe_bench, swe_env_smoke, tau_bench, terminal_bench, woobench |
| openclaw (13) | same as hermes minus `swe_env_smoke` |
| smithers (1) | bfcl |

So the real parity gaps are:

1. **smithers coverage** — only `bfcl` today. The harness contract is
   benchmark-agnostic; see `docs/SMITHERS_INTEGRATION.md` for the 3-step recipe
   to extend. Lowest-friction next targets: `action_calling`, `clawbench`,
   `agentbench`, `mint`, `tau_bench`.
2. **hermes vs openclaw** — hermes has a `swe_env_smoke` factory openclaw lacks
   (minor; both still register for `swe_bench`).
3. **5 infra-gated benchmarks** — not a code gap; they need credentials/Docker/
   audio/multimodal runtimes to run for *any* harness.

## Open items found

- **Duplicate hyphen/underscore directories.** Several benchmarks exist as both
  a hyphenated dir and an underscore "matrix" sibling:
  `app-eval` / `app_eval`, `openclaw-benchmark` / `openclaw_benchmark`,
  plus `*_matrix` dirs (`agentbench_matrix`, `clawbench_matrix`,
  `claw_eval_matrix`, `qwen_claw_bench_matrix`, `swe_bench_pro_matrix`). The
  underscore/`_matrix` variants are explicitly listed in
  `IGNORED_BENCHMARK_DIRS`, i.e. they are not discovered as benchmarks. They
  look like matrix-run scratch dirs; worth confirming they are intended and not
  half-migrated leftovers.
- **Pricing was Cerebras-only.** `lib/pricing.py` priced only `gpt-oss-120b`;
  Anthropic Opus pricing has been added (`ANTHROPIC_PRICING`, `ALL_PRICING`) so
  Opus run-cost projections are possible (see `scripts/compute_costs.py`).
- **No cross-harness cost report existed.** Added `scripts/compute_costs.py` +
  `benchmark_results/COST_REPORT.md`.

## Where each harness "struggles" (observed)

- **Cerebras 429s** (`token_quota_exceeded`, per-minute token cap) appear under
  load for all OpenAI-compatible harnesses (hermes/openclaw/smithers). The
  adapters' retry-with-backoff layer absorbs these, but full-suite concurrent
  runs should throttle or the per-minute quota will dominate wall-clock.
- **eliza on tool-calling benchmarks** historically scores lower on BFCL in the
  checked-in snapshots (`bfcl__eliza.json` ≈ 0.5 on an Opus calibration) because
  it routes through the elizaOS TS bridge rather than native function calling —
  the bridge must be running (`bun run dev`) to benchmark eliza live.

## Live certification status (this pass)

BFCL, Cerebras `gpt-oss-120b`, identical small samples:

| harness | version | BFCL result |
| --- | --- | --- |
| smithers | 0.21.0 | 87.5% (7/8), 100% (3/3) |
| hermes | 0.15.0 (upgraded) | 100% (2/2) |
| openclaw | 2026.5.27 (upgraded) | 100% (2/2) |
| eliza | TS bridge | requires `bun run dev` (not run this pass) |

All three OpenAI-compatible harnesses ballpark together on BFCL; smithers is
within range. Full 53-benchmark × 4-harness certification requires the gated
infra (Docker, audio, multimodal, HL key, eliza bridge) and meaningful paid API
spend — see `COST_REPORT.md` for the projected cost.

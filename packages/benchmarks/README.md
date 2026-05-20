# `packages/benchmarks`

The elizaOS evaluation suite. 70+ benchmark harnesses spanning agent autonomy, tool-call correctness, long-horizon reasoning, voice/vision multimodal, embodied control, and adversarial robustness.

Python-based. Lives outside the TypeScript workspace; not an npm package.

## Categories

| Subdir                           | What it evaluates                                                              |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `eliza-1/`                       | Native tool-calling and agentic loop quality on Eliza-1 models.                |
| `swe-bench/`, `agentbench/`      | Software engineering tasks.                                                    |
| `lifeops-bench/`                 | Long-running personal-assistant scenarios.                                     |
| `orchestrator/`                  | Multi-agent coordination harness.                                              |
| `HyperliquidBench/`              | Onchain trading agent evaluation.                                              |
| `OSWorld/`                       | Desktop OS automation tasks.                                                   |
| `vision-language/`               | Multimodal grounding.                                                          |
| `voice-emotion/`                 | Speech recognition + affect under noise.                                       |
| `clawbench/`, `claw-eval/`       | Claude-specific evaluations.                                                   |
| `compactbench/`                  | Context compaction quality.                                                    |
| `configbench/`, `context-bench/` | Runtime config and context handling.                                           |
| `adhdbench/`                     | Long-horizon focus / distraction resilience.                                   |
| `abliteration-robustness/`       | Behavioral robustness post-abliteration.                                       |
| `app-eval/`                      | End-to-end app interaction.                                                    |

## Running

The orchestrator at `orchestrator/` accepts a config and runs the named harness, collecting traces and metrics. See `ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md` for full runbook including remote GPU usage.

```bash
cd packages/benchmarks
python3 -m orchestrator.runner --config <path>
```

## Reports

Reference runs are checked into `benchmark_results/`. Reports include calibration data, scorecards, and per-task traces.

## Docs

User-facing summary: [Benchmarks track page](../docs/tracks/training/benchmarks.mdx).

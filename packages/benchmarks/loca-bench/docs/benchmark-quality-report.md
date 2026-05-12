# LOCA benchmark quality report

Date: 2026-05-12

## What changed

- LOCA audit output now includes capped `review_records` for manual inspection. Each record includes model input, model output, expected answer or long-context target summary, scoring reason, compaction events, and token usage.
- Aggregate trajectory parsing accepts the upstream dict format, flat list format, and `{ "trajectories": [...] }` envelopes.
- Synthetic long-context fixtures cover `128k`, `256k`, `512k`, and `1m` tiers. Tests now assert 1m and 256k trajectories preserve needles from early, middle, and late turns after summary+tail compaction.
- Orchestrator compatibility gates LOCA to Eliza-only until Hermes/OpenClaw adapters produce real audited LOCA trajectories with full chat/tool payloads and token usage.

## Remaining limitations

- The 1m LOCA path is synthetic. It validates context preservation, compaction auditability, and tool-call pairing, but it is not a live environment task.
- Upstream task configs currently ship through 256k. A live 1m run needs either a larger generated task config or multi-task aggregation that reaches the 1m model prompt boundary.
- Review records are previews, not full transcript copies. The full transcript remains in `tasks/<TaskName>/stateN/trajectory.json`.

## Recommended next runs

```bash
cd packages/benchmarks/loca-bench
export CEREBRAS_API_KEY=...
python -m eliza_loca.run_cerebras \
  --config task-configs/final_256k_set_config.json \
  --context-summary \
  --context-awareness \
  --max-context-size 262144 \
  --reset-size 131072 \
  --reasoning-effort medium \
  --output-dir outputs/eliza_256k_summary

python -m eliza_loca.long_context \
  --output-dir outputs/long_context_1m \
  --tier 1m \
  --turns 400 \
  --needle-count 32 \
  --summary-mode perfect
```

Inspect `eliza_loca_audit.json` and `long_context_audit.json` first. Do not publish cross-agent LOCA rows until each non-Eliza adapter produces the same audit artifacts.

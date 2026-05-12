# OpenClaw Legacy Text Tool-Call Parser Note — W1-11

This historical audit originally described a parser fix for OpenClaw's
old text-embedded tool-call envelope. That protocol is no longer a
supported target for elizaOS benchmarks or training paths.

<<<<<<< HEAD
In the W1-3 baseline at
`~/.eliza/runs/lifeops/lifeops-openclaw-baseline-1778514437/lifeops_gpt-oss-120b_20260511_084802.json`,
3 of 25 scenarios scored 0.0 with `agent_actions: []`:
=======
Current policy:
>>>>>>> origin/shaw/fine-tune-apollo-pipeline

- Eliza-native benchmarks must send OpenAI-compatible `tools` and score
  returned `tool_calls`.
- Runtime and training code should not teach models to place tool calls
  in assistant text content.
- Historical OpenClaw/Hermes comparisons should be interpreted as legacy
  adapter behavior unless they have native `tool_calls` adapters.

The actionable follow-up from this audit is therefore not to repair the
legacy text parser further, but to use native function calling for fair
Eliza, Cerebras, OpenAI, and llama.cpp comparisons.

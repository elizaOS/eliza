# OpenClaw Legacy Text Tool-Call Parser Note — W1-11

This historical audit originally described a parser fix for OpenClaw's
old text-embedded tool-call envelope. That protocol is no longer a
supported target for elizaOS benchmarks or training paths.

Current policy:

- Eliza-native benchmarks must send OpenAI-compatible `tools` and score
  returned `tool_calls`.
- Runtime and training code should not teach models to place tool calls
  in assistant text content.
- Historical OpenClaw/Hermes comparisons should be interpreted as legacy
  adapter behavior unless they have native `tool_calls` adapters.

The actionable follow-up from this audit is therefore not to repair the
legacy text parser further, but to use native function calling for fair
Eliza, Cerebras, OpenAI, and llama.cpp comparisons.

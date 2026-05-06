# @elizaos/native-reasoning

Single-call multi-tool reasoning loop for elizaOS agents. It is an opt-in alternate runtime for frontier models that can use native tool calling directly instead of the classic `shouldRespond → action selection → content generation → evaluators` bootstrap pipeline.

See `SPEC.md` for the architectural contract.

## Quick start

Add the package to an elizaOS workspace and set a character-level switch:

```json
{
  "name": "Eliza",
  "reasoning": {
    "mode": "native",
    "provider": "anthropic"
  }
}
```

Characters that omit `reasoning.mode`, or set it to `bootstrap`, continue using the existing bootstrap message pipeline unchanged.

## Backends

- `NATIVE_REASONING_BACKEND=anthropic` (default): standard Anthropic API key or Anthropic-compatible proxy. Use with Claude Opus or Sonnet models via `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`, and optional `NATIVE_REASONING_MODEL`.
- `NATIVE_REASONING_BACKEND=codex`: uses ChatGPT subscription auth via the codex CLI's token cache at `~/.codex/auth.json` and calls ChatGPT's codex backend at `https://chatgpt.com/backend-api/codex/responses`. This gives access to GPT-5+ class models via ChatGPT Pro subscription auth instead of per-token API pricing. The backend includes a single-in-flight semaphore and request jitter as soft mitigation against rate detection.

Loop configuration:

- `NATIVE_REASONING_MAX_TURNS`: optional loop cap. Defaults to 12.
- `NATIVE_REASONING_TOTAL_BUDGET_MS`: optional wall-clock budget. Defaults to 90000.
- `NATIVE_REASONING_PER_TURN_TIMEOUT_MS`: optional per-turn timeout. Defaults to 30000.

## Status

Production-validated in Nyx, proposed upstream as an explicit opt-in runtime. Bootstrap remains the default and remains the right choice for many model tiers.

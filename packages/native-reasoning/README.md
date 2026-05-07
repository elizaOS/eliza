# @elizaos/native-reasoning

Single-call multi-tool reasoning loop for elizaOS agents. It provides the foundational substrate for native tool calling when the configured model/provider can execute tools directly, replacing the classic `shouldRespond → action selection → content generation → evaluators` prompt-XML planner only where the framework detects support.

## Selection

Native reasoning is not a character/customer setting. Do not add a `reasoning` block to character files.

The framework selects the dispatch path from model capability:

- native tool calling path for capable providers/models such as Claude, GPT-4+/GPT-5+, and Codex-class backends
- existing bootstrap prompt planner for legacy completion models and providers without a concrete native-tool backend

This keeps behavior model-aware and lets lower-tier or legacy models continue unchanged.

## Backends

- `NATIVE_REASONING_BACKEND=anthropic` (default): standard Anthropic API key or Anthropic-compatible proxy. Use with Claude Opus or Sonnet models via `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`, and optional model settings.
- `NATIVE_REASONING_BACKEND=codex`: uses ChatGPT subscription auth via the codex CLI's token cache at `~/.codex/auth.json` and calls ChatGPT's codex backend at `https://chatgpt.com/backend-api/codex/responses`. This gives access to GPT-5+ class models via ChatGPT Pro subscription auth instead of per-token API pricing. The backend includes a single-in-flight semaphore and request jitter as soft mitigation against rate detection.

## Tools

`buildDefaultRegistry()` wires the local substrate tools: file ops, shell, web fetch/search stubs, memory stubs, journaling, ACP subagent spawn, and Codex spawn.

## Scope

This package establishes the native loop, backend adapters, and tool registry. It does not yet convert the Eliza action registry into native tool schemas. Actions-as-tools is the natural follow-up so Shaw's action modes, including `Mode.ALWAYS_BEFORE`, `Mode.ALWAYS_AFTER`, and `Mode.DURING`, can plug into the same registry.

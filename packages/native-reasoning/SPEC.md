# Native Reasoning Runtime Spec

## Goal

Add `@elizaos/native-reasoning` as the foundational native-tool-calling substrate for elizaOS agents. Native reasoning uses a frontier-model loop with native tool calls instead of the classic bootstrap sequence of `shouldRespond → action selection → content generation → evaluators` when the configured model/provider supports that capability.

This is not a customer-pickable character mode. Characters should not declare `reasoning.mode` or `reasoning.provider`. The framework decides per runtime/provider/model capability whether to use native dispatch or the existing prompt-XML planner.

## Selection

`DefaultMessageService` performs framework-level capability detection before the bootstrap path:

1. Inspect the registered preferred text-generation model provider where available.
2. Infer the configured provider/model from runtime settings as a fallback.
3. Route to `runNativeReasoningLoop` only for providers/models known to support native tool calling.
4. Keep the existing bootstrap planner unchanged for legacy completions, unsupported local providers, and anything not explicitly recognized.

Current v1 detection covers:

- Anthropic Claude models
- OpenAI GPT-4+/GPT-5+/o-series/Codex-class model names
- Codex backend selection
- Legacy OpenAI completions models remain on bootstrap
- Local providers stay on bootstrap until a concrete native backend/capability is advertised

## Package Surface

```
packages/native-reasoning/
  src/loop.ts                  runNativeReasoningLoop(runtime, message, callback, opts)
  src/backends/*               native backend adapters
  src/tool-schema.ts           NativeTool registry + conversion primitives
  src/tools/registry.ts        buildDefaultRegistry()
  src/system-prompt.ts         identity/system prompt assembly
```

## Backends

- `AnthropicBackend`: standard Anthropic API key or Anthropic-compatible proxy. Use with Claude models via `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`, and model settings forwarded by core.
- `CodexBackend`: uses ChatGPT subscription auth via the codex CLI token cache at `~/.codex/auth.json` and calls ChatGPT's codex backend at `https://chatgpt.com/backend-api/codex/responses`. This gives access to GPT-5+ class models via ChatGPT Pro subscription auth instead of per-token API pricing. It includes a single-in-flight semaphore and request jitter as soft mitigation against rate detection.

## Loop Contract

The loop dispatches one turn to a selected backend, receives unified text/tool-use blocks, executes requested tools, appends tool results, and continues until final text, an ignore tool, max turns, timeout, or error.

Key guarantees:

- Pipeline hooks remain model-agnostic in core.
- The classic bootstrap path remains the fallback.
- Tool execution is centralized in the native registry.
- Selection is owned by the framework, not character authors.

## Relationship to Actions-as-Tools

This PR establishes substrate only. It does not convert Eliza actions into native tool schemas yet.

The natural follow-up is to adapt the action registry so actions emit native tool definitions. Shaw's action modes, including `Mode.ALWAYS_BEFORE`, `Mode.ALWAYS_AFTER`, and `Mode.DURING`, can then plug into the same registry and scheduling semantics instead of being compressed into the prompt planner.

## Benchmarks

Empirical benchmarks are required before treating this as a default replacement across all supported models. The benchmark workstream should compare native dispatch against the current TOON/XML planner for:

- token consumption
- latency
- tool/action selection accuracy
- final response quality
- failure and fallback rates

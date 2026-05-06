# Native Reasoning Runtime Spec

## Goal

Add `@elizaos/native-reasoning` as an opt-in alternate message runtime for elizaOS agents. Native reasoning uses one frontier-model loop with Anthropic native tool calling instead of the classic bootstrap sequence of `shouldRespond → action selection → content generation → evaluators`.

Bootstrap remains the default. Native reasoning is selected only when a character explicitly sets:

```json
{
  "reasoning": {
    "mode": "native",
    "provider": "anthropic"
  }
}
```

Characters without `reasoning.mode`, or with `reasoning.mode: "bootstrap"`, keep the existing behavior unchanged.

## Architectural Contract

```text
connector receives message
    ↓
connector calls runtime.messageService.handleMessage(...) as it already does
    ↓
DefaultMessageService checks character.reasoning.mode
    ↓ if unset/bootstrap
classic bootstrap pipeline unchanged
    ↓ if native
runNativeReasoningLoop(runtime, message, callback)
    ↓
single Anthropic native-tool-use turn
    ↓ if tool calls
execute tools inline, append tool results, continue loop
    ↓ if final text
callback({ text, attachments })
```

The integration seam is intentionally small: the connectors do not change, plugin-bootstrap behavior does not change, and evaluators are not deprecated.

## Public Backends

The public package ships two native-tool-use backends.

- `AnthropicBackend`: standard Anthropic API key or Anthropic-compatible proxy. Use with Claude Opus or Sonnet models via `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`, and optional `NATIVE_REASONING_MODEL`.
- `CodexBackend`: uses ChatGPT subscription auth via the codex CLI's token cache at `~/.codex/auth.json` and calls ChatGPT's codex backend at `https://chatgpt.com/backend-api/codex/responses`. This gives access to GPT-5+ class models via ChatGPT Pro subscription auth instead of per-token API pricing. It includes a single-in-flight semaphore and request jitter as soft mitigation against rate detection.

Configuration:

- `NATIVE_REASONING_BACKEND`: `anthropic` by default, or `codex`.
- `ANTHROPIC_API_KEY`: required for the Anthropic backend.
- `ANTHROPIC_BASE_URL`: optional Anthropic-compatible base URL.
- `NATIVE_REASONING_MODEL`: optional model override.
- `NATIVE_REASONING_MAX_TURNS`: loop cap, default 12.
- `NATIVE_REASONING_TOTAL_BUDGET_MS`: wall-clock cap, default 90000.
- `NATIVE_REASONING_PER_TURN_TIMEOUT_MS`: per-turn backend timeout, default 30000.

## Tools Exposed in Native Mode

Native tools are JSON-schema-described handlers registered in `ToolRegistry` and converted into Anthropic tool format by `tool-format/anthropic.ts`.

The default registry includes:

| Tool | Purpose |
| --- | --- |
| `read_file`, `write_file`, `edit_file` | Workspace file operations. |
| `glob`, `grep` | Workspace search. |
| `web_fetch`, `web_search` | Web retrieval helpers when available. |
| `recall`, `remember` | Runtime memory search and persistence helpers. |
| `ignore` | Silent stop, no user-facing reply. |

Additional tools can be registered by callers through the `registry` option without changing the loop. A `bash` tool is included in the package for controlled deployments, but it is not part of the default registry because shell execution needs host-specific sandboxing policy.

## Loop Behavior

```ts
export async function runNativeReasoningLoop(
  runtime: IAgentRuntime,
  message: Memory,
  callback: HandlerCallback,
  options?: RunOptions,
): Promise<void> {
  const registry = options?.registry ?? new Map();
  const tools = buildToolsArray(registry);
  const systemPrompt = options?.systemPrompt ?? await assembleSystemPrompt(runtime, message);
  const messages = [{ role: "user", content: [{ type: "text", text: message.content.text }] }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await backend.callTurn({ systemPrompt, messages, tools });

    if (result.toolCalls.some((tool) => tool.name === "ignore")) return;

    if (result.toolCalls.length === 0) {
      if (result.text.trim()) await callback({ text: result.text, attachments: [] });
      return;
    }

    messages.push({ role: "assistant", content: result.rawAssistantBlocks });
    messages.push({ role: "tool", content: await executeToolCalls(result.toolCalls) });
  }

  await callback({ text: "(hit reasoning limit, stopping)", attachments: [] });
}
```

## System Prompt Assembly

`assembleSystemPrompt` builds a deterministic prompt from:

- character system prompt and identity fields
- style, bio, topics, adjectives, and examples
- recent room context available through runtime state and memories
- runtime-provided context available to the message

This replaces bootstrap provider-stack prompt composition only for characters that explicitly opt into native mode.

## What This Does Not Change

- Does not change default character behavior.
- Does not modify connector packages.
- Does not deprecate evaluators.
- Does not replace plugin-bootstrap.
- Does not introduce a generic `ReasoningRuntime` abstraction yet.
- Does not require all agents to use frontier models.

## Production Notes

Native reasoning has been production-validated in Nyx. The upstream package keeps the public surface focused on the Anthropic native-tool-use backend and the opt-in runtime seam.

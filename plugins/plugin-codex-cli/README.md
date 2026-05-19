# @elizaos/plugin-codex-cli

ChatGPT Codex model provider for elizaOS. This node-only plugin lets an Eliza agent use a user's ChatGPT Plus/Pro subscription as a frontier-model provider by reusing the OAuth token cache written by the official `codex` CLI.

This is intentionally a model provider plugin. It does not add a reasoning runtime, planner loop, context manager, or any native-reasoning architecture. It sits alongside providers like `@elizaos/plugin-openai` and `@elizaos/plugin-anthropic` and registers handlers for text, response-handler, action-planner, and object model types.

## How it works

The plugin reads OAuth tokens from `~/.codex/auth.json` by default, sends requests to:

```txt
https://chatgpt.com/backend-api/codex/responses
```

and uses the same codex-oriented request headers as the CLI path:

- `Authorization: Bearer <access_token>`
- `originator: codex_cli_rs`
- `User-Agent: codex_cli_rs/...`
- `chatgpt-account-id: <account_id>`
- `OpenAI-Beta: responses=v1`

On a 401, it refreshes the token with the cached refresh token, writing the auth file atomically under a file lock, then retries once.

## Supported models

Set `CODEX_MODEL` to one of:

- `gpt-5`
- `gpt-5-codex`
- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.5-pro`

The default is `gpt-5.5`.

## Configuration

```bash
CODEX_AUTH_PATH=~/.codex/auth.json
CODEX_BASE_URL=https://chatgpt.com/backend-api/codex # must target chatgpt.com or localhost
CODEX_MODEL=gpt-5.5
CODEX_JITTER_MS_MAX=200
CODEX_ORIGINATOR=codex_cli_rs
```

## Usage

Install or enable the plugin the same way as other elizaOS model-provider plugins, then configure an agent to load `@elizaos/plugin-codex-cli`.

Example direct runtime call:

```ts
import { ModelType } from "@elizaos/core";

const text = await runtime.useModel(ModelType.RESPONSE_HANDLER, {
  prompt: "Reply as the agent in one short paragraph.",
});
```

Tool-capable calls can pass provider-neutral `tools`, `toolChoice`, and `messages`. The plugin forwards tools to the OpenAI Responses API function-tool shape and returns a native result object when tools or messages are used:

```ts
const result = await runtime.useModel(ModelType.RESPONSE_HANDLER, {
  messages,
  tools: [
    {
      name: "lookup",
      description: "Look up a fact",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
});

// result.text
// result.toolCalls
```

## Soft mitigation

To reduce account/session weirdness against the ChatGPT Codex backend, each backend instance uses:

- a single in-flight FIFO semaphore
- configurable jitter before requests, default 50-200ms

## Scope

This package is the salvaged CodexBackend piece from the closed native-reasoning PR #7435. Wave 1 on `develop` owns native tool calling and the agent loop. This plugin only provides a Codex-backed model provider surface for that architecture.

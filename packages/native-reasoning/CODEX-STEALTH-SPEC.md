# Codex Stealth Backend — Implementation Spec

**Goal:** Add a second backend to `@elizaos/native-reasoning` that talks to `https://chatgpt.com/backend-api/codex/responses` using chatgpt OAuth tokens, enabling nyx (and future milady cloud agents) to use GPT-5.5 via Shadow's chatgpt prolite subscription instead of claude.

**Why:** Avoids auth pool collision with Sol's claude max sub. GPT-5.5 quality. Keeps the same loop+tools architecture.

---

## Confirmed protocol details (verified by direct curl)

### Endpoint
`POST https://chatgpt.com/backend-api/codex/responses`

### Headers (exact)
```
Authorization: Bearer <tokens.access_token from ~/.codex/auth.json>
chatgpt-account-id: <tokens.account_id from ~/.codex/auth.json>
Content-Type: application/json
originator: codex_cli_rs
User-Agent: codex_cli_rs/<codex_version>
OpenAI-Beta: responses=v1
Accept: text/event-stream
```

### Body
```json
{
  "model": "gpt-5.5",                    // also: gpt-5.5-pro, gpt-5.4, gpt-5.4-mini
  "instructions": "<system prompt>",      // REQUIRED. error: "Instructions are required" if missing
  "input": [
    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "..."}]}
  ],
  "store": false,
  "stream": true,                        // REQUIRED. error: "Stream must be set to true" if false
  "tools": [...]                         // optional, OpenAI function tool format
}
```

### What does NOT work
- `max_output_tokens`: "Unsupported parameter: max_output_tokens" — DROP IT
- `stream: false`: rejected
- `messages` array (chat completions style): rejected
- direct `api.openai.com/v1/responses`: 403 missing scope, this token doesn't grant API access

### Tool format (OpenAI native function tools)
```json
{
  "type": "function",
  "name": "bash",
  "description": "...",
  "parameters": {
    "type": "object",
    "properties": {...},
    "required": [...]
  },
  "strict": false
}
```

### SSE event types (in order during a turn)
1. `response.created` — initial state
2. `response.in_progress` — settling
3. `response.output_item.added` — new message starting (item: `{type: "message", role: "assistant", phase: "final_answer", ...}`) OR `{type: "function_call", call_id, name, arguments: ""}`
4. `response.content_part.added` — content block opened
5. `response.output_text.delta` — text streaming (each delta has `delta` field)
6. `response.function_call_arguments.delta` — tool args streaming (when output_item is function_call)
7. `response.output_text.done` — text block complete
8. `response.output_item.done` — message/function_call complete
9. `response.completed` — turn complete

### Tool call output format (for sending tool results back)
After receiving a function_call item, append to `input` array:
```json
{
  "type": "function_call",
  "call_id": "<from output_item>",
  "name": "<tool_name>",
  "arguments": "<json string>"
},
{
  "type": "function_call_output",
  "call_id": "<same call_id>",
  "output": "<result string>"
}
```
Then send the full `input` array (running history) on the next call.

### OAuth refresh
`POST https://auth.openai.com/oauth/token` with form-encoded body:
```
grant_type=refresh_token
refresh_token=<from auth.json>
client_id=app_EMoamEEZ73f0CkXaXp7hrann
```
Returns `{access_token, refresh_token, id_token}`.

---

## Architecture decision

**TWO backends in `@elizaos/native-reasoning`, selected by env:**

```ts
NATIVE_REASONING_BACKEND=anthropic   // default, current implementation
NATIVE_REASONING_BACKEND=codex        // new codex stealth backend
```

Each backend implements the same internal interface:

```ts
interface ReasoningBackend {
  callTurn(opts: {
    systemPrompt: string;
    messages: TurnMessage[];     // unified format across backends
    tools: NativeTool[];          // unified format, adapter converts per-backend
    abortSignal?: AbortSignal;
  }): Promise<TurnResult>;
}

interface TurnResult {
  text: string;                    // accumulated text content
  toolCalls: ToolCallRequest[];   // any tool calls model wants
}
```

`loop.ts` stays mostly unchanged — it just dispatches to the right backend based on env. The existing tool registry (Wave 1.B) is reused; the backend handles tool format conversion.

---

## Files to build

```
packages/native-plugins/native-reasoning/src/
├── backends/
│   ├── index.ts              # selectBackend(env) → ReasoningBackend
│   ├── anthropic.ts          # extracted from current loop.ts
│   ├── codex.ts              # NEW: chatgpt stealth backend
│   └── codex-auth.ts         # NEW: OAuth token refresh + account-id mgmt
├── tool-format/
│   ├── anthropic.ts          # NativeTool → Anthropic {type:"custom", input_schema}
│   └── openai.ts             # NEW: NativeTool → OpenAI {type:"function", parameters}
├── sse-parser.ts             # NEW: SSE → typed events for codex backend
├── loop.ts                   # MODIFIED: dispatch to backend
├── ...                        # rest unchanged
```

---

## Wave plan (4 builders parallel)

### Wave A: Backend abstraction + Anthropic refactor
- Define `ReasoningBackend` interface, `TurnMessage`, `ToolCallRequest`, `TurnResult` types in `src/backends/types.ts`
- Move existing Anthropic logic from `loop.ts` into `src/backends/anthropic.ts` implementing the interface
- Add `selectBackend(env)` in `src/backends/index.ts`
- Refactor `loop.ts` to use the backend abstraction
- Tests: existing tests pass, plus a backend-selection test

### Wave B: Codex stealth backend (the meat)
- `src/backends/codex.ts` — implements `callTurn` using chatgpt backend
- Handles streaming SSE, accumulates text + tool_calls, returns `TurnResult`
- Reads auth from `~/.codex/auth.json` (path overridable via `CODEX_AUTH_PATH` env)
- On 401: triggers `codex-auth.ts` refresh, retries once
- Handles `response.completed` / `response.failed` cleanly
- Uses `fetch` directly (no SDK)
- Tests with mocked SSE stream

### Wave C: SSE parser + OAuth refresh
- `src/sse-parser.ts` — parse SSE → typed events. Use a small streaming parser, no deps.
- `src/backends/codex-auth.ts` — `loadCodexAuth(path)`, `refreshCodexAuth(auth)`, `saveCodexAuth(path, auth)`
- Refresh logic atomic (lock file or write-temp-rename to prevent races between Sol + nyx hitting the same auth.json)
- Tests: SSE parsing edge cases (multi-line data, comments, etc), token refresh flow with mocked HTTP

### Wave D: OpenAI tool format + integration
- `src/tool-format/openai.ts` — convert `NativeTool` → OpenAI function tool
- Handles json-schema → openai-strict differences if any
- Wire into Wave B's codex.ts
- Update `loop.ts` to call `selectBackend()` instead of direct Anthropic
- Update `tool-format/anthropic.ts` to extract existing logic from loop.ts
- Tests: tool format roundtrip, integration test in mock-backend mode

---

## Risks + mitigations

1. **Account flag risk** (chatgpt session used by 2 devices simultaneously)
   - Mitigation: stagger requests via in-process semaphore, add 100-300ms jitter, monitor for soft-blocks
   - Document: if openai detects + flags, we have nyx's claude path as fallback

2. **Refresh token races** (Sol + nyx both refreshing the same token)
   - Mitigation: atomic file writes (write-temp-rename), short TTL on cached tokens (refresh 5min before expiry), shared file lock via `proper-lockfile` or `fs.flock`

3. **Codex protocol drift** (OpenAI changes endpoint/headers)
   - Mitigation: pin codex CLI version, version the user-agent string
   - When breakage detected, manual fix + bake into image

4. **Streaming complexity** (SSE parsing in long-running connections)
   - Mitigation: use `for await (const chunk of response.body)` with `TextDecoderStream`, abort on timeout, handle disconnects gracefully

---

## Acceptance criteria

- [ ] `NATIVE_REASONING_BACKEND=codex` makes nyx route via chatgpt backend
- [ ] First user message returns a streaming reply, accumulated and sent via callback
- [ ] Multi-turn tool use works: bash → result → next turn → reply
- [ ] OAuth refresh fires automatically when access_token expires
- [ ] Concurrent calls from Sol + nyx don't corrupt auth.json
- [ ] Total token usage (counted from response.completed.usage) logged for billing visibility
- [ ] Falls back to anthropic backend if codex-auth missing (configurable)
- [ ] All existing tests still pass (Wave 1.A-D unchanged)
- [ ] New backend has its own test suite (mocked HTTP/SSE)

---

## Out of scope (v1)

- Web search tool integration (codex's native web_search is different from Brave; defer)
- Image gen via codex's native image_gen tool
- `previous_response_id` continuation (we always send full history)
- Reasoning summaries (`reasoning.effort`, `reasoning.summary` — defer until needed)
- Per-account routing (multi-codex-account pool — Wave 2 of this project)

---

## Co-Authored-By
Co-authored-by: wakesync <shadow@shad0w.xyz>

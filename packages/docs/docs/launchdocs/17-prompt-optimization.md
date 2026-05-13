# Launch Readiness 17: Prompt Optimization

## Current Status

The runtime planner path is now native tool-call oriented. Prompt optimization
work should assume provider-standard `tools` / `tool_calls` transport first,
with JSON schema output reserved for non-tool structured responses.

## Open Work

- Keep source prompt files aligned with generated runtime prompts.
- Add held-out prompt-quality gates for planner action selection, argument
  validity, and final user response quality.
- Add token and byte budgets for native tool-call payloads, compacted action
  catalogs, provider context, and trajectory logging.
- Verify trajectory logs capture the exact messages, tools, tool calls,
  responses, token usage, and cache metadata sent to or received from providers.
- Keep local-model tests aligned with OpenAI-compatible, llama.cpp-compatible,
  and Cerebras-compatible function-calling shapes.

## Evidence To Review

- `packages/core/src/services/message.ts` for Stage 1 and planner tool-call
  plumbing.
- `packages/core/src/actions/to-tool.ts` for native tool definitions.
- `packages/core/src/services/trajectory-export.ts` and
  `packages/core/src/runtime/trajectory-recorder.ts` for replayable generation
  records.
- `packages/agent/src/runtime/prompt-compaction.ts` for presentation-layer
  prompt compaction.
- `packages/agent/src/runtime/conversation-compactor.ts` for conversation
  history compaction strategies.

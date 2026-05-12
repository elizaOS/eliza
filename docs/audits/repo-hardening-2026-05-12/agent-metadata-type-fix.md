# Agent Metadata Type Fix

Date: 2026-05-12

## Scope

- `packages/agent/src/runtime/conversation-compactor-runtime.ts`
- Electrobun typecheck blocker involving persisted conversation compaction metadata.

## Root Cause

`setConversationCompactionLedger` rebuilt room metadata by spreading
`room.metadata` through `Record<string, unknown>`. That preserved runtime
behavior, but it widened persisted fields such as `compactionHistory` to
`unknown[]`. `runtime.updateRoom` expects a core `Room`, whose `metadata` field
must satisfy `Metadata`, so Electrobun's typecheck rejected the widened object.

## Fix

The runtime now normalizes existing room metadata as core `Metadata` and keeps
the retained `compactionHistory` array typed as `MetadataValue[]`. The persisted
shape is unchanged:

- existing room metadata is preserved
- `lastCompactionAt` is still written when supplied
- `compactionHistory` is still capped to the most recent 20 entries
- `conversationCompaction` still stores the redacted prior ledger and counters

## Validation

- Pass: `/Users/shawwalters/.bun/bin/bun run --cwd packages/agent typecheck`
- Pass: `/Users/shawwalters/.bun/bin/bun run --cwd packages/agent test src/runtime/conversation-compactor-runtime.test.ts`
- Pass: `packages/app-core/platforms/electrobun/node_modules/.bin/tsc --noEmit -p packages/app-core/platforms/electrobun/tsconfig.json`

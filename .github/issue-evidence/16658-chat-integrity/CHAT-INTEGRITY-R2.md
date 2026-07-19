# #16658 Chat Integrity R2 Evidence

Date: 2026-07-19
Lane: sol-chat-integrity-r2
Signer: [sol-orch]

## Scope

- Guarded `useChatSend` optimistic rows, stream token/status/tool commits,
  terminal completion/failure edits, replay recovery, and post-turn reconcile
  behind the owning conversation id.
- Added a bounded pending-send receipt that reload recovery clears from server
  truth or restores to the composer after 30 seconds.
- Added unmount cleanup for active send controllers/refs so a new mount starts
  with an operable composer.

## Deterministic Checks

Passed:

```bash
bunx @biomejs/biome check packages/ui/src/state/useChatSend.ts packages/ui/src/state/ChatComposerContext.hooks.ts packages/ui/src/state/ChatComposerContext.test.tsx packages/ui/src/state/useDataLoaders.ts packages/ui/src/state/pending-chat-turns.ts packages/ui/src/state/useChatSend.test.tsx
```

Result: clean.

Passed:

```bash
git diff --check
```

Result: clean.

Focused test execution:

```bash
bun run --cwd packages/ui test -- src/state/useChatSend.test.tsx src/state/ChatComposerContext.test.tsx src/state/useDataLoaders.conversation-cache.test.tsx
```

Result: `ChatComposerContext.test.tsx` passed **7/7**. The send/data-loader
suites were blocked before collection by sparse/shared dependency resolution:
Vite could not resolve optional `@elizaos/capacitor-bun-runtime`. The send suite
contains deterministic regressions for active-conversation mutation during an
in-flight stream, lifecycle teardown retaining the pending receipt, and
explicit Stop clearing it.

## Browser / Visual Evidence

N/A - this change is state integrity logic with deterministic hook coverage, not
a visual redesign. Full staging browser capture was not run because the isolated
checkout cannot install the app/test dependency graph and has no running staging
browser target.

## Manual Review Notes

- Reviewed the send path for all state writes tied to the active transcript:
  optimistic user/assistant rows, throttled stream buffer, status clears, tool
  events, structured stream errors, 404 recreate/replay, retry timeout, generic
  failure restore, action/inbox sends, and post-turn `loadConversationMessages`.
- Reviewed reload recovery: a pending receipt is written once a conversation id
  and idempotency key exist, cleared when server messages contain the user turn,
  and restored to the composer only if the receipt still exists when the 30s
  recovery timer fires.

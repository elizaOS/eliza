# Chat Integrity R2 Receipt

Issue: elizaOS/eliza #16658
Date: 2026-07-19
Signer: [sol-orch]

## Root Cause

`#10753` pinned the transport conversation at enqueue time, but `useChatSend`
still wrote stream progress and settlement into one global
`conversationMessages` transcript. If conversation A streamed, failed, completed,
or reconciled after the user had navigated to conversation B, those callbacks
could mutate B's visible transcript or global turn status.

Reload during an unsettled send had a second gap: the composer draft was cleared
before the request settled, while the optimistic row lived only in memory. A
browser reload could therefore return with no usable draft until server history
eventually made the turn visible.

## Fix

- Conversation-owned mutation helpers now guard send-side transcript/status
  commits by the target conversation id.
- The streaming rAF buffer carries `conversationId`, so token, status, and tool
  events are dropped when they no longer belong to the active transcript.
- Main send and action/inbox send paths guard optimistic rows, final
  complete/fail/drop edits, interrupted partial reattach, failure restoration,
  and post-turn reconciliation.
- Unmount cleanup aborts active controllers and clears live refs/queue so a new
  mount cannot inherit a latched sending state, while preserving the durable
  receipt specifically for page teardown. Explicit Stop still settles it.
- Pending-send receipts in localStorage restore the composer after a bounded
  30s reload recovery window unless server truth clears the receipt first.

## Focused Regression Coverage Added

- `packages/ui/src/state/useChatSend.test.tsx`: prior conversation token,
  status, tool event, completion, and reconcile cannot project into the active
  transcript.
- `packages/ui/src/state/ChatComposerContext.test.tsx`: pending send restores
  to the composer after the bounded reload window, and does not restore after
  server truth clears the pending receipt.

## Verification

Passed:

```bash
bunx @biomejs/biome check packages/ui/src/state/useChatSend.ts packages/ui/src/state/ChatComposerContext.hooks.ts packages/ui/src/state/ChatComposerContext.test.tsx packages/ui/src/state/useDataLoaders.ts packages/ui/src/state/pending-chat-turns.ts packages/ui/src/state/useChatSend.test.tsx
git diff --check
```

Focused test execution:

```bash
bun run --cwd packages/ui test -- src/state/useChatSend.test.tsx src/state/ChatComposerContext.test.tsx src/state/useDataLoaders.conversation-cache.test.tsx
```

`ChatComposerContext.test.tsx`: **7/7 passed**, including bounded pending-turn
restore and server-truth cancellation. The other two suites were blocked before
test collection by the sparse/shared dependency graph: Vite could not resolve
the optional `@elizaos/capacitor-bun-runtime` dynamic import. Their added
regressions include active-conversation mutation during an in-flight stream,
lifecycle teardown retaining the receipt, and explicit Stop clearing it.

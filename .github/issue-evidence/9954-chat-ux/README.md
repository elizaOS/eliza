# #9954 — chat UX interleavings, real gesture E2E, jank/parity gates

Verification date: 2026-06-29
Verified tree: `origin/develop` at `06d475e67f`, plus local verify-cleanup branch
`chore/verify-lint-drift-995x` for formatting drift only.

## What was verified

- Conversation swipe/navigation logic is covered by unit/fuzz tests.
- Gesture E2E drives the real chat overlay rather than only a mock surface.
- Chat sheet E2E covers desktop and mobile drag/flick/nudge/collapse/maximize,
  no-provider recovery, reduced motion, keyboard, pill morphing, header
  visibility, streaming dots, and multi-send while responding.
- Render parity is covered so full ChatView and overlay ThreadLine render the
  same structural rich-message affordances.
- App-wide `audit:app` completed across 369 route/viewport cases with
  `broken=0`, `needs-work=0`, and `minimalism-budget-failures=0`.

## Evidence

Regenerate focused checks:

```bash
bun run --cwd packages/ui test:chatux-gesture-e2e
bun run --cwd packages/ui test:chat-sheet-e2e
bun run --cwd packages/ui test -- \
  src/components/chat/render-parity.contract.test.tsx \
  src/hooks/useConversationSwipeJank.test.ts \
  src/components/shell/conversation-nav.test.ts
```

Captured artifacts:

- `chatux-gestures.webm` — real overlay gesture walkthrough.
- `38-state-maximized-with-inset.png` — maximized sheet fills top-to-bottom with
  safe-area controls positioned correctly.
- `50-state-streaming-dots-in-bubble.png` — streaming indicator anchored inside
  the in-flight assistant bubble.
- `51-state-multi-send-while-responding.png` — send remains available with a
  draft while a previous response is in flight.

Full app audit:

```bash
bun run --cwd packages/app audit:app
```

Result: `369 passed`; audit summary:
`broken=0 needs-work=0 needs-eyeball=228 good=140 minimalism-budget-failures=0`.

Issue-relevant manual-review files filled locally:

- `packages/app/aesthetic-audit-output/manual-review/builtin-chat-*.md`
- `packages/app/aesthetic-audit-output/manual-review/builtin-tutorial-*.md`
- `packages/app/aesthetic-audit-output/manual-review/builtin-background-*.md`

## Manual review

I opened representative desktop/mobile chat, tutorial, and background audit
screenshots. Chat composer clearance is good on desktop and mobile, the mobile
welcome chips wrap without overlap, tutorial start state remains separated from
the bottom chat affordance, and background swatches wrap cleanly without
colliding with the composer.

I also opened the tutorial E2E `swipe-between-chats` frame and confirmed the
spotlight frames the visible chat target with a readable dialog.

## N/A

- Real-LLM trajectory: N/A. This issue is shell gesture/rendering behavior; no
  model path is changed.
- Audio/voice: N/A. Voice UI states are covered by the chat sheet visual state
  E2E, but no audio pipeline behavior changed.

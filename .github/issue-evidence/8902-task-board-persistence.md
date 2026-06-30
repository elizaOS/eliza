# #8902 Telegram task board persistence evidence

## Change

The Telegram task board now:

- pins a newly posted board message when the bot exposes `pinChatMessage`
- persists the board message id in runtime memory keyed by chat/thread
- loads the persisted id in a fresh `TelegramTaskBoard` instance so a restart can
  edit the existing board instead of posting a duplicate
- forgets persisted ids after an edit failure before reposting

## Validation

```text
bunx vitest run src/task-board.test.ts
Test Files  1 passed (1)
Tests       6 passed (6)
```

```text
bun run --cwd plugins/plugin-telegram lint:check
Checked 39 files. No fixes applied.
```

```text
bun run --cwd plugins/plugin-telegram build
Build success
```

## Remaining Evidence Gap

This PR covers the pinning and restart-safe message-id persistence gaps. The
issue still needs a live/mock Telegram scenario that drives `/tasks` through a
status change and captures the outbound Bot API calls before full closure.

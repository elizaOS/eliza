# #8902 Telegram Task Board Evidence

This evidence covers the local, credential-free acceptance work for #8902:

- `/tasks` posts a board message,
- the board message is pinned with `pinChatMessage`,
- the board id is persisted in runtime memory keyed to the Telegram
  chat/thread room,
- a fresh board instance after restart edits the persisted message instead of
  posting a duplicate.

## Commands

```bash
bun run --cwd plugins/plugin-telegram test -- src/task-board.test.ts src/messageManager.edit-react.test.ts src/command-registration.test.ts
bunx @biomejs/biome check plugins/plugin-telegram/src/task-board.ts plugins/plugin-telegram/src/task-board.test.ts plugins/plugin-telegram/src/service.ts plugins/plugin-telegram/src/command-registration.ts
bun run --cwd plugins/plugin-telegram build
```

Results:

- `telegram-task-board-tests.log`: 3 files, 30 tests passed.
- `biome.log`: focused Biome check passed.
- `build-attempt.log`: `tsup` succeeded; `tsc` failed on pre-existing
  `SetupState` export drift in `src/account-setup-routes.ts` and
  `src/setup-routes.ts`.

## Mock Bot API Report

`mock-bot-api-report.json` records the tested call sequence:

1. `sendMessage` creates the board.
2. `pinChatMessage` pins the created message.
3. runtime `upsertMemory` persists the board id.
4. a fresh `/tasks` command instance loads that persisted id and calls
   `editMessage` for the same message id instead of posting again.

## Live Scenario Status

A live scenario-runner trajectory with an actual Telegram Bot API delivery still
requires `TELEGRAM_BOT_TOKEN` and a target chat/thread. Those credentials are not
available in this environment, so no live Telegram screenshot/recording is
included here.

Automatic task-status-change updates remain a separate integration gap because
there is no current orchestrator task-change event exposed to this plugin; this
PR fixes the pinned/restart-safe single-board behavior without inventing a new
cross-plugin event contract.

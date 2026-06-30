# #8904 Telegram Screenshot Delivery Evidence

This evidence covers the remaining local, credential-free acceptance work for
#8904:

- total screenshot byte budget before dispatch,
- Telegram-photo-shaped `ContentType.IMAGE` attachments from the orchestrator,
- Telegram connector mapping of image attachments to Bot API `sendPhoto`.

## Commands

```bash
bun run --cwd plugins/plugin-agent-orchestrator test -- __tests__/unit/screenshot-delivery.test.ts
bun run --cwd plugins/plugin-telegram test -- src/messageManager.outbound-media.test.ts
bunx @biomejs/biome check plugins/plugin-agent-orchestrator/src/services/screenshot-delivery.ts plugins/plugin-agent-orchestrator/__tests__/unit/screenshot-delivery.test.ts plugins/plugin-telegram/src/messageManager.ts plugins/plugin-telegram/src/messageManager.outbound-media.test.ts
```

Logs:

- `orchestrator-screenshot-delivery-test.log`
- `telegram-outbound-media-test.log`
- `biome.log`

## Artifacts

- `delivered-image.png` is the image artifact used for the delivery-shape report.
- `dispatch-report.json` records the Telegram-targeted content shape: one
  `ContentType.IMAGE` attachment with `source: "sub-agent"`. The Telegram
  outbound media test proves this shape dispatches through `sendPhoto`.

## Live Scenario Status

A live scenario-runner trajectory with an actual Telegram Bot API delivery still
requires `TELEGRAM_BOT_TOKEN` and a target chat/thread. Those credentials are not
available in this environment, so the live trajectory is not included here.

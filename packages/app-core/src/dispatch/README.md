# dispatch

Future home of the dispatch infrastructure (`ConnectorRegistry`,
`ChannelRegistry`, `ApprovalQueue`, `send-policy`) currently implemented inside
`plugin-personal-assistant` (formerly `plugin-lifeops`). These primitives
belong in `@elizaos/app-core` because they coordinate cross-plugin sends —
they are *application* infrastructure, not personal-assistant feature code.

The classes here are stubs that throw `not implemented`. The interfaces are
stable contracts other packages may already type against; the implementations
arrive when the migration phase happens.

## Tracked migrations

- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/connectors -> packages/app-core/src/dispatch/connector-registry.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/channels -> packages/app-core/src/dispatch/channel-registry.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/approval-queue -> packages/app-core/src/dispatch/approval-queue.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/messaging -> packages/app-core/src/dispatch/send-policy.ts)`

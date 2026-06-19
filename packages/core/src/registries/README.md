# registries

Future home of cross-cutting registries (Anchor, Gate, EventKind, Escalation
Ladder, Family, Blocker) currently implemented inside `plugin-personal-assistant`
(formerly `plugin-lifeops`). These are structural lookups other features need
to reference without importing the plugin.

The classes here are stubs that throw `not implemented`. The interfaces are
stable contracts other packages may already type against.

## Tracked migrations

- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/anchor.ts -> packages/core/src/registries/anchor.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/gate.ts -> packages/core/src/registries/gate.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/event-kind.ts -> packages/core/src/registries/event-kind.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/escalation-ladder.ts -> packages/core/src/registries/escalation-ladder.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/family.ts -> packages/core/src/registries/family.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/blocker.ts -> packages/core/src/registries/blocker.ts)`

Implementations stay in the plugin until the migration phase.

# owner-state

Future home of owner-state services currently in `plugin-personal-assistant`
(formerly `plugin-lifeops`). These contracts are placeholders that document the
shape of the eventual core-resident services so other packages can reference
the types now without taking a runtime dependency on the plugin.

The concrete implementations are still owned by the plugin. The classes in this
directory are stubs that throw `not implemented` and exist only so consumers
can import the types and write code against the future contracts.

## Tracked migrations

- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/owner -> packages/core/src/owner-state/owner-facts.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/first-run -> packages/core/src/owner-state/first-run.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/handoff -> packages/core/src/owner-state/handoff.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/global-pause -> packages/core/src/owner-state/global-pause.ts)`
- `TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/pending-prompts -> packages/core/src/owner-state/pending-prompts.ts)`

The actual migration happens later when the rest of the workspace catches up;
do not move the implementations in this phase.

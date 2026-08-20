# `@elizaos/synthetic-world`

The canonical resettable test-world foundation for elizaOS. A single typed
manifest can boot an in-process test, a scenario-runner process, or a Cloud E2E
sidecar with identical state and virtual time.

```ts
import {
  SYNTHETIC_WORLD_SCHEMA_VERSION,
  bootInProcessWorld,
} from "@elizaos/synthetic-world";

const world = bootInProcessWorld({
  schemaVersion: SYNTHETIC_WORLD_SCHEMA_VERSION,
  worldId: "mail-reminder",
  seed: "mail-reminder-v1",
  clock: { epoch: "2030-01-01T08:00:00.000Z", timezone: "UTC" },
  data: {},
});

await world.clock.advanceBy(60_000);
world.reset();
```

Consumers keep using real production schedulers, repositories, queues, and
provider clients. They inject `world.clock.adapter` for time, wrap external
boundaries with `world.executeBoundary`, and inspect `world.ledger` for typed
evidence. `createProcessBootstrap` carries the same validated manifest and
namespace across a process or sidecar boundary.

`world.snapshot()` is a state-and-clock snapshot, not a serialization of live
callbacks. Restoring it clears the observation ledger and pending virtual
timers, resets named-fault attempts and the seeded random stream, and expects
production schedulers and queues to rehydrate their callbacks from restored
domain state.

See [`CLAUDE.md`](./CLAUDE.md) for ownership and fixture-safety rules.

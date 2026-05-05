# Migrating from executeGameTick

The existing game tick in `@babylon/engine` is a single ~900-line function that manually wires 17 subsystems. `@babylon/sim` lets you break that apart into individual systems, one at a time, without any big-bang rewrite.

## The bridge system

`createLegacyGameTickSystem()` wraps the entire `executeGameTick()` function as a single system:

```ts
import { BabylonEngine } from '@babylon/sim';
import { createLegacyGameTickSystem } from '@babylon/sim';

const engine = new BabylonEngine();
engine.use(createLegacyGameTickSystem());
await engine.boot();
await engine.tick();
```

This gives you the full existing game tick running inside the sim engine. All fields from `GameTickResult` are flattened into metrics (nested objects use dot notation, like `reputationSyncStats.total`). The full result object is also available via `ctx.shared.get('gameTickResult')`.

The bridge runs at `TickPhase.Bootstrap` with `skipDeadlineCheck: true`, since `executeGameTick()` manages its own internal deadline.

## Incremental extraction

The general approach is:

1. Start with the bridge running the full old tick.
2. Extract one subsystem (say, markets) into its own system file.
3. Remove that subsystem's code from `executeGameTick()` (or add a flag to skip it).
4. Run both the bridge and the new system together.
5. Verify the results match.
6. Repeat until the bridge is empty and can be removed.

## Running the bridge from the CLI

Both `dev` and `tick` commands accept `--legacy`:

```bash
bun dev --legacy              # dev mode with bridge
bun run tick --legacy         # single tick with bridge
bun run tick --legacy --loop  # loop with bridge
```

## What the bridge does not do

The bridge does not split the old tick into phases. It runs the entire thing as one atomic operation. You do not get per-subsystem metrics or error isolation from the parts still inside `executeGameTick()`. That only comes when you extract them into separate systems.

The bridge also does not use the engine's deadline gating (since it has `skipDeadlineCheck`). The old tick has its own internal deadline logic.

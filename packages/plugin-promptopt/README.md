# @elizaos/plugin-promptopt

Disk-backed **prompt optimization**: DPE hooks (merge, registry, traces), **`history.jsonl`**, neuro **quality signals**, **RUN_ENDED** trace finalization, A/B routing, background **`OptimizationRunner`**, and optional **GEPA / ACE** when `@ax-llm/ax` and `OPTIMIZATION_AI_*` are configured.

## Why this package exists (instead of living only in `@elizaos/core`)

- **Core stays small and policy-neutral.** `dynamicPromptExecFromState` must not depend on `node:fs`, resolver singletons, or a global “optimization enabled” flag. Tests and minimal agents run without pulling the whole pipeline.
- **One extension point.** `@elizaos/core` defines **`PromptOptimizationRuntimeHooks`** and calls them when **`registerPromptOptimizationHooks`** was used. This plugin supplies the **default** disk implementation and wires **neuro** evaluators / finalizers that were historically co-located with optimization.
- **Operators still get one switch.** Set **`PROMPT_OPTIMIZATION_ENABLED`** (and optionally **`OPTIMIZATION_DIR`**). This plugin’s **`init`** registers the default hook object when the flag is on and no other plugin has already registered hooks—so custom hosts can replace behavior without forking core.

## Install and enable

Add the workspace (or published) dependency to your agent, include **`promptOptPlugin`** (or the default export) in the character plugin list, and set:

```bash
PROMPT_OPTIMIZATION_ENABLED=true
# optional; defaults under ~/.eliza/optimization
OPTIMIZATION_DIR=/path/to/artifacts
```

**Why env + plugin, not “just env” in core:** Core does not read `PROMPT_OPTIMIZATION_ENABLED`, so the same core build can be used for benchmarks, CI, and production without implying disk side effects.

## Lifecycle: `init` and `dispose`

- **`init`:** If the setting is truthy and **`getPromptOptimizationHooks()`** is still null, registers a **module singleton** disk hook instance.
- **`dispose`:** If the registered hooks are **still that same singleton**, clears them with **`registerPromptOptimizationHooks(null)`**, then forwards **`neuroPluginInner.dispose`**.

**Why identity check on dispose:** Another plugin may have replaced hooks after ours; we must not wipe a foreign implementation. **Why a singleton default:** Matches “one process, one trace writer / resolver” assumptions and lets `dispose` reliably pair with `init`.

## Documentation map (WHY each doc)

| Doc | Purpose |
|-----|---------|
| [`../typescript/docs/PROMPT_OPTIMIZATION.md`](../typescript/docs/PROMPT_OPTIMIZATION.md) | End-to-end operator narrative: directory layout, DPE → traces → RUN_ENDED → runner, trajectory union rows, parsing pitfalls. |
| [`src/optimization/README.md`](src/optimization/README.md) | Pipeline internals for contributors maintaining merge, registry, runner, adapters. |
| [`src/optimization/ROADMAP.md`](src/optimization/ROADMAP.md) | Phased optimizer work and open questions. |
| [`ROADMAP.md`](ROADMAP.md) (this package root) | Short package-level forward look + pointer to the deep roadmap. |
| [`src/optimization/ARCHITECTURE.md`](src/optimization/ARCHITECTURE.md) | Component relationships inside the plugin. |

## API surface

- **Default export / `promptOptPlugin`:** Eliza **`Plugin`** (extends neuro plugin with the init/dispose behavior above).
- **`createDiskBackedPromptOptimizationHooks()`:** Factory for the hook object (tests or custom stacks can register it manually).
- **Re-exports** from `./optimization/index.ts` (runner, merge helpers, types, …) and neuro symbols for advanced wiring.

## Shared paths with core

**`sanitizeModelId`** and **`historyJsonlFilePath`** live in **`@elizaos/core`** so **`TrajectoryLoggerService`** can append optional JSONL rows to the **same** `history.jsonl` paths as **`TraceWriter`** without a core → plugin dependency cycle. **Why that matters:** One directory layout, one lock file per partition, no silent divergence between “optimizer traces” and “trajectory facts.”

## License

MIT (match repository root).

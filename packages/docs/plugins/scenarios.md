---
title: "Scenario Testing"
sidebarTitle: "Scenarios"
description: "Run end-to-end tests against a live agent runtime with @elizaos/scenario-runner."
---

`@elizaos/scenario-runner` is a lean scenario runner for the WS7 scenario-schema architecture. It loads `.scenario.ts` files, executes them against a real `@elizaos/core` `AgentRuntime` with a live LLM, and emits a JSON report.

Use it when:

- You want end-to-end coverage that includes the model (unit tests can't catch prompt regressions).
- You're verifying plugin behavior under realistic multi-turn conversation flow.
- You're collecting trajectory data for benchmarking or training.

## CLI

The package ships an `eliza-scenarios` binary.

```bash
bun add -D @elizaos/scenario-runner
bunx eliza-scenarios <path-to-scenario.ts>
```

Or run it as a project script:

```json
{
  "scripts": {
    "test:scenarios": "eliza-scenarios scenarios/"
  }
}
```

## Scenario shape

A `.scenario.ts` file exports a scenario object the runner knows how to load. The schema lives in `packages/scenario-runner/src/`.

## Reports

Each run emits a JSON report listing each step, the agent's response, and the verdict against the scenario's assertions. Hook this into CI to gate merges on scenario regressions.

## Source

- Package: [`packages/scenario-runner/`](https://github.com/elizaOS/eliza/tree/develop/packages/scenario-runner)
- Schema: `packages/scenario-runner/src/`

## See also

- [Plugin testing](/plugins/testing)
- [Benchmarks](/tracks/training/benchmarks)

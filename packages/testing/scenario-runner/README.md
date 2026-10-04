# @elizaos/testing/scenario-runner

Lean end-to-end scenario runner for elizaOS agents.

This directory is part of `packages/testing`.

No package build script is defined; this workspace is consumed from source.

Test from the repository root:

```bash
bun run --cwd packages/testing test
```

Candidate-only planner optimization lives in [the owning benchmark suite](../../benchmarks/suites/planner-optimization/README.md).

Scenario discovery accepts one definition in `*.scenario.ts` or an array of
individually validated definitions in `*.scenarios.ts`. Listing reads literal
metadata without importing modules; manifest entries must expose literal IDs.
`loadScenarioEntries` reads either form; singular `loadScenarioFile` rejects a
multi-entry manifest. Scenario IDs, lane selection and edge expansion are unchanged.

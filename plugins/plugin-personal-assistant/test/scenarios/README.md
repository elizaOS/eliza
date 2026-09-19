# Personal-assistant scenario corpus

Maintained definitions use `.scenario.ts` and declare their execution lane.
`live-only` evaluates model judgment and language; `pr-deterministic` exercises
real runtime behavior with explicit model fixtures that reject unexpected calls.

From the repository root:

```bash
bun run --cwd plugins/plugin-personal-assistant test:scenarios:list
bun run --cwd packages/scenario-runner test:lifeops:pr:e2e
```

The first command lists this corpus; the second executes its deterministic lane.
The personal-assistant package's separate `test:scenarios` command runs the
reminder scenarios in `packages/test/scenarios/reminders/` and the scheduled-task
spine in `packages/scenario-runner/test/scenarios/`.

Run changed scenarios in their declared lane and inspect their final state and
receipts. Listing metadata proves discovery, not successful execution.

# Quint state models

Place each specification beside its owning package in `quint/`. Its matching
`<Name>.cases.json` declares checked module instances, initialization and step
actions, invariants, temporal properties, simulation bounds and source paths.
Keep one case for every supported finite configuration. Unchecked model files,
unknown selections and missing source paths fail the runner.

```bash
bun run test:quint                       # exhaustive finite-state verification
bun run test:quint --simulate            # deterministic simulation only
bun run test:quint Serialise             # one specification
bun run test:quint --inventory           # source candidates and model links
bun run test:quint --inventory --require-complete
```

The repository pins Quint 0.33.1 and Apalache 0.62.4. Install dependencies with
`bun install`. Full verification needs Java 21. Quint downloads the backend
on first use, then compiles the Quint model and runs TLC. Native OTA conformance
also needs Go 1.27.1 on `PATH`, as pinned by the native trust engine. Generated backend
input is temporary. Maintained specifications are Quint.

Every case is typechecked and its Quint tests run before verification. The
full command checks safety and declared temporal properties over the finite
state space. Include `DeadlockFree` for cases that require an enabled next step.
Express progress with its actual fairness assumptions. Simulation uses a fixed
seed and the case's explicit trace bounds. It does not check temporal properties
or establish exhaustive coverage.

Reports and command logs go to repository-root `test-results/quint/`. They
record source hashes, tool version, commands and outcomes. Inventory discovery
uses source patterns as review candidates. A source link alone does not prove
implementation conformance or complete coverage. Keep known gaps in package
coverage manifests and provide real implementation checks with every state
change, as required by [PRD.md](../../../PRD.md#state-correctness).

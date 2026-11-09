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
bun run test:quint --shard=1/4            # one deterministic partition
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

Each name in a case's `temporal` list also needs a `temporalChecks` entry with
`property`, `expect` (`holds` or `counterexample`), and nonempty `assumptions`.
State explicitly when no fairness is assumed. Safety and positive temporal
properties run together; negative properties run separately. Expected negative checks pass only on a TLC
temporal counterexample with a loop, never on a tool error or safety violation.
Reports retain each expectation, assumption and observed result. TLC may check
always-state and always-action properties without printing a liveness-graph
pass. A positive result requires both TLC completion and the successful Quint
verifier receipt. The shutdown
liveness case checks both necessary timer fairness conditions and a fair failed
shutdown; it does not assume provider success or prove a wall-clock deadline.

Reports and command logs go to repository-root `test-results/quint/`. They
record source hashes, tool version, commands and outcomes. Inventory discovery
uses source patterns as review candidates. A source link alone does not prove
implementation conformance or complete coverage. Keep known gaps in package
coverage manifests and provide real implementation checks with every state
change, as required by [PRD.md](../../../PRD.md#state-correctness).

When a source review finds that a candidate owns no application state, record
it in the owning package's `quint/ownerless-sources.json` array. Include the
exact repository-relative `source` path, the file's `sha256` and a specific
`reason` based on the source. Review changed files again before updating a
hash. Remove the review when a model or coverage entry links the source.
`--require-complete` requires each candidate to have a model link or a valid
ownerless review. It also requires all declared gaps to be resolved. Review
application state beyond the candidates found by source patterns.

PR checks run four disjoint partitions. The required Quint check validates
all four reports against the current source, including every case, invariant,
temporal check and implementation hook. Missing or interrupted reports fail.
Shard reports use `test-results/quint/shard-N-of-4/`. Run local partitions in
separate worktrees when their implementation checks build shared artifacts.
Those independent local results retain their original absolute checkout paths;
the aggregate validator requires the same checkout path, as used by CI jobs.

# Cloud protocol models

Quint models describe bounded backend protocols. `contracts.json` links each
model to its implementation, invariants, assumptions, and remaining work.
These models do not prove that the TypeScript implementation refines the model.

From the repository root:

```sh
bun run test:cloud:formal          # types, scenario tests, seeded simulation
bun run verify:cloud:formal        # exhaustive finite-state checking (Java 17+)
bun run verify:cloud:formal:bounded # bounded symbolic checking (Java 17+)
bun run inventory:cloud:formal     # source candidates and coverage gaps
```

Quint is pinned in the cloud tooling package. Install with `bun install`.
Simulation checks sampled executions; TLC exhausts each finite model and symbolic
checking checks executions within the recorded bound. These checks do not prove
implementation refinement or liveness. External providers,
database isolation, process crashes, and fair scheduling must be modeled
explicitly before making claims about those behaviors.

Reports and counterexamples go to `test-results/cloud-formal/`. Source inventory
is a discovery aid, not a completeness proof: review implicit protocols as well
as declared status types. Add models and implementation regressions together.

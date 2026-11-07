# Cloud protocol models

Nine finite Quint models cover selected cloud protocols. Each model has a
checked `.cases.json` sidecar with source links, safety invariants, assumptions
and simulation bounds. Reviewed gaps remain in
[`../quint/protocol-coverage.json`](../quint/protocol-coverage.json).

From the repository root, run the shared checker.

```sh
bun run test:cloud:formal      # types, scenario tests and seeded simulation
bun run verify:cloud:formal    # exhaustive finite-state checking
bun run inventory:cloud:formal # source candidates and coverage gaps
```

The root package pins Quint 0.33.1. Install with `bun install`. Full checking
requires Java 21. Reports and counterexamples go to `test-results/quint/`.
See the [model workflow](../../scripts/quint/README.md).

These models check finite safety properties. They do not establish TypeScript
refinement, temporal progress, fair scheduling, provider correctness or
whole-backend coverage. Each sidecar states its own bounds and assumptions.

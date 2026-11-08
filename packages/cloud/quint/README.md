# Cloud protocol models

Finite Quint models cover selected cloud protocols. Each model has a
checked `.cases.json` sidecar with source links, safety invariants, assumptions
and simulation bounds. Reviewed gaps remain in
[`protocol-coverage.json`](protocol-coverage.json).

From the repository root, run the shared checker.

```sh
bun run test:cloud:formal      # types, scenario tests and seeded simulation
bun run verify:cloud:formal    # exhaustive finite-state checking
bun run inventory:cloud:formal # source candidates and coverage gaps
```

The root package pins Quint 0.33.1. Install with `bun install`. Full checking
requires Java 21. Reports and counterexamples go to `test-results/quint/`.
See the [model workflow](../../scripts/quint/README.md).

CLI and mobile authentication, job execution, campaign refunds, container
authority, and document and frontend publication conformance require a real
PostgreSQL database. Set
`INFERENCE_POLICY_TEST_POSTGRES_URL` to an existing isolated loopback database
with a `qa_*` role, or start a dedicated local container.

```sh
docker run --rm --detach --name eliza-quint-postgres \
  --publish 127.0.0.1:54329:5432 --env POSTGRES_USER=qa_quint \
  --env POSTGRES_DB=quint_protocol --env POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
export INFERENCE_POLICY_TEST_POSTGRES_URL=postgresql://qa_quint@127.0.0.1:54329/quint_protocol
bun run test:quint
docker stop eliza-quint-postgres
```

Authentication checks create and remove their own schemas. Document and frontend
publication checks create and drop unique databases, so the QA role also needs
`CREATEDB`. Missing database configuration fails conformance. PR and develop
Quint jobs provide this service.

These finite models do not establish TypeScript refinement, provider correctness
or whole-backend coverage. Each sidecar states its safety properties, supported
progress checks, fairness assumptions and remaining gaps.

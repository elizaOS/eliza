# e2e coverage reports

Two complementary coverage reports live in this directory. Both read real
source statically, without booting the runtime, and share `inventory.ts`.

1. **Surface coverage report (issue #8802)** — lists slash commands, pre-LLM
   shortcuts, plugin-declared HTTP routes, views, and their recorded e2e
   evidence.
2. **Per-plugin keyless-e2e report (issue #8801)** — lists plugins exposing an
   agent surface and whether a credential-free deterministic scenario covers
   each one.

Neither report derives a merge decision from a baseline, inventory count, or
minimum coverage threshold. The actual test artifacts retain their normal
behavioral pass/fail semantics.

## Surface coverage report

The surface report inventories user-triggerable slash commands, shortcuts,
plugin routes, and views. It records evidence and gaps so maintainers can see
what is exercised without using source-file enumeration as a substitute for
running those tests.

The relevant pieces are:

- `inventory.ts` discovers surfaces and resolves their recorded evidence.
- `manifest.ts` records known route, command, shortcut, and view artifacts.
- `write-coverage-matrix-report.ts` writes JSON, Markdown, and an HTML viewer
  under `reports/coverage/`.

A recorded `covered` entry only resolves when every cited artifact exists and
each declared signal appears in at least one artifact. Known shape-only tests
are rejected as evidence. This keeps the report honest, but a report gap remains
diagnostic rather than becoming a separate CI policy.

Run it with:

```bash
bun packages/scripts/e2e-coverage/write-coverage-matrix-report.ts --report-dir reports/coverage
bun test packages/scripts/__tests__/e2e-coverage-report.test.ts
```

## Per-plugin keyless-e2e report

The keyless report identifies plugins with actions or connectors and partitions
them by whether a credential-free deterministic scenario covers the surface.
It has no historical baseline and always exits successfully after a valid
inventory scan.

```bash
bun run report:e2e-coverage
bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --list-uncovered
bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --json
```

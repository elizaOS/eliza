# @elizaos/testing

Private workspace for repository-wide scenarios and deterministic runtime, model, database and connector test fixtures. This package is not published or imported by the production runtime.

Use `createDeterministicModelPlugin` with explicit fixtures and assert their consumption. Unexpected requests and exhausted fixtures fail; do not replace those failures with canned catch-all success. Use `createTestRuntimeWithModelProvider` to execute the real runtime against local PGlite. Live-provider helpers are opt-in and distinct from required deterministic tests.

Register `onTestFinished(harness.cleanup)` immediately after acquiring a per-test model runtime, or use the existing suite teardown hook for suite-owned runtimes. Avoid assertion-body `try/finally` cleanup: a leftover-fixture error would replace the original assertion error. Vitest teardown reports both failures.

Run `bun run --cwd packages/testing test` and `bun run --cwd packages/testing typecheck`.

For ephemeral storage, import `SQLiteDatabaseAdapter` or `initializeTestRuntime` from `@elizaos/testing/sqlite-adapter`. The helper registers isolated storage only when the test has supplied no adapter, then calls the real runtime initialization. Production hosts must choose their own persistence explicitly.

`@elizaos/testing/capability-protocol-fixture` supplies the canonical protocol
payloads for capability-router tests and the local conformance server. Production
core exports protocol types and execution, not fixture data.

## Shared scenario corpus

Repository-wide scenarios live in `scenarios/`; product-specific scenarios stay
with their owning packages and plugins. Run `test:scenarios` for corpus guard
tests and full scenario validation, or `scenarios:validate` for discovery alone.
The package `test` and `typecheck` commands cover both fixtures and scenarios.
Live-model scenario execution remains explicit through the scenario runner.

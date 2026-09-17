# @elizaos/testing

Private workspace fixtures for deterministic runtime, model, database and connector tests. This package is not published or imported by the production runtime.

Use `createDeterministicModelPlugin` with explicit fixtures and assert their consumption. Unexpected requests and exhausted fixtures fail; do not replace those failures with canned catch-all success. Use `createTestRuntimeWithModelProvider` to execute the real runtime against local PGlite. Live-provider helpers are opt-in and distinct from required deterministic tests.

Run `bun run --cwd packages/testing test` and `bun run --cwd packages/testing typecheck`.

For ephemeral storage, import `InMemoryDatabaseAdapter` or `initializeTestRuntime` from `@elizaos/testing/in-memory-adapter`. The helper registers isolated storage only when the test has supplied no adapter, then calls the real runtime initialization. Production hosts must choose their own persistence explicitly.

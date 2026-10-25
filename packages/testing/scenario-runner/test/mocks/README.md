# External API mocks

`@elizaos/testing/mocks` owns the canonical route catalog and stateful handlers
used by scenarios and synthetic worlds. `startMocks` binds isolated loopback
ports and returns settings, snapshots, an ordered request ledger and cleanup.
World manifests accept all registered services; unmatched routes fail evidence.

The legacy `mockoon/start-all.mjs` and `stop-all.mjs` commands retain fixed local
ports using pinned Bun 1.4.2 and one canonical mock process. Shutdown authenticates
the owning process instead of signaling saved PIDs. Logs and the private control
record live under `test-results/mock-services/`. Google calendar's compatibility
port proxies the same state as Gmail.

For standalone Mockoon, `node mockoon/_generate.mjs` exports the canonical route
files to `test-results/mock-services/mockoon/`. Exports preserve response rules;
stateful runtime handlers remain available through `startMocks`.

Run `bun run --cwd packages/testing test` from the repository root.

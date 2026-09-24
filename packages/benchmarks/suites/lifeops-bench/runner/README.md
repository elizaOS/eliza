# LifeOpsBench TS runner (`@elizaos/lifeops-bench`)

HTTP bridge exposing the elizaOS `AgentRuntime` to the Python benchmark
runners in this repo (LifeOpsBench, terminal-bench, vending-bench, clawbench,
OSWorld, and the `harnesses/eliza` adapter all speak to it).

```
Python benchmark runner
    |  (harnesses/eliza eliza_adapter, HTTP)
src/server.ts (this package)
    |  (messageService.handleMessage / AgentRuntime.useModel)
elizaOS AgentRuntime
```

This package was extracted from the elizaOS monorepo (`packages/lifeops-bench`).
It depends on published `@elizaos/*` packages at the `beta` dist-tag and is
never published itself.

## Setup and run

```bash
cd suites/lifeops-bench/runner
bun install
bun run benchmark:server        # prints ELIZA_BENCH_READY port=<port> when up
```

Known gap (as of the extraction): several published `@elizaos/*` beta packages
still pull unpublished transitive versions (`@elizaos/cloud-shared`,
`@elizaos/plugin-remote-manifest`, `@elizaos/plugin-worker-runtime`,
`@elizaos/registry`), so `bun install` fails until those are published. Until
then, run the server from an elizaOS monorepo checkout that still bundles
`packages/lifeops-bench` (the `harnesses/eliza` server manager scans
`ELIZA_MONOREPO_ROOT` for one first).

Vitest source-mode aliases (used by `bun run test`) resolve `@elizaos/*` into a
monorepo checkout — set `ELIZA_REPO_DIR` to an elizaOS checkout with
dependencies installed.

The Python side discovers this server through
`harnesses/eliza/eliza_adapter/server_manager.py`; see `src/README.md` for the
per-file map and the bench protocol.

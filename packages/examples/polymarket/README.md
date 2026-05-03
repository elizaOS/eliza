# Polymarket demo agent (TypeScript)

This folder contains a small **autonomous Polymarket demo agent** CLI (TypeScript TUI).

The CLI supports:

- `verify`: validate config + wallet derivation (offline by default)
- `once`: run one market decision tick (`--network` required)
- `run`: loop decision ticks (`--network` required)

Uses:

- `plugin-wallet` for wallet handling
- `plugin-polymarket` for Polymarket CLOB access

## Production assumptions

- **Network stability**: `--network` requires access to the public CLOB API (`CLOB_API_URL`, default `https://clob.polymarket.com`).
- **Wallet safety**: `--execute` will place real orders. Use a dedicated funded test wallet and keep keys out of shell history.
- **API schema drift**: the CLOB `/markets` response can change shape (e.g. numbers vs strings, optional/null fields). Future schema changes can still break live runs.

## Monitoring / alerting integration points

- **Exit codes**: the CLI exits **0** on success and **1** on failure, so it can be supervised by systemd/Kubernetes/Cron.
- **Logging**: TypeScript prints errors to **stderr** (and normal output to stdout).
- **Recommended**: wrap the CLI in a supervisor that captures stdout/stderr to your log pipeline and pages on non-zero exit or repeated failures.

## Rollback

Roll back by deploying the previous git SHA/tag (or reverting the commit(s) that changed demo/plugin behavior) and re-running the same test commands used here.

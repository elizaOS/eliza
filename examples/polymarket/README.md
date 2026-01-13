# Polymarket Demo Agent (multi-language)

This folder contains a small **autonomous Polymarket demo agent** with a CLI in:

- `typescript/`
- `python/`
- `rust/`

Each CLI supports:

- `verify`: validate config + wallet derivation (offline by default)
- `once`: run one market decision tick (`--network` required)
- `run`: loop decision ticks (`--network` required)

All implementations use:

- `plugin-evm` for wallet handling
- `plugin-polymarket` for Polymarket CLOB access

## Production assumptions

- **Network stability**: `--network` requires access to the public CLOB API (`CLOB_API_URL`, default `https://clob.polymarket.com`).
- **Wallet safety**: `--execute` will place real orders. Use a dedicated funded test wallet and keep keys out of shell history.
- **API schema drift**: the CLOB `/markets` response can change shape (e.g. numbers vs strings, optional/null fields). Rust parsing was hardened, but future schema changes can still break live runs.
- **Python environment**: for `POLYMARKET_LIVE_TESTS=1`, the Python environment must be able to install `py-clob-client` and a compatible `eth-account` (pre-release may be required on newer Python versions).

## Monitoring / alerting integration points

- **Exit codes**: all CLIs exit **0** on success and **1** on failure, so they can be supervised by systemd/Kubernetes/Cron.
- **Logging**:
  - TypeScript prints errors to **stderr** (and normal output to stdout).
  - Python exits with a concise error message on failure.
  - Rust prints errors to **stderr** and exits non-zero.
- **Recommended**: wrap the CLI in a supervisor that captures stdout/stderr to your log pipeline and pages on non-zero exit or repeated failures.

## Rollback

- Roll back by deploying the previous git SHA/tag (or reverting the commit(s) that changed demo/plugin behavior) and re-running the same test commands used here.


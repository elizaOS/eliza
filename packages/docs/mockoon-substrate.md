# Mockoon substrate

The lifeops benchmark and the lifeops scenario suite run against an
18-environment [Mockoon](https://mockoon.com/) fleet by default. Every
connector code path the planner can take is exercised end to end without
touching production APIs, which makes runs deterministic, repeatable, and free
of side effects on real Gmail accounts, real Plaid items, real Twilio numbers,
etc.

This page documents the substrate itself: what it spawns, how callers opt in,
how the redirect happens, and what to do when it fails.

For per-environment endpoint inventories, see
`test/mocks/mockoon/INVENTORY.md`. For the scenario-to-env coverage map and
known gaps, see `test/mocks/mockoon/COVERAGE.md`.

## Architecture

```
        agent runtime / plugin-google / lifeops actions
                       │
                       │ fetch("https://gmail.googleapis.com/gmail/v1/...")
                       ▼
        plugin-google client-factory.ts reads ELIZA_MOCK_GOOGLE_BASE
        (set by applyMockoonEnvOverrides() at module load when
         LIFEOPS_USE_MOCKOON=1)
                       │
                       │ rewritten URL
                       ▼
        http://127.0.0.1:18801  ← Mockoon "gmail" environment
                       │
                       ▼
        route handlers in test/mocks/mockoon/gmail.json
        (happy path on the canonical route; 429 / 401 / 500 selected by
         X-Mockoon-Fault header or ?_fault= query)
```

Each connector has its own environment, its own port (18801 through 18818
today), and its own consumer-code env-var override. The override mapping lives
in a single place:
`plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts` —
`applyMockoonEnvOverrides()`.

## Components

### Bootstrap — `scripts/lifeops-mockoon-bootstrap.mjs`

One job: bring the whole fleet up, prove every port binds, export
`LIFEOPS_USE_MOCKOON=1`, and tear children down on parent exit.

Two callable surfaces:

**(a) Programmatic, for other Node scripts:**

```js
import { ensureMockoonRunning } from "./scripts/lifeops-mockoon-bootstrap.mjs";
const handle = await ensureMockoonRunning();
// handle.connectors === [{ name, connector, port, pid, ownedHere }, ...]
// handle.stop()      — idempotent; SIGTERMs everything we spawned
```

By default the bootstrap registers `SIGINT` / `SIGTERM` / `exit` hooks so the
mock fleet dies with the parent. Pass `{ keepAlive: true }` to opt out (used
by the `--start` CLI mode so the fleet survives after the launcher exits).

**(b) CLI, for shell use:**

```sh
node scripts/lifeops-mockoon-bootstrap.mjs --start   # spawn + detach
node scripts/lifeops-mockoon-bootstrap.mjs --status  # which ports are UP
node scripts/lifeops-mockoon-bootstrap.mjs --stop    # SIGTERM all pids
```

**Idempotency:** if a port is already listening when the bootstrap runs, that
env is *not* re-spawned. `connectors[].ownedHere` is `false` for those entries
and `stop()` won't touch them.

**Mockoon binary resolution order:**

1. `$MOCKOON_BIN` (must point at an existing file).
2. `mockoon-cli` on `$PATH`.
3. The repo-local npx cache at
   `~/.npm/_npx/dcd5374e2bba9184/node_modules/.bin/mockoon-cli`.
4. `npx --yes @mockoon/cli@latest` (cold-start adds ~30s per env).

Install `@mockoon/cli` globally to skip steps 3 and 4:

```sh
npm i -g @mockoon/cli@latest
```

**Logs and pid files:**

- Mockoon stdout/stderr per env: `test/mocks/mockoon/.mockoon-logs/<env>.log`
- Recorded pids (for `--stop` cleanup):
  `test/mocks/mockoon/.mockoon-pids/<env>.pid`

Both directories are created lazily on first run and ignored by git.

### Redirect helper — `plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts`

A single `applyMockoonEnvOverrides()` function. It is called by the lifeops
plugin at module load when `LIFEOPS_USE_MOCKOON=1`, and it sets:

| Env var                       | Value                       | Consumer                                  |
| ----------------------------- | --------------------------- | ----------------------------------------- |
| `ELIZA_MOCK_GOOGLE_BASE`      | `http://127.0.0.1:18801/`   | `plugin-google` client-factory (gmail + calendar share root) |
| `ELIZA_MOCK_TWILIO_BASE`      | `http://127.0.0.1:18808/`   | `lifeops/twilio.ts`                       |
| `NTFY_BASE_URL`               | `http://127.0.0.1:18812`    | `lifeops/notifications-push.ts`           |
| `ELIZAOS_CLOUD_BASE_URL`      | `http://127.0.0.1:18816`    | every cloud-managed lifeops client        |
| `SIGNAL_HTTP_URL`             | `http://127.0.0.1:18818`    | `lifeops/signal-local-client.ts`          |
| `LIFEOPS_DUFFEL_API_BASE`     | `http://127.0.0.1:18813`    | `lifeops/travel-adapters/duffel.ts`       |
| `ANTHROPIC_BASE_URL`          | `http://127.0.0.1:18814`    | `@anthropic-ai/sdk` (failure-injection)   |
| `OPENAI_BASE_URL`             | `http://127.0.0.1:18815/v1` | Cerebras / OpenAI-compatible callers      |

Plus `getMockoonBaseUrl(<connector>)` for the connectors whose upstream
clients have no env-var seam yet (slack, discord, telegram, github, notion,
bluebubbles, apple-reminders, spotify). Tests that exercise those connectors
thread the returned base URL into the relevant client constructor explicitly.

### Smoke — `scripts/lifeops-mockoon-smoke.mjs`

Single-shot self-test. It runs the substrate end to end:

1. Calls `ensureMockoonRunning()`. Fails if any of the 18 ports does not
   bind within the per-port timeout.
2. Asserts `LIFEOPS_USE_MOCKOON=1` was exported as a side effect.
3. Loads `applyMockoonEnvOverrides()` (falling back to manual env override if
   the consumer can't import the `.ts` source under plain `node`).
4. `fetch()`s the Gmail mock at the loopback URL the plugin would use
   (`${ELIZA_MOCK_GOOGLE_BASE}gmail/v1/users/me/messages?q=is:unread`) and
   asserts the response shape matches the gmail fixture (`messages[]` +
   `resultSizeEstimate`).
5. Re-fetches with `X-Mockoon-Fault: rate_limit` and asserts a 429.
6. Calls `handle.stop()` so the spawned mock fleet exits cleanly.

Exits 0 on success, non-zero with the failing assertion on failure.

## How to run

The benchmark runner spawns the fleet automatically when `LIFEOPS_USE_MOCKOON`
is unset or `1`:

```sh
bun run lifeops:full
```

Opt out for one-off live-API runs (useful when chasing a connector regression
that the mocks have papered over):

```sh
LIFEOPS_USE_MOCKOON=0 bun run lifeops:full
```

Manual fleet lifecycle while iterating on a single env:

```sh
node scripts/lifeops-mockoon-bootstrap.mjs --start
# ...edit test/mocks/mockoon/foo.json, hit it with curl...
node scripts/lifeops-mockoon-bootstrap.mjs --stop
```

Self-test the substrate after changing the redirect helper or any env file:

```sh
node scripts/lifeops-mockoon-smoke.mjs
```

## Fault injection

Every environment ships the same three fault rules on every route. Trigger
them by header or query:

| Trigger                                | Response                                      |
| -------------------------------------- | --------------------------------------------- |
| `X-Mockoon-Fault: rate_limit` *or* `?_fault=rate_limit`     | `429` with `Retry-After: 1` |
| `X-Mockoon-Fault: auth_expired` *or* `?_fault=auth_expired` | `401` with a provider-shaped error body |
| `X-Mockoon-Fault: server_error` *or* `?_fault=server_error` | `500` |

The `anthropic` env is failure-only by design (no happy path); use it to
exercise retry/back-off paths against the planner.

## Operational notes

- **Ports.** 18801 through 18818 are claimed today (see the env table in
  `COVERAGE.md`). The 18789 / 31337 / 2138 / 2142 / 18790 / 18789 dev-server
  ports from `CLAUDE.md` are deliberately avoided.
- **Orphan processes.** The bootstrap's `SIGINT` / `SIGTERM` / `exit` hooks
  reliably reap children when the parent exits cleanly. A hard kill
  (`kill -9`) can leak; `node scripts/lifeops-mockoon-bootstrap.mjs --stop`
  reads `.mockoon-pids/` and TERM/KILLs whatever is recorded.
- **CI.** Mockoon-CLI's cold start under `npx` is slow. CI should either
  pre-install `@mockoon/cli` globally or cache `~/.npm/_npx/`.
- **Adding a new connector.** Drop a new `<service>.json` under
  `test/mocks/mockoon/`, add a route handler set with the three standard
  fault rules, extend `applyMockoonEnvOverrides()`, append a row to
  `test/mocks/mockoon/COVERAGE.md` and `INVENTORY.md`.

# Local test console

A one-command web console for running the repo's entire test surface locally:

```bash
bun run test:console        # → http://127.0.0.1:31338
```

It exists because most "needs-human" verification work is blocked on
credentials: live suites need API keys, OAuth tokens, or an Eliza Cloud
login that CI does not have. The console lets a human connect everything
once, see exactly which suites those connections arm, run everything, and
keep the artifacts.

## What it does

- **Enumerates every test task** from `run-all-tests.mjs --plan=json --all`
  (unit, integration, e2e, ui, live, plus the cloud step) — the same source
  of truth CI uses.
- **Shows what's enabled/disabled and why.** Guarded live suites come from
  `packages/scripts/lib/real-live-suites.mjs`; each task renders badges like
  `armed`, `needs anthropic`, `opt-in`, `probe`, or `blocked`, computed with
  the same `computeRealLiveAccounting` the post-merge lane prints.
- **Connections panel**: save API keys and tokens for every service the
  guarded suites need (LLM providers, Discord/Telegram/Slack/X/WhatsApp,
  GitHub/Linear/Calendly/Twilio, health connectors, web3, Postgres, …), log
  in to Eliza Cloud via the device-code flow, or mint Google OAuth refresh
  tokens through the console's loopback callback. Each connection has a
  read-only **Verify** probe that proves the credential against the real API
  before any suite depends on it.
- **Runs with live status** (queued → running → passed/failed/skipped) over
  SSE, with per-task log streaming, run/re-run-failed/re-run-one/cancel, and
  filterable results.
- **Persists everything** under `~/.eliza/test-console/` (override with
  `ELIZA_TEST_CONSOLE_DIR`, or `ELIZA_STATE_DIR/test-console`):
  - `credentials.json` — saved connection values, `0600`
  - `runs/<runId>/run.json` + `runs/<runId>/logs/*.log` — full run archives
  - `history.json` — last status per task, so "Re-run failed" works across
    restarts
  - `settings.json` — opt-in gate toggles, cloud base URL

## Lanes

- **Deterministic (keyless)** — `TEST_LANE=pr` semantics: real-API suites
  excluded, LLM proxy on. Everything runs without secrets.
- **Live (real APIs)** — `TEST_LANE=post-merge` semantics: saved credentials
  are injected into the child env, guarded suites arm/self-skip exactly as
  the post-merge lane accounts for them. Opt-in gates (destructive/heavy
  suites) stay off unless toggled explicitly.

Each task executes as its own `run-all-tests.mjs --filter='^<label>$'`
invocation, so lane env, Postgres auto-provisioning, and empty-suite skip
logic stay identical to CI. Credentials never enter the console server's own
environment; they are injected per child process.

## Security

The server binds `127.0.0.1` only and must stay that way: it stores raw
keys and executes repo code. Saved secrets never reach the browser — the UI
gets presence + last-4 hints. Private keys are never transmitted for
verification (format check only).

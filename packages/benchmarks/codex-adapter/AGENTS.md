# Codex Adapter — Agent Guide

Skeleton harness bridge that lets the benchmark orchestrator run benchmarks
against the **Codex CLI** agent, authenticated per OpenAI-Codex account
(#10193/#10199). API-shaped like `smithers-adapter`; select it with
`--adapters codex` and iterate accounts with `--accounts <n|list>`. Not
registered as a standalone benchmark — it wraps other benchmarks.

Each turn spawns a one-shot `codex exec` subprocess authenticated **as** a
selected account by pointing `CODEX_HOME` at that account's materialized home
(`<stateDir>/auth/_codex-home/<accountId>/`, written by the TS runtime's
`coding-account-bridge.ts`). The orchestrator process imports no Codex/Node
dependency — it only needs the `codex` binary (or `CODEX_BIN`) and at least one
materialized home.

## Layout

| Path | Role |
| --- | --- |
| `codex_adapter/accounts.py` | `CODEX_HOME` discovery + `--accounts` parsing + round-robin (fully offline-testable) |
| `codex_adapter/client.py` | `CodexClient` — one-shot `codex exec` turn as the selected account |
| `tests/` | Offline pytest suite (account selection, rotation, failure modes) |

## Run + test

- Live run (credential-gated): see [`../docs/HITL_MULTI_CODEX_RUNBOOK.md`](../docs/HITL_MULTI_CODEX_RUNBOOK.md).
- Offline tests: `pytest codex-adapter/tests/ -v`.

## Notes

- **`--accounts`**: integer `N` = first `N` accounts; `a,b` = exactly those ids;
  omitted = all. Turns round-robin: turn `i` → `accounts[i % len]`.
- The client **never fabricates a response** — a missing binary, an
  unauthenticated account (`auth.json` absent), or a nonzero `codex exec` raises.
- A live gpt-5.5 run needs real authenticated Codex homes + entitlement; the
  offline suite proves the account-selection/iteration logic without a model.

## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
> Nothing here is *done* until it is *proven* done — a reviewer must confirm it works
> **without reading the code**, from the artifacts you attach. "Tests pass" is not proof.

- **Record AND read model trajectories** from a **live** LLM (here: a real
  gpt-5.5 Codex account), not a mock. A captured-but-unread trajectory is not evidence.
- **Real, full-featured E2E — no larp.** Drive the real path end to end incl.
  error/edge/concurrency/adversarial input. A test asserting against a mock
  standing in for the thing under test does not count.
- **No residuals, no shortcuts.** Clear blockers by the hard path. The live
  multi-Codex run is credential-gated: mark it N/A with the reason (no Codex
  creds in this env) — never fake it.

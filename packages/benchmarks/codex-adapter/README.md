# Codex Adapter

Harness bridge that lets the benchmark orchestrator run benchmarks against the
**Codex CLI** agent, authenticated per OpenAI-Codex account. Skeleton adapter,
API-shaped like `smithers-adapter` / `hermes-adapter` / `openclaw-adapter`:
select it with `--adapters codex` and iterate accounts with
`--accounts <n|list>`.

Each turn spawns a one-shot `codex exec` subprocess (non-interactive) that reads
the prompt on stdin and prints the assistant output on stdout. The subprocess is
authenticated **as** a selected account by pointing `CODEX_HOME` at that
account's materialized home. Not registered as a standalone benchmark — it wraps
other benchmarks run against the Codex harness.

## Multi-account CODEX_HOME

The elizaOS runtime materializes one `CODEX_HOME` per authenticated account so a
spawned Codex process authenticates as that account instead of the machine's
single `~/.codex` login. The layout (written by
`packages/app-core/src/services/coding-account-bridge.ts`):

```
<stateDir>/auth/_codex-home/<accountId>/
    active-home                         # relative, non-secret pointer
    generations/<refresh-token-hash>/
        auth.json                       # chatgpt-mode tokens
        config.toml                     # pinned model (gpt-5.5)
```

where `<stateDir>` is `$ELIZA_HOME` (or the resolved per-user state dir,
default `~/.local/state/eliza`). This adapter's `codex_adapter.accounts`
enumerates account roots, validates each atomically-published `active-home`, and
round-robins turns across the selected set. It does **no** OAuth and no network;
materializing the generations is the TS runtime's job. Account roots created
before generation isolation remain discoverable when the pointer is absent or
contains `.`.

## `--accounts` semantics

- integer `N` → the first `N` discovered accounts (sorted by id);
- comma list `a,b` → exactly those account ids, in order;
- omitted → all discovered accounts.

Turns round-robin: turn `i` uses `accounts[i % len(accounts)]`.

## Run (live — credential-gated)

See [`../docs/HITL_MULTI_CODEX_RUNBOOK.md`](../docs/HITL_MULTI_CODEX_RUNBOOK.md).
A live run requires real authenticated Codex homes and the gpt-5.5 model those
accounts are entitled to:

```bash
python -m benchmarks.orchestrator review \
  --benchmarks bfcl --adapters codex \
  --model-profile gpt-5.5 --accounts 3 \
  --out benchmark_results/review/codex-bfcl
```

## Test (offline)

```bash
pip install -e codex-adapter/
pytest codex-adapter/tests/ -v
```

Tests are fully offline — account discovery, `--accounts` parsing, round-robin
rotation, and client failure modes, with no API keys or real Codex install.

## Layout

| Path | Role |
| --- | --- |
| `codex_adapter/accounts.py` | Multi-account `CODEX_HOME` discovery + `--accounts` selection + round-robin |
| `codex_adapter/client.py` | `CodexClient` — one-shot `codex exec` turn as the selected account |
| `tests/` | Offline pytest suite |

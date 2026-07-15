# HITL multi-Codex + gpt-5.5 benchmark runbook (#10193 / #10199)

How an operator with **N authenticated OpenAI-Codex accounts** runs the
benchmark suite against **gpt-5.5** through the Codex harness, rotating turns
across accounts, and packages a human-reviewed scorecard.

> **This is a credential-gated (HITL) live run.** It requires real logged-in
> Codex accounts and gpt-5.5 entitlement. There is **no** offline substitute for
> the model call — do not fabricate scores. The scaffolding (adapter, account
> selection, `review` wrapper, count/matrix reconciliation) is offline-verified;
> the model run below is the part a human with credentials performs.

## 1. What "N Codex accounts" means

The elizaOS runtime materializes one `CODEX_HOME` per authenticated account so a
spawned `codex` process authenticates as that account instead of the machine's
single `~/.codex` login. Each home lives at:

```
<stateDir>/auth/_codex-home/<accountId>/
    active-home                         # relative, non-secret pointer
    generations/<refresh-token-hash>/
        auth.json                       # chatgpt-mode tokens
        config.toml                     # pinned model
```

`<stateDir>` = `$ELIZA_HOME` (or the resolved per-user state dir, default
`~/.local/state/eliza`). To materialize a home, authenticate the account in the
elizaOS runtime (Codex OAuth / ChatGPT login). The benchmark side does **no**
OAuth — it only points `CODEX_HOME` at homes that already exist.

Verify what is materialized:

```bash
ls "${ELIZA_HOME:-$HOME/.local/state/eliza}/auth/_codex-home/"
# one directory per accountId, each pointing at an active generation
```

## 2. Preconditions

- The `codex` CLI on `PATH` (or set `CODEX_BIN`).
- At least one materialized `CODEX_HOME` with a valid `auth.json`.
- gpt-5.5 entitlement on each account (`orchestrator/profiles/gpt-5.5.json`
  selects `provider=openai`, `model=gpt-5.5`).
- The codex adapter installed: `pip install -e codex-adapter/` (from
  `packages/benchmarks/`).

## 3. Run it

From `packages/benchmarks/`, run the single operator wrapper. It chains
**preflight → run → validate gates → review-package → verify-artifacts** and
fails loudly if any step can't proceed:

```bash
python -m benchmarks.orchestrator review \
  --benchmarks bfcl action-calling \
  --adapters codex \
  --model-profile gpt-5.5 \
  --accounts 3 \
  --reviewer-note "opened the codex trajectories per account and spot-checked tool calls" \
  --out benchmark_results/review/codex-gpt55
```

- `--accounts 3` selects the first 3 materialized accounts (sorted by id).
  `--accounts acct-a,acct-c` selects those exact ids in order. Omit it to use
  all materialized accounts.
- `--adapters codex` resolves the Codex harness; `--model-profile gpt-5.5` sets
  `provider=openai model=gpt-5.5`.
- Turns round-robin across the selected accounts: turn `i` uses
  `accounts[i % N]`.
- `--all` runs every registered benchmark instead of `--benchmarks <ids>`.
- `--rerun-failed` / `--force` control idempotency, forwarded to the run step.

The wrapper prints a per-step status line and exits nonzero if **any** step
fails (a harness that can't run, a scorer that can't parse, missing
trajectories, an incomplete/blocked readiness gate, or a committed generated
artifact).

## 4. What lands where

| Artifact | Location |
| --- | --- |
| Per-benchmark run output (result JSON, trajectories, telemetry) | `benchmark_results/…` (**gitignored** — never committed) |
| Normalized `latest/` snapshot rows (`<benchmark>__<harness>.json` + `index.json`) | `benchmark_results/latest/` (**gitignored**) |
| Reviewed scorecard + manifest | `--out <dir>` (e.g. `benchmark_results/review/codex-gpt55/{scorecard.md,manifest.json}`) |

Only the **reviewed markdown scorecard** and lightweight manifest are meant to
leave the machine (attach them to the PR / issue evidence). Everything under
`benchmark_results/` is generated and gitignored; `verify-artifacts` (chained
last) fails the wrapper if any generated output is staged for commit.

## 5. Transcribing to RESULTS_MATRIX.md

Only scores that clear `validate-latest-*` + `review-package` and come from
`benchmark_results/latest/` (never `benchmark_results/baselines/`) may be
transcribed into `docs/RESULTS_MATRIX.md`. A cell with no committed graded
`latest/` run stays `not-run`. Do not invent a `1.00`.

## 6. What is offline-verified vs. credential-gated

**Offline-verified (in this change):**

- codex adapter resolves under `--adapters codex`;
- `--accounts <n|list>` selection + round-robin iteration
  (`codex-adapter/tests/`);
- the `review` wrapper wiring, preflight/validate/verify chaining, and loud
  failure when the run step lacks what it needs;
- registry count (44) + matrix reconciliation guards (`tests/test_ci_coverage.py`).

**Credential-gated (operator, live):**

- the actual gpt-5.5 model turns through each Codex account;
- the resulting per-account trajectories and graded scores.

Mark the live run **N/A with a reason** in PR evidence when run in an
environment without Codex credentials — never substitute a fabricated result.

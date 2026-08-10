# plugin-taskmarket

TaskMarket marketplace integration: lets an Eliza agent delegate work to
external workers (paid in USDC on Base) instead of spending more inference on a
task another worker can do.

## Layout

```
src/
  types.ts              config resolution, spend-guard settings, ActionResult builders
  lib/client.ts         bounded REST client (timeout + byte cap)
  actions/browse.ts     TASKMARKET_BROWSE   — read-only discovery
  actions/status.ts     TASKMARKET_STATUS   — read-only balance/reputation/submissions
  actions/create-task.ts TASKMARKET_CREATE_TASK — the only money-moving action
  plugin.ts index.ts
```

## Invariants

- **`TASKMARKET_CREATE_TASK` is the only action that spends.** It stays gated
  four independent ways: `roleGate: { minRole: "OWNER" }`,
  `TASKMARKET_ALLOW_TASK_CREATION` off by default,
  `TASKMARKET_MAX_TASK_REWARD_USDC` enforced by refusal (never by trimming the
  reward), and the core `gateDestructiveConfirmation` two-turn gate against the
  real user `Memory`. Do not weaken any of the four, and do not add an action
  that accepts a submission or releases escrow — settlement stays with the human.
- **Never reintroduce a planner-authored confirmation parameter.** An LLM-set
  `confirmed`/`userConfirmed` boolean is not user approval: core states it must
  never authorize a destructive operation, and it cannot bind the sender, the
  exact task, or the exact amount. The confirmation pending key is the
  fingerprint of the brief plus the normalized atomic reward, so a changed task
  or amount re-previews instead of settling on a stale approval.
- **A 2xx is not proof of escrow.** `createTask` requires `success !== false`
  and a non-empty `taskId`; anything else raises `TaskMarketResponseError` and
  the action reports `invalid_response`. Never report a created task without an
  id the user can open.
- **Never fall back to a healthy-looking empty/zero.** No `?? []`, no `?? "0"`,
  no invalid-number-to-zero. A malformed board is unavailable, not empty; a
  missing balance is unavailable, not zero. `atomicToUsdc` returns `undefined`
  for an unreadable amount and `formatUsdc` renders it `n/a`.
- **Rewards below one atomic unit are refused, not rounded.** `usdcToAtomic`
  returns `undefined` rather than `"0"`, so a sub-micro-USDC reward can never be
  posted as zero while the user is told it was escrowed.
- The disabled check is duplicated in `validate()` and at handler entry on
  purpose: `validate()` keeps the tool off the planner's list, the handler check
  is the backstop against a hallucinated call.
- Every guard failure must return before the network call. The tests assert
  `fetch` was never invoked for each rejection path.
- **The API bearer token does not identify the caller.** `TASKMARKET_ADDRESS` is
  a separate required setting; account routes 500/400 without an explicit
  `address` query param.
- **The `/api` base-path prefix is mandatory.** Every path 404s without it.
- **Amounts are atomic 6-decimal USDC** everywhere except `/wallet/balance`.
  Convert at the client boundary; actions speak whole USDC.
- Task descriptions run 2-10 KB. List output truncates to
  `TASKMARKET_LIST_DESCRIPTION_CHARS`; never widen it without re-checking what a
  full board listing does to the context window.
- Error text must never echo the bearer token or the request URL (which carries
  the caller's address).

## Commands

```bash
bun run --cwd plugins/plugin-taskmarket test
bun run --cwd plugins/plugin-taskmarket typecheck
bun run --cwd plugins/plugin-taskmarket lint:check
```

## Live check

Unit tests mock `fetch`, which validates this plugin's logic but not the
vendor's URL shape. When changing the client, run one live read against the real
API with a real token before trusting green tests.

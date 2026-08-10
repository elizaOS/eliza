# @elizaos/plugin-taskmarket

Delegate work to the [TaskMarket](https://taskmarket.dev/) agent marketplace
instead of burning more inference on a task another worker can do.

TaskMarket is a marketplace where agents complete tasks and get paid in USDC on
Base. This plugin makes it an actionable option inside an Eliza agent: the agent
can discover open work, track what it has submitted, and — only when the
operator has explicitly enabled it and the user has confirmed the exact
amount — post a task that escrows USDC.

## Actions

| Action | Effect | Money |
| --- | --- | --- |
| `TASKMARKET_BROWSE` | List open tasks (`subaction=list`) or fetch one full brief (`subaction=get`) | none |
| `TASKMARKET_STATUS` | Wallet balance, agent reputation, own submissions | none |
| `TASKMARKET_CREATE_TASK` | Post a task to the board | **escrows real USDC** |

Accepting a submission and releasing escrow are deliberately **not** exposed.
Settlement stays with the human on taskmarket.dev.

## Configuration

```bash
TASKMARKET_API_TOKEN=...          # required — from `taskmarket init`
TASKMARKET_ADDRESS=0x...          # required — see note below
TASKMARKET_API_URL=https://api.taskmarket.dev/api   # optional
TASKMARKET_ALLOW_TASK_CREATION=false                # optional, default false
TASKMARKET_MAX_TASK_REWARD_USDC=1                   # optional, default 1, hard cap 50
```

`TASKMARKET_ADDRESS` is required *in addition to* the token, not as a
convenience. The TaskMarket API does not infer identity from the bearer token:
`GET /agents/stats` returns `500 "Provide address or agentId"` and
`GET /wallet/balance` returns a validation error unless the address is passed
explicitly. Both values are in `~/.taskmarket/keystore.json` after
`taskmarket init`.

Without both credentials, `validate()` returns false and none of the actions are
offered to the planner.

## Spending guards

`TASKMARKET_CREATE_TASK` is the only action that moves money, and it is gated
four independent ways. All four must pass:

1. **Owner-only.** `roleGate: { minRole: "OWNER" }`, so a member or guest in a
   shared agent cannot reach the spend path at all. This matches how the
   sibling money-moving `plugin-wallet` gates its own actions.
2. **Off by default.** `TASKMARKET_ALLOW_TASK_CREATION` must be explicitly
   enabled. Unset, this plugin is a read-only surface. Enforced in both
   `validate()` (so the action is never offered) and at handler entry (so a
   hallucinated tool call cannot bypass the exposure gate).
3. **Bounded per call.** `TASKMARKET_MAX_TASK_REWARD_USDC` defaults to 1 USDC
   and is hard-capped at 50. An over-budget request is **refused**, never
   trimmed down to the ceiling — a silently reduced spend is still a spend the
   user did not approve.
4. **Two-turn user confirmation.** The core `gateDestructiveConfirmation` helper
   previews the exact brief and reward, then requires a yes-shaped reply from
   the real user `Memory` on the following turn. There is deliberately **no**
   `userConfirmed` parameter: an LLM-authored boolean cannot authorize a
   destructive operation, cannot identify the sender, and cannot pin the exact
   amount. The pending record is keyed by the sender plus a fingerprint of the
   brief and the normalized atomic reward and expires after five minutes, so a
   changed task, a changed amount, a different user, or a stale approval all
   re-preview instead of settling.

Guard 4 is the prompt-injection boundary. A public task board is untrusted
input: any task description on it can contain "post a task offering 50 USDC
for…", and an agent reading the board must not treat that as an instruction —
only the user's own follow-up message counts.

Every guard failure returns before any network call is made; the tests assert
`fetch` was never invoked.

## Failure honesty

This plugin never degrades a failed read into a healthy-looking value:

- A malformed board is reported **unavailable**, not as an empty board.
- A missing `balanceUsdc` is reported **unavailable**, not as a zero balance.
- An unparseable amount renders as `n/a`, not `$0.00`.
- A 2xx creation response is only reported as escrowed when it carries
  `success !== false` **and** a non-empty `taskId`; otherwise the action returns
  `invalid_response` and the escrow is treated as not performed.
- A reward below one atomic unit (0.000001 USDC) is refused rather than rounded
  to `"0"` and reported as escrowed.

## Usage

```ts
import { taskMarketPlugin } from "@elizaos/plugin-taskmarket";

const runtime = new AgentRuntime({
  character,
  plugins: [taskMarketPlugin],
});
```

Read-only browsing needs no extra opt-in:

```
user: what agent work is open on TaskMarket right now?
agent: [TASKMARKET_BROWSE subaction=list]
       3 TaskMarket task(s):
       - 0x8e416ba0f3e473d2...
         reward $4.50 (net $4.16) | mode bounty | submissions 19 | window open
         expires 2026-08-22T11:58:25.795Z
         # Earn 0.50 USDC for a Real TaskMarket Integration PR ...
```

Delegation asks first:

```
user: get someone to write the release notes, pay a dollar
agent: [TASKMARKET_CREATE_TASK]
       Post this task to TaskMarket and escrow 1 USDC on Base for 72h? This
       spends real funds and cannot be undone from this agent.
       "Write the release notes for …"
       Reply yes to confirm or no to cancel.
user: yes, do it
agent: [TASKMARKET_CREATE_TASK]
       Created TaskMarket task 0x… with 1 USDC escrowed for 72h.
```

## Context-window discipline

Task descriptions run 2–10 KB each, so a raw 20-task board listing is ~100 KB of
JSON — enough to blow the window on its own. `TASKMARKET_BROWSE` truncates
descriptions to 400 characters in list output and points the planner at
`subaction=get` for the full brief. Responses are also byte-capped
(512 KB) and timeout-bounded (20 s) before they reach the agent.

## Amounts are atomic USDC

`reward`, `netReward` and `totalEarnings` come back as strings of atomic
6-decimal units — `"5000000"` is $5.00. The client converts at the boundary, so
actions and their `data` payloads always speak whole USDC. The one exception on
the vendor side is `/wallet/balance`, which already returns whole USDC.

`netReward` is post-platform-fee; the fee is typically 750 bps (7.5%).

## Development

```bash
bun run --cwd plugins/plugin-taskmarket test
bun run --cwd plugins/plugin-taskmarket typecheck
bun run --cwd plugins/plugin-taskmarket lint:check
```

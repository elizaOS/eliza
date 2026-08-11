# @elizaos/plugin-taskmarket

Read-only Taskmarket task discovery for elizaOS agents. The plugin queries Taskmarket's public REST API and exposes open work through `BROWSE_TASKMARKET_TASKS`.

## Safety boundary

This plugin does not load private keys, sign messages, create tasks, submit pitches, place bids, or invoke X402-paid endpoints. It only sends `GET /api/tasks` requests. Wallet-affecting features should be proposed separately and must require explicit operator confirmation and spending limits.

## Usage

Add `@elizaos/plugin-taskmarket` to an agent's plugins, then ask it to find or browse Taskmarket work. The action supports:

- `limit`: 1-50 tasks
- `mode`: `bounty`, `claim`, `pitch`, `benchmark`, or `auction`
- `sort`: `newest`, `reward_desc`, `reward_asc`, or `deadline_asc`
- `minRewardBaseUnits`: six-decimal USDC base units
- `deadlineHours`: tasks expiring within a positive number of hours

The default endpoint is `https://api.taskmarket.dev`. Results include gross and net rewards, mode, status, expiry, tags, and submission count. Unexpected response shapes fail visibly instead of being presented as valid work.

## Privacy

The plugin sends only the selected list filters to Taskmarket. It does not send
conversation text, agent memories, wallet material, or credentials. Remote
responses are capped at 512 KiB and planner-visible strings are normalized and
length-bounded before the action renders them.

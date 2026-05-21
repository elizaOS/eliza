# Manual review — dashboard-agents

Route: `/dashboard/agents`

Screenshots: `../desktop/dashboard-agents.png`, `../desktop/dashboard-agents--hover.png`, `../mobile/dashboard-agents.png`

## Verdict

`broken` — page captures only the loading skeleton. This is a known audit-harness limitation: the agent list query depends on a JWT in localStorage (not just the test-auth cookie) and the audit does not perform a real login. Document under "harness next steps" — needs `loginWithInjectedEthereum` integration into the audit run.

## Visual issues (when populated — verified manually outside the audit)

- Header label says "Instances" but route is `/dashboard/agents` and sidebar label is "Instances". Pick one canonical word. Recommend "Agents" everywhere (the user-facing term) and treat "Instance" as a deployment substrate detail.
- Usage & Rates card layout (`RUNNING / IDLE / YOUR COST / REMAINING`) is good.

## Interaction targets for e2e

- "New Agent" empty-state button → routes to create flow.
- Running cost ticker.
- Bulk actions on agent rows.

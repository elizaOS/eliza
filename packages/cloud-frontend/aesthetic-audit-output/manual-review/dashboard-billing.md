# Manual review — dashboard-billing

Route: `/dashboard/billing`

Screenshots: `../desktop/dashboard-billing.png`, `../desktop/dashboard-billing--hover.png`, `../mobile/dashboard-billing.png`

## Verdict

`broken` — captures the "Something went wrong / Unauthorized" error boundary. Same harness limitation as dashboard-agents: real JWT required.

## Action

- Switch the audit to drive a real `loginWithInjectedEthereum` session before capturing dashboard routes. Until then this verdict cannot be advanced.

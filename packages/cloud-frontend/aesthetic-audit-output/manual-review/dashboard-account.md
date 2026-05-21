# Manual review — dashboard-account

Route: `/dashboard/account`

Screenshots: `../desktop/dashboard-account.png`, `../desktop/dashboard-account--hover.png`, `../mobile/dashboard-account.png`

## Verdict

`broken` — captures the "Something went wrong" error boundary. Same harness limitation.

## Notes

- UserMenu component logs "Failed to fetch user profile" — this is the upstream cause of the error boundary. Once the audit uses real auth this error will not occur.

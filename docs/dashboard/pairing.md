---
title: Pairing
sidebarTitle: Pairing
description: Authenticate with the Milady dashboard by entering a pairing code from the server logs.
---

The Pairing View is the authentication screen shown when the dashboard cannot connect with an authenticated session. You must provide a pairing code to establish a secure connection between the dashboard and the agent runtime.

## How Pairing Works

1. Start the Milady agent — a one-time pairing code is printed to the server logs
2. Open the dashboard — the Pairing View appears if no valid session exists
3. Enter the pairing code from the server logs
4. The dashboard exchanges the code for an API token and stores it for future sessions

## Pairing Screen

The screen displays a centered card with:

- **Title** — "Pairing Required"
- **Pairing code input** — a text field for entering the code from server logs
- **Submit button** — disabled when the input is empty or submission is in progress
- **Expiry countdown** — shows remaining time before the code expires (format: `M:SS`), or "Expired" if the code has timed out
- **Error display** — shows pairing errors (e.g., invalid code, expired code)

## When Pairing Is Not Enabled

If the server does not have pairing enabled, the screen shows:

1. "Pairing is not enabled on this server."
2. Instructions to either:
   - Ask the server owner for an API token
   - Enable pairing on the server and restart Milady

## After Pairing

Once pairing succeeds, the dashboard stores the API token and redirects to the main dashboard. The token persists across browser sessions — you won't need to pair again unless the token is revoked or expires.

## Related

- [Authentication API](/rest/auth) — REST API endpoints for auth status and pairing
- [API Reference](/api-reference) — full API authentication documentation

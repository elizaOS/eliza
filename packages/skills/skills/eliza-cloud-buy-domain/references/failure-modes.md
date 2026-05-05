# Domain Buy Failure Modes

| Status | Meaning | Correct response |
| --- | --- | --- |
| 400 | Invalid domain format | Ask for a normal hostname like `myapp.com`. |
| 402 | Not enough Cloud credits | Tell the user to top up in billing before buying. |
| 404 | App missing or wrong organization | Re-check `appId`; do not charge or retry blindly. |
| 409 | Domain unavailable or attached elsewhere | Suggest alternatives from `/domains/search`. |
| 502 | Cloudflare registration failed | The API refunds the debit; report the error and retry only if the user wants. |

Never auto-buy a paid domain. The user must explicitly confirm the exact domain
after seeing the price.

If the same user asks to retry the same domain after a partial success, call the
same `/domains/buy` route once. It can recover local metadata for a domain that
Cloudflare already registered and returns `alreadyRegistered` instead of
charging again.

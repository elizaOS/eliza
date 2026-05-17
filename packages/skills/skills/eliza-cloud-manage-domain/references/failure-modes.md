# Domain Management Failure Modes

| Status | Meaning | Correct response |
| --- | --- | --- |
| 400 | Invalid domain or DNS record body | Ask for corrected input. |
| 403 | Caller does not own the app/domain | Stop; do not reveal other org metadata. |
| 404 | App, domain, or DNS record not found | Re-list the app's domains or records. |
| 409 | Operation does not apply to this domain | Explain the boundary, usually external DNS vs Cloudflare-managed DNS. |
| 502 | Cloudflare or DNS provider error | Report the provider error and retry later if appropriate. |

Use Cloud API state plus direct DNS/HTTP checks. Do not rely on search results
or registrar landing pages for live status.

Never detach a domain or delete DNS records without explicit confirmation.

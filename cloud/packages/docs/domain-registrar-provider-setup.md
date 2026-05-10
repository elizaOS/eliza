# Domain Registrar Provider Setup

Eliza Cloud domain purchase APIs use Cloudflare as registrar and DNS provider.
The public agent surface is:

- `POST /api/v1/domains/search`
- `GET /api/v1/domains`
- `POST /api/v1/apps/{id}/domains/check`
- `POST /api/v1/apps/{id}/domains/buy`
- `GET /api/v1/apps/{id}/domains`
- `POST /api/v1/apps/{id}/domains/status`
- `POST /api/v1/apps/{id}/domains/sync`
- `GET|POST|PATCH|DELETE /api/v1/apps/{id}/domains/{domain}/dns...`

## Required Cloudflare Setup

Configure these secrets for the API Worker/runtime:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The token must be scoped to the Cloudflare account that will own registrations
and zones. It needs enough permissions for domain registration, zone creation,
DNS record CRUD, and registrar/domain reads. Use the narrowest Cloudflare token
template that supports those operations in the target account.

For local non-billing tests, use:

- `ELIZA_CF_REGISTRAR_DEV_STUB=1`

That stub path verifies API shape and refund logic without buying a real domain.

## Agent Safety Rules

- A domain purchase is paid and externally visible. Require explicit
  confirmation of domain, app id, total price, renewal behavior, and credit
  source before `/buy`.
- Always call `/check` or `/domains/search` before `/buy`.
- Do not use web search snippets to decide if a domain is available or owned.
- If Cloudflare registration fails, rely on the Cloud route refund path and
  report the provider error instead of retrying alternate routes.
- DNS record deletes and domain detaches are destructive and must be confirmed.

## Live Verification

1. `GET /api/v1/domains` with `ELIZAOS_CLOUD_API_KEY`.
2. `POST /api/v1/apps/{id}/domains/check` for a low-risk test domain.
3. Confirm the quoted total before buying.
4. `POST /api/v1/apps/{id}/domains/buy`.
5. Poll `POST /api/v1/apps/{id}/domains/status`.
6. If DNS edits are needed, list records first and update by provider record id.

Do not run live purchases from a dirty deployment bundle. Verify the deployed
Cloud Worker has the current route code and the expected Cloudflare secrets.

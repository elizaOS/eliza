---
name: eliza-cloud-buy-domain
description: "Use whenever a user wants to register or buy a custom domain for an Eliza Cloud app — including in the same request as building the app (\"build me X and put it on Y.com\"). Uses Cloudflare as registrar after explicit user confirmation, paid from the user's existing cloud credit balance. Pairs with `build-monetized-app` (build first, then buy domain) and `eliza-cloud-manage-domain` (post-purchase: list, edit dns records, detach). Skip when the user is fine with the auto-assigned `*.apps.elizacloud.ai` subdomain."
---

# Buy a domain for your app on Eliza Cloud

Use this skill when an Eliza Cloud app needs a real custom domain (e.g. `myapp.com`) instead of the auto-assigned `*.apps.elizacloud.ai` subdomain.

The cloud handles everything: domain availability check, registration through cloudflare, DNS pointing at your app's container, and attachment to your app record. You pay from your existing cloud credit balance — no separate cloudflare account, no manual DNS config, no credit card paste.

## Prerequisites

- An app registered on Eliza Cloud (use `build-monetized-app` first if you haven't shipped one yet)
- Enough cloud credit balance to cover the domain (cloudflare wholesale + a fixed eliza cloud margin; a `.com` is roughly $14–15 USD/year)
- Either the parent-agent Cloud command bridge in an orchestrated worker, or
  `ELIZAOS_CLOUD_API_KEY` in the parent/app runtime. Do not pass wallet private
  keys or owner Cloud API keys into a spawned child process.

## Default flow

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
  // optional override for local dev / staging / preview deploys.
  // unset in prod → SDK defaults to https://www.elizacloud.ai
  baseUrl: process.env.ELIZA_CLOUD_BASE_URL,
});

// 1. quote — confirms availability + total price the user will pay
const quote = await cloud.routes.postApiV1AppsByIdDomainsCheck({
  pathParams: { id: appId },
  json: { domain: "myapp.com" },
});
if (!quote.available) {
  // try a different domain or pick an alternate TLD
  return;
}
const totalUsd = quote.price.totalUsdCents / 100;

// 2. confirm with the user (one-line ack is enough; the SDK will throw
//    if the org balance is insufficient)
//
//    "buying myapp.com for $14.95 from your cloud balance — ok?"

// 3. buy — atomic on the cloud side: debit credits → register via cloudflare
//    → write managed_domains row + attach to app → CNAME the new zone at
//    the app's container url. Refunds credits if registration fails. If the
//    domain is already owned by this org, this returns alreadyRegistered
//    without charging again.
const result = await cloud.routes.postApiV1AppsByIdDomainsBuy({
  pathParams: { id: appId },
  json: { domain: "myapp.com" },
});

// 4. (optional) poll status until verified — cloudflare registration is
//    usually live within seconds; ssl provisioning may take 1–2 minutes
const status = await cloud.routes.postApiV1AppsByIdDomainsStatus({
  pathParams: { id: appId },
  json: { domain: "myapp.com" },
});
```

When this flow runs inside an orchestrated worker, prefer the deterministic
parent-agent commands instead of direct SDK credentials:

```text
USE_SKILL parent-agent {"mode":"list-cloud-commands","query":"domains"}
USE_SKILL parent-agent {"mode":"cloud-command","command":"domains.check","params":{"id":"<appId>","body":{"domain":"myapp.com"}}}
USE_SKILL parent-agent {"mode":"cloud-command","command":"domains.buy","confirmed":true,"params":{"id":"<appId>","body":{"domain":"myapp.com"}}}
```

## Failure modes

The buy route handles refunds and surfaces specific HTTP statuses; treat them like:

| Status | Meaning | Action |
|---|---|---|
| 400 | invalid domain format | re-prompt user for valid domain |
| 402 | insufficient credit balance | tell user to top up at /dashboard/billing |
| 404 | app not found / wrong org | re-check appId |
| 409 | domain unavailable or owned by another org | suggest alternates or add a suffix |
| 502 | cloudflare returned an error (refund issued) | retry with different domain |

The buy route is idempotent for domains already owned by the same org. If a
previous run reached Cloudflare but local zone/status metadata arrived late,
retry the same canonical `/buy` route once; report `alreadyRegistered: true` or
`pendingZoneProvisioning: true` honestly. Never try alternate guessed buy routes.

## Read these references in order

1. `references/api-shape.md` — the actual request/response shape for each cloud endpoint
2. `references/dns-and-ssl.md` — what happens after the buy (CNAME setup, SSL provisioning timing)
3. `references/failure-modes.md` — recovery table for the failures you'll actually hit

After the buy succeeds, future "list / edit / delete dns / detach" requests on this domain are handled by the `eliza-cloud-manage-domain` skill — point the user there if they ask follow-up questions.

## What this skill is NOT

- **Not for "attaching a domain you already own elsewhere."** That path goes through `POST /api/v1/apps/[id]/domains` directly (which generates a `_eliza-cloud-verify.<domain>` TXT record the user adds at their existing dns provider, then re-checks via `POST /api/v1/apps/[id]/domains/verify`). Use this `buy-domain` skill only when the user does NOT already own the domain.
- **Not for cancelling a registration.** Cloudflare registrations are non-refundable after they're complete; you can detach from the app via `DELETE /api/v1/apps/[id]/domains` but the registration itself stays active until expiration.
- **Not for transferring an existing domain into eliza cloud.** Out of scope for v1.

---
name: eliza-cloud-manage-domain
description: "Use after a domain has been purchased through Eliza Cloud (via the `eliza-cloud-buy-domain` skill) when the user wants to look at, edit, or remove a domain or its DNS records. Covers org-wide domain listing, per-app DNS record CRUD on cloudflare-managed zones, status re-sync, external-attachment verification, and detaching a domain from an app. Use this skill any time the user references domains they already own (`my domains`, `edit dns for myapp.com`, `delete that A record`, `is myapp.com still pointing at my app`)."
---

# Manage your Eliza Cloud domains

Use this skill once the user already has at least one domain attached to one of their apps (registered via `eliza-cloud-buy-domain` or attached as external via the `/domains` POST). It covers everything after the buy: looking at what they own, editing DNS records on cloudflare-managed zones, refreshing live status, and detaching from an app.

It does NOT register new domains — that's `eliza-cloud-buy-domain`. It does not modify DNS on external (user-owned-elsewhere) domains — those records live at the user's existing DNS provider.

For live status checks, use the Cloud API plus direct HTTP/DNS/RDAP requests.
Do not use web search snippets or registrar-search pages to decide whether a
domain is bought, attached, or serving an app; those results can be stale.

## What this skill can do

| User intent | Endpoint | Notes |
|---|---|---|
| "list my domains" / "what domains do I own" | `GET /api/v1/domains` | org-wide across all their apps |
| "what domains does {app} have" | `GET /api/v1/apps/{appId}/domains` | per-app |
| "did myapp.com get bought" / "is it active" | `POST /api/v1/apps/{appId}/domains/status` | one attached domain's live registrar status |
| "show dns records for myapp.com" | `GET /api/v1/apps/{appId}/domains/{domain}/dns` | cloudflare zones only |
| "add a CNAME pointing www.myapp.com to ..." | `POST /api/v1/apps/{appId}/domains/{domain}/dns` | cloudflare zones only |
| "change the A record for myapp.com to ..." | `PATCH /api/v1/apps/{appId}/domains/{domain}/dns/{recordId}` | get the recordId from the list call first |
| "delete that record" | `DELETE /api/v1/apps/{appId}/domains/{domain}/dns/{recordId}` | irreversible; warn the user |
| "sync my domains" / "refresh domain status" | `POST /api/v1/apps/{appId}/domains/sync` | refresh all attached cloudflare domains into managed_domains |
| "I added the verification record, check it" | `POST /api/v1/apps/{appId}/domains/verify` | external domains: re-check the TXT challenge |
| "remove this domain from my app" | `DELETE /api/v1/apps/{appId}/domains` | detach only; the cloudflare registration remains until expiry |

## Default flow

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
  // optional override for local dev / staging / preview deploys
  baseUrl: process.env.ELIZA_CLOUD_BASE_URL,
});

// 1. find the domain (and the app it's attached to)
const allDomains = await cloud.routes.getApiV1Domains();
const target = allDomains.domains.find((d) => d.domain === "myapp.com");
if (!target) {
  // tell the user they don't own that domain
  return;
}
const appId = target.appId; // the app the domain is attached to

// 2. read live status for a domain status question
const status = await cloud.routes.postApiV1AppsByIdDomainsStatus({
  pathParams: { id: appId },
  json: { domain: "myapp.com" },
});

// 3. list current dns records (cloudflare-managed zones only)
const records = await cloud.routes.getApiV1AppsByIdDomainsByDomainDns({
  pathParams: { id: appId, domain: "myapp.com" },
});

// 4. add / edit / delete a record
const created = await cloud.routes.postApiV1AppsByIdDomainsByDomainDns({
  pathParams: { id: appId, domain: "myapp.com" },
  json: { type: "A", name: "www", content: "203.0.113.5", ttl: 1, proxied: true },
});

const updated = await cloud.routes.patchApiV1AppsByIdDomainsByDomainDnsByRecordId({
  pathParams: { id: appId, domain: "myapp.com", recordId: created.record.id },
  json: { content: "203.0.113.99" },
});

await cloud.routes.deleteApiV1AppsByIdDomainsByDomainDnsByRecordId({
  pathParams: { id: appId, domain: "myapp.com", recordId: created.record.id },
});
```

## Where the boundaries are

**Cloudflare-registered domains (registrar=cloudflare):** full CRUD on every record type (A, AAAA, CNAME, TXT, MX, SRV, CAA). Cloudflare is the nameserver, so changes propagate within ~minutes.

**External domains (registrar=external):** read-only here. The user must edit those at the DNS provider where they originally bought the domain (Namecheap, Google Domains, etc.). The DNS endpoints return 409 with that explanation.

## Read these references in order

1. `references/api-shape.md` — exact request/response shapes
2. `references/dns-records.md` — when to use which record type, ttl + proxied semantics
3. `references/failure-modes.md` — the failures you'll actually hit

## What this skill is NOT

- **Not for buying a new domain.** Use `eliza-cloud-buy-domain`.
- **Not for transferring a domain into Eliza Cloud.** Out of scope for v1.
- **Not for renewing.** Cloudflare-registered domains auto-renew unless the user turned it off in the dashboard.
- **Not a billing surface.** DNS edits are free; this skill does not debit credits.

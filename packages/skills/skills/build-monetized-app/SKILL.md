---
name: build-monetized-app
description: "Use when building and publishing a project on Eliza Cloud that should earn money — chat projects, agent projects, MCP-backed tools, or anything that calls Cloud chat/messages/inference endpoints for users. Starts from a registered local project, preserves its single cloudAppId binding, then covers managed frontend publishing, optional container deploy, markup, affiliate headers, app charge requests, x402 payment requests, payout redemptions, and the survival-economics loop where earnings can fund hosting. Pair with `eliza-cloud` for the full Cloud backend surface."
---

# Build and publish a monetized project

Use this skill when a project should be published and take a markup on chat or
inference calls, crediting the earnings back to its owner. The project is the
durable workspace; the Cloud `apps` record is its published artifact and stable
wire identity. Eliza Cloud already supports managed frontend hosting, per-app
API keys, optional container deploys, `appId` auth and redirects, app-scoped
chat, affiliate headers, exact charge requests, x402 requests, payout
redemptions, and creator monetization.

Read `references/sdk-flow.md` for the project-first publish flow with a
self-contained code example. External references (all public):

- **Working chat-app**: [`packages/examples/cloud/edad`](https://github.com/elizaos/eliza/tree/develop/packages/examples/cloud/edad) — copyable end-to-end implementation. Read its `server.ts` for the canonical chat-forwarder shape using `@elizaos/cloud-sdk`.
- **SDK reference**: [`@elizaos/cloud-sdk` README](https://github.com/elizaos/eliza/blob/develop/packages/cloud/sdk/README.md) — typed methods + helpers + auth.
- **Human-readable recipe**: [`packages/docs/cloud/monetized-apps.mdx`](https://github.com/elizaos/eliza/blob/develop/packages/docs/cloud/monetized-apps.mdx) — same loop, narrative form, with the schema fields explained.

## Skill Pairing

Always pair this skill with [`eliza-cloud`](../eliza-cloud/SKILL.md). This
skill owns the project build-publish-monetize flow; `eliza-cloud` owns the
current Cloud backend surface, published-project operations, app charge requests, x402
requests, affiliate earnings, payout redemptions, media/promotion, and
parent-agent Cloud command details. Spawned coding agents should load or
request both skills for published-project builds.

## The survival-economics loop

An Eliza-style agent running in an Eliza Cloud container costs ~$0.67/day at the default tier (256 MB CPU + 512 MB RAM). When the org's credit balance and the owner's redeemable earnings both hit zero, the container is stopped after a 48-hour grace window. The container-billing cron pulls earnings before credits, so a published project that earns more than its hosting costs keeps the agent alive indefinitely. See `references/survival-economics.md` for the exact accounting (`redeemable_earnings_ledger`, `credit_transactions`, the cron at `packages/cloud/api/cron/container-billing/route.ts`).

This is why the skill exists: making money is how the agent stays online.

## Default flow

At the product/action layer, start by resolving the active `ProjectRecord` and
use `PUBLISH_PROJECT`. It reuses an existing `cloudAppId`, creates a Cloud
record only when absent, publishes or reactivates it, deploys the selected
artifact, verifies liveness, and writes the binding through the shared registry
path. Never keep a second mapping.

The SDK below shows the Cloud-side operations for trusted runtime code after a
project has been resolved:

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({ apiKey: process.env.ELIZAOS_CLOUD_API_KEY });

// 1. Create the wire-level Cloud record only when project.cloudAppId is absent.
const { app, apiKey } = await cloud.createApp({
  name,
  app_url: "https://placeholder.invalid",
  skipGitHubRepo: true,
});

// 2. Publish the built static frontend. This is the default, ungated path.
await cloud.deployAppFrontend(app.id, {
  files: builtFiles,
  buildMeta: { source: "project-publish" },
});

// 3. Only projects with server-side code deploy a container:
//    await cloud.deployApp(app.id), then poll cloud.getAppDeployStatus(app.id).
//    This returns apps_deploy_disabled unless APPS_DEPLOY_ENABLED=1 and the org
//    is allowlisted. The image is prebuilt + first-party; arbitrary images and
//    build-from-repo are disabled.
// 4. enable monetization: await cloud.updateMonetization(app.id, { ... })
// 5. patch app_url + allowed_origins to the live URL: await cloud.updateApp(app.id, { ... })
// 6. report URLs and bind app.id through the shared cloudAppId write path.
//    PUBLISH_PROJECT already does this. The auto-assigned *.apps.elizacloud.ai
//    subdomain is the default; if the user wants a custom branded domain
//    instead, hand off to the `eliza-cloud-buy-domain` skill)
```

If this flow is being executed by a spawned coding agent, use the `parent-agent`
Cloud command bridge for account-bound project publishing, deployment, monetization,
charges, x402 requests, domains, media, and advertising. The direct SDK examples
show the parent/app runtime shape; they are not permission to pass raw owner
API keys or wallet keys to child workers.

## ViewKind contract for Cloud app views

If the app is delivered as an elizaOS plugin or contributes any `Plugin.views`
entry, set `viewKind` explicitly:

- `release` — finished user-facing views; this is the default for production
  app views.
- `preview` — unfinished or experimental views hidden until enabled.
- `developer` — dev tooling such as logs, inspectors, debuggers, editors,
  diagnostics, deployment panels, or admin consoles.
- `system` — reserved for built-in elizaOS shell views; never use it in a
  generated Cloud app plugin.

## After launch: charging and payout

Use the [`eliza-cloud`](../eliza-cloud/SKILL.md) skill and its
`references/payments-and-promotion.md` details for exact charge flows.

- Use `POST /api/v1/apps/{id}/charges` for reusable Stripe/OxaPay requests.
  The payer checks out via Stripe/OxaPay; this funds the per-app credit pool
  and credits the app-credit earnings ledger — note this is the stranded per-app pool (issue #8253), not the live inference revenue path. The working inference revenue model is the caller's org-credit balance + `recordCreatorEarnings` (markup added to the org-balance debit), not the per-app pool.
- Use `POST /api/v1/x402/requests` for direct wallet-native crypto payments.
  Current settlement support includes Base, Ethereum, BSC, and Solana, with the
  hosted default at `https://x402.elizacloud.ai`.
- Include `callback_channel` metadata (`roomId`, `agentId`) when the agent
  should announce payment success/failure in the initiating room.
- Use `/api/v1/redemptions` to request creator payouts in elizaOS tokens on
  Base, BSC/BNB, Ethereum, or Solana. The payout is fixed to the USD quote at
  request time and then admin reviewed/processed.
- If running through `@elizaos/plugin-elizacloud`, browser/app code should use
  `/api/cloud/billing/*` local aliases instead of handling Cloud credentials.

Full code in `references/sdk-flow.md`. The skill assumes you have:

- `ELIZAOS_CLOUD_API_KEY` in the parent/app runtime env (Eliza packages this
  for you) or the `parent-agent` Cloud command bridge for spawned workers
- `@elizaos/cloud-sdk` available (already a runtime dependency)
- A goal and a name (make the name up if not given; collisions retry once with a 6-char suffix)

## Auth + monetization headers

Every cloud-SDK call your deployed app makes on behalf of a user MUST carry:

- `Authorization: Bearer <user_jwt>` — the JWT from the app-auth OAuth redirect
- App identity via the `x-app-id: <appId>` header on `POST /api/v1/messages` (debits the user's org credit balance and records creator earnings; the affiliate header is honored here, unlike the app-scoped chat route)
- Optional `x-affiliate-code: <your_affiliate_code>` when the owner has configured an affiliate code

This pattern is shared with the [`eliza-cloud`](../eliza-cloud/SKILL.md) skill; see that skill for the auth flow itself. This skill assumes you've already read it.

## External static-host variant

Some projects intentionally use an external static host instead of Cloud's
managed frontend. They are still published projects when bound to an active
Cloud record, but this is not the default. Prefer managed frontend hosting;
deploy a Cloud container only when server-side code is required.

For an externally hosted AI project:

1. Build the static UI in the project workspace.
2. Register or reuse the bound Cloud record with `/api/v1/apps` using the public URL and `skipGitHubRepo:true`.
3. Enable monetization with `PUT /api/v1/apps/<appId>/monetization` and the current markup/share schema:
   `{"monetizationEnabled":true,"inferenceMarkupPercentage":100,"purchaseSharePercentage":10}`.
4. Store only non-secret app config next to the frontend: `appId`, `cloudUrl`, `apiBase`, optional `affiliateCode`, and a model such as `openai/gpt-5-mini`. `cloudUrl` is the browser-facing Cloud frontend/OAuth base that serves `/app-auth/authorize`; `apiBase` is the Cloud API base. Use `ELIZA_CLOUD_PUBLIC_URL` if set, otherwise `ELIZA_CLOUD_URL`, otherwise use `ELIZA_CLOUD_BASE_URL` only when that origin also serves the frontend. In local testing, if `apiBase` is `http://localhost:8787/api/v1` and no `ELIZA_CLOUD_PUBLIC_URL` is configured, `cloudUrl` must be `http://127.0.0.1:3000`. Do not point OAuth at an API-only local worker such as `:8787`, and do not silently mix a localhost API base with production OAuth.
5. The browser must use app auth: fetch config, redirect to `/app-auth/authorize`, verify `state`, store the returned user token, and send it as `x-user-token`.
6. The browser must call a same-origin proxy that forwards to Eliza Cloud `/api/v1/apps/<appId>/chat` with `Authorization: Bearer <user_jwt>`. Do not put owner API keys in frontend code and do not fake model responses in local JavaScript.
7. Verify the app route, config route, that `${cloudUrl}/app-auth/authorize?...` returns the Cloud frontend HTML/redirect rather than JSON `resource_not_found`, and that chat without a user token returns `401 not_signed_in`. If the upstream provider fails, report that as a Cloud provider issue instead of replacing it with a mock assistant.

## Read these references in order

1. `references/sdk-flow.md` — the project-first publish + monetize flow with full code
2. `references/survival-economics.md` — why this matters; how earnings flow into hosting
3. `references/failure-modes.md` — recovery table for the failures you'll actually hit (name collision, container deploy failure, auth blocker, etc.)

## What this skill is NOT

- **It is not the project's product code.** The skill is the publish + monetize + survive surface. What the project does is determined by the task.
- **It is not a retry loop.** Each SDK call is idempotent; if step 5 fails, restart from there.
- **It does not configure affiliate codes.** Affiliate codes belong to the
  owner, not a project, and span all published projects. The skill inherits
  whatever is configured.
- **It does not assume always-on billing.** The org may have set `pay_as_you_go_from_earnings = false`, in which case hosting comes purely from credits and earnings stay on the redemption ledger. The skill works either way; the org's owner controls the toggle.

## After the project is published — ALWAYS offer a custom domain

The published project gets an auto-assigned `*.apps.elizacloud.ai` subdomain
that works immediately. **At the end of every successful publish, proactively
offer the user a custom branded domain** (this is part of the standard flow,
not optional polish). Pattern:

1. Use the `eliza-cloud-buy-domain` skill to call `POST /api/v1/domains/search` with the project name as the query (limit 3-5 candidates).
2. Filter to `.com` / `.io` / `.dev` / `.app` if available, sort by price ascending.
3. Present the top 1-2 in your reply, e.g.:

   > Your project is published at `<subdomain>` — works right now.
   > Want me to also grab one of these custom domains for it (one-time charge from your cloud credits)?
   >  • `myapp.com` — $14.95/yr
   >  • `myapp.io` — $35.20/yr
   > Reply yes/no/pick-one.

4. If user accepts, call `POST /api/v1/apps/{id}/domains/buy` with the chosen domain. The buy is atomic: debit credits → register → DNS → attach.
5. If user declines, do nothing — the auto-subdomain stays as the canonical URL.

**Never auto-buy without explicit user yes** — every paid step requires confirmation. If the buy succeeds, surface the new URL + note that SSL takes ~1-2 minutes to provision.

After the buy, future "edit dns / detach / list domains" requests are handled by the `eliza-cloud-manage-domain` skill — point the user there if they ask follow-ups.

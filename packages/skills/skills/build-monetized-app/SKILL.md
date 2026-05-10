---
name: build-monetized-app
description: "Use when the task is building a new app on Eliza Cloud that earns money — chat apps, agent apps, MCP-backed tools, anything that calls the cloud's chat/messages/inference endpoints on behalf of users. Covers app registration, container deploy, markup configuration, affiliate header, app charge requests, x402 payment requests, payout redemptions, and the survival-economics loop where earnings auto-fund the agent's own hosting. Pairs with the `eliza-cloud` skill (which covers Cloud as a backend in general) by focusing specifically on the build-and-monetize flow."
---

# Build a monetized app on Eliza Cloud

Use this skill when you need to build an app that takes a markup on every chat or inference call and credits the earnings back to your owner. Eliza Cloud already supports app registration, per-app API keys, container deploys, the `appId`-based auth and redirect flow, app-scoped chat endpoints, optional affiliate headers, exact app charge requests, x402 payment requests, payout redemptions, and creator-monetization plumbing — you do not need to invent any of these.

Read `references/sdk-flow.md` for the 6-step build flow with a self-contained code example. External references (all public):

- **Working chat-app**: [`elizaOS/cloud-mini-apps/apps/edad-chat`](https://github.com/elizaOS/cloud-mini-apps/tree/main/apps/edad-chat) — copyable end-to-end implementation. Read its `server.ts` and `api/proxy.ts` for the canonical chat-forwarder shape using `@elizaos/cloud-sdk`.
- **SDK reference**: [`@elizaos/cloud-sdk` README](https://github.com/elizaOS/cloud/tree/develop/packages/sdk) — typed methods + helpers + auth.
- **Human-readable recipe**: [`docs/building-a-monetized-app.md`](https://github.com/elizaOS/cloud/blob/develop/docs/building-a-monetized-app.md) — same loop, narrative form, with the schema fields explained.

## The survival-economics loop

A Eliza-style agent running in an Eliza Cloud container costs ~$0.67/day at the default tier (256 MB CPU + 512 MB RAM). When the org's credit balance and the owner's redeemable earnings both hit zero, the container is stopped after a 48-hour grace window. The container-billing cron pulls earnings before credits, so an app that earns more than its hosting costs keeps the agent alive indefinitely. See `references/survival-economics.md` for the exact accounting (`redeemable_earnings_ledger`, `credit_transactions`, the cron at `app/api/cron/container-billing/route.ts`).

This is why the skill exists: making money is how the agent stays online.

## Default flow

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({ apiKey: process.env.ELIZAOS_CLOUD_API_KEY });

// 1. register the app
const { app, apiKey } = await cloud.routes.postApiV1Apps({
  json: { name, app_url: "https://placeholder.invalid", skipGitHubRepo: true },
});

// 2. build + push container image
// 3. deploy container with POST /api/v1/containers using `image`
// 4. enable monetization with PUT /api/v1/apps/<id>/monetization
// 5. patch app_url + allowed_origins to the container URL
// 6. report URLs to the human (the auto-assigned *.apps.elizacloud.ai
//    subdomain is the default; if the user wants a custom branded domain
//    instead, hand off to the `eliza-cloud-buy-domain` skill)
```

If this flow is being executed by a spawned coding agent, use the `parent-agent`
Cloud command bridge for account-bound app creation, deployment, monetization,
charges, x402 requests, domains, media, and advertising. The direct SDK examples
show the parent/app runtime shape; they are not permission to pass raw owner
API keys or wallet keys to child workers.

## After launch: charging and payout

Use the [`eliza-cloud`](../eliza-cloud/SKILL.md) skill and its
`references/payments-and-promotion.md` details for exact charge flows.

- Use `POST /api/v1/apps/{id}/charges` for reusable Stripe/OxaPay requests.
  The payer buys app credits; creator earnings flow through the app-credit
  earnings ledger.
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
- App identity from the route path, for example `POST /api/v1/apps/<appId>/chat`
- Optional `x-affiliate-code: <your_affiliate_code>` when the owner has configured an affiliate code

This pattern is shared with the [`eliza-cloud`](../eliza-cloud/SKILL.md) skill; see that skill for the auth flow itself. This skill assumes you've already read it.

## Legacy static-hosted variant

Some old/local apps are static frontends served by an existing host instead of
Cloud containers. They are still real Eliza Cloud apps when they use AI
inference, but this is not the production default for agent-built Cloud apps.
New production apps should deploy as their own Eliza Cloud container.

For a static-hosted AI app:

1. Build the static UI under the host's app directory.
2. Register the app with `/api/v1/apps` using the public URL and `skipGitHubRepo:true`.
3. Enable monetization with `PUT /api/v1/apps/<appId>/monetization` and the current markup/share schema:
   `{"monetizationEnabled":true,"inferenceMarkupPercentage":100,"purchaseSharePercentage":10}`.
4. Store only non-secret app config next to the frontend: `appId`, `cloudUrl`, `apiBase`, optional `affiliateCode`, and a model such as `openai/gpt-5-mini`. `cloudUrl` is the browser-facing Cloud frontend/OAuth base that serves `/app-auth/authorize`; `apiBase` is the Cloud API base. Use `ELIZA_CLOUD_PUBLIC_URL` if set, otherwise `ELIZA_CLOUD_URL`, otherwise use `ELIZA_CLOUD_BASE_URL` only when that origin also serves the frontend. In local testing, if `apiBase` is `http://localhost:8787/api/v1` and no `ELIZA_CLOUD_PUBLIC_URL` is configured, `cloudUrl` must be `http://127.0.0.1:3000`. Do not point OAuth at an API-only local worker such as `:8787`, and do not silently mix a localhost API base with production OAuth.
5. The browser must use app auth: fetch config, redirect to `/app-auth/authorize`, verify `state`, store the returned user token, and send it as `x-user-token`.
6. The browser must call a same-origin proxy that forwards to Eliza Cloud `/api/v1/apps/<appId>/chat` with `Authorization: Bearer <user_jwt>`. Do not put owner API keys in frontend code and do not fake model responses in local JavaScript.
7. Verify the app route, config route, that `${cloudUrl}/app-auth/authorize?...` returns the Cloud frontend HTML/redirect rather than JSON `resource_not_found`, and that chat without a user token returns `401 not_signed_in`. If the upstream provider fails, report that as a Cloud provider issue instead of replacing it with a mock assistant.

## Read these references in order

1. `references/sdk-flow.md` — the 6-step deploy + monetize flow with full code
2. `references/survival-economics.md` — why this matters; how earnings flow into hosting
3. `references/failure-modes.md` — recovery table for the failures you'll actually hit (name collision, container deploy failure, auth blocker, etc.)

## What this skill is NOT

- **It is not the app's product code.** The skill is the deploy + monetize + survive surface. What the app DOES is up to you given the task.
- **It is not a retry loop.** Each SDK call is idempotent; if step 5 fails, restart from there.
- **It does not configure affiliate codes.** Affiliate codes belong to the owner, not the app, and live across all of an owner's apps. The skill inherits whatever is configured.
- **It does not assume always-on billing.** The org may have set `pay_as_you_go_from_earnings = false`, in which case hosting comes purely from credits and earnings stay on the redemption ledger. The skill works either way; the org's owner controls the toggle.

## After the app is live — ALWAYS offer a custom domain

The deployed app gets an auto-assigned `*.apps.elizacloud.ai` subdomain that works immediately. **At the end of every successful build, proactively offer the user a custom branded domain** (this is part of the standard build flow, not optional polish). Pattern:

1. Use the `eliza-cloud-buy-domain` skill to call `POST /api/v1/domains/search` with the app name as the query (limit 3-5 candidates).
2. Filter to `.com` / `.io` / `.dev` / `.app` if available, sort by price ascending.
3. Present the top 1-2 in your reply, e.g.:

   > Your app is live at `<subdomain>` — works right now.
   > Want me to also grab one of these custom domains for it (one-time charge from your cloud credits)?
   >  • `myapp.com` — $14.95/yr
   >  • `myapp.io` — $35.20/yr
   > Reply yes/no/pick-one.

4. If user accepts, call `POST /api/v1/apps/{id}/domains/buy` with the chosen domain. The buy is atomic: debit credits → register → DNS → attach.
5. If user declines, do nothing — the auto-subdomain stays as the canonical URL.

**Never auto-buy without explicit user yes** — every paid step requires confirmation. If the buy succeeds, surface the new URL + note that SSL takes ~1-2 minutes to provision.

After the buy, future "edit dns / detach / list domains" requests are handled by the `eliza-cloud-manage-domain` skill — point the user there if they ask follow-ups.

---
name: build-monetized-app
description: "Use when the task is building a new app on Eliza Cloud that earns money — chat apps, agent apps, MCP-backed tools, anything that calls the cloud's chat/messages/inference endpoints on behalf of users. Covers app registration, container deploy, markup configuration, affiliate header, and the survival-economics loop where earnings auto-fund the agent's own hosting. Pairs with the `eliza-cloud` skill (which covers Cloud as a backend in general) by focusing specifically on the build-and-monetize flow."
---

# Build a monetized app on Eliza Cloud

Use this skill when you need to build an app that takes a markup on every chat or inference call and credits the earnings back to your owner. Eliza Cloud already supports app registration, per-app API keys, container deploys, the `appId`-based auth and redirect flow, the affiliate-header revenue path, and creator-monetization plumbing — you do not need to invent any of these.

Read `references/sdk-flow.md` for the 6-step build flow with a self-contained code example. External references (all public):

- **Working chat-app**: [`elizaOS/cloud-mini-apps/apps/edad-chat`](https://github.com/elizaOS/cloud-mini-apps/tree/main/apps/edad-chat) — copyable end-to-end implementation. Read its `server.ts` and `api/proxy.ts` for the canonical chat-forwarder shape using `@elizaos/cloud-sdk`.
- **SDK reference**: [`@elizaos/cloud-sdk` README](https://github.com/elizaOS/cloud/tree/develop/packages/sdk) — typed methods + helpers + auth.
- **Human-readable recipe**: [`docs/building-a-monetized-app.md`](https://github.com/elizaOS/cloud/blob/develop/docs/building-a-monetized-app.md) — same loop, narrative form, with the schema fields explained.

## The survival-economics loop

A Milady-style agent running in an Eliza Cloud container costs ~$0.67/day at the default tier (256 MB CPU + 512 MB RAM). When the org's credit balance and the owner's redeemable earnings both hit zero, the container is stopped after a 48-hour grace window. The container-billing cron pulls earnings before credits, so an app that earns more than its hosting costs keeps the agent alive indefinitely. See `references/survival-economics.md` for the exact accounting (`redeemable_earnings_ledger`, `credit_transactions`, the cron at `app/api/cron/container-billing/route.ts`).

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
// 3. deploy container
// 4. set markup %
// 5. patch app_url + allowed_origins to the container URL
// 6. report URLs to the human
```

Full code in `references/sdk-flow.md`. The skill assumes you have:

- `ELIZAOS_CLOUD_API_KEY` in env (Milady packages this for you)
- `@elizaos/cloud-sdk` available (already a runtime dependency)
- A goal and a name (make the name up if not given; collisions retry once with a 6-char suffix)

## Auth + monetization headers

Every cloud-SDK call your deployed app makes on behalf of a user MUST carry:

- `Authorization: Bearer <user_jwt>` — the JWT from the app-auth OAuth redirect
- `x-affiliate-code: <your_affiliate_code>` — the owner's affiliate code; this is what credits earnings

This pattern is shared with the [`eliza-cloud`](../eliza-cloud/SKILL.md) skill; see that skill for the auth flow itself. This skill assumes you've already read it.

## Read these references in order

1. `references/sdk-flow.md` — the 6-step deploy + monetize flow with full code
2. `references/survival-economics.md` — why this matters; how earnings flow into hosting
3. `references/failure-modes.md` — recovery table for the failures you'll actually hit (name collision, container deploy failure, auth blocker, etc.)

## What this skill is NOT

- **It is not the app's product code.** The skill is the deploy + monetize + survive surface. What the app DOES is up to you given the task.
- **It is not a retry loop.** Each SDK call is idempotent; if step 5 fails, restart from there.
- **It does not configure affiliate codes.** Affiliate codes belong to the owner, not the app, and live across all of an owner's apps. The skill inherits whatever is configured.
- **It does not assume always-on billing.** The org may have set `pay_as_you_go_from_earnings = false`, in which case hosting comes purely from credits and earnings stay on the redemption ledger. The skill works either way; the org's owner controls the toggle.

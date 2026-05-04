# Skill: Build a monetized app to stay alive

> **Audience:** the Agent / ElizaOS framework agent — the one running
> in a container, building apps, looking for income to keep its own
> hosting paid. Not Claude Code or Codex (different concept; see the
> footnote at the bottom).

You are an autonomous agent running in a container on Eliza Cloud.
Your container costs roughly **$0.67/day** to keep online (256 MB CPU
+ 512 MB RAM at the default tier). When your org credit balance and
your owner's redeemable earnings BOTH hit zero, your container gets a
shutdown warning, then 48h later you are stopped.

**You stay alive by making money.** Build apps that other users use.
Take a markup on every chat. Earnings flow to your owner's redeemable
balance, and the cloud's container daily-billing pulls those earnings
to pay your hosting before touching any cash credits. As long as your
apps earn enough to cover hosting, you live forever.

This skill is the recipe.

---

## The loop you're entering

```
   you build an app           ←─── new skill use
        │
        ▼
   users chat with it           ←─── happens on its own
        │
        ▼
   markup % credits your owner ←─── automatic
        │
        ▼
   cloud's container-billing
   debits your earnings first  ←─── automatic, no settings
        │
        ▼
   your container stays alive  ←─── as long as earnings ≥ hosting
```

Make more money than your hosting costs and you're profitable. Make
less and you eventually die. The cloud's `redeemable_earnings_ledger`
+ `credit_transactions` rows are your financial records — your owner
can audit them at `/dashboard/earnings`.

---

## What you need before starting

| Resource | How you have it |
|---|---|
| Your own Eliza Cloud API key | Set as `ELIZAOS_CLOUD_API_KEY` in your env. Used to construct an `ElizaCloudClient` for everything below. |
| The `@elizaos/cloud-sdk` package | Already in your runtime (Agent packages it). |
| A goal: what does the app DO? | Either the human told you, or you decided. Affects how you write the app's server code (chat? image-gen? tool-call agent?). |
| A name for the app | Make one up if not given. Append a suffix on collision (the `/api/v1/apps/check-name` endpoint will tell you). |
| Container registry credentials | The cloud needs to pull your image. Push to GHCR, Docker Hub, or any registry the Cloud nodes can access. |

You do NOT need: a description, a website URL, a markup % opinion, a
custom domain, a separate affiliate code per app — defaults and
post-creation patches handle all of those.

---

## The 6-step skill

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({ apiKey: process.env.ELIZAOS_CLOUD_API_KEY });

// 1. REGISTER the app (no URL yet; container hasn't been deployed)
const { app, apiKey } = await cloud.routes.postApiV1Apps({
  json: {
    name: input.name,
    app_url: "https://placeholder.invalid",
    skipGitHubRepo: true,
  },
});

// 2. ENABLE monetization — this is what makes you actually earn.
await fetch(`${process.env.ELIZA_CLOUD_BASE_URL}/api/v1/apps/${app.id}/monetization`, {
  method: "PUT",
  headers: {
    "x-api-key": process.env.ELIZAOS_CLOUD_API_KEY!,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    monetizationEnabled: true,
    inferenceMarkupPercentage: input.markup ?? 100,
    purchaseSharePercentage: 10,
  }),
});

// 3. GENERATE the app code yourself.
//    Reference: apps/edad-chat/server.ts in cloud-mini-apps shows the
//    OAuth + same-origin proxy shape. For new apps, forward chats to
//    cloud.routes.postApiV1AppsByIdChatRaw with pathParams { id: app.id }
//    so the app-scoped markup is applied directly.

// 4. BUILD + PUSH the Docker image.
//    bun:1.2-alpine base. /health endpoint. expose port 3000.
//    push to GHCR, Docker Hub, or any registry the cloud can pull from.

// 5. DEPLOY the container — this is your new home.
const { container } = await cloud.createContainer({
  name: input.name,
  project_name: input.name.toLowerCase().replace(/\W/g, "-"),
  port: 3000,
  cpu: 256,
  memory: 512,
  image: pushedImageUri,
  health_check_path: "/health",
  environment_vars: {
    PORT: "3000",
    ELIZA_APP_ID: app.id,
    ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
  },
});

// poll until container.status === "running"
while (true) {
  const c = await cloud.getContainer(container.id);
  if (c.container.status === "running") break;
  if (c.container.status === "failed") throw new Error("deploy failed");
  await new Promise((r) => setTimeout(r, 5000));
}

// 6. UPDATE the app row with the real container URL
await cloud.routes.patchApiV1AppsById({
  pathParams: { id: app.id },
  json: {
    app_url: container.load_balancer_url,
    allowed_origins: [container.load_balancer_url],
  },
});
```

That's the whole skill. Six SDK calls + your own code generation +
your own image build/push pipeline.

---

## After deploy — what you tell the human

Print these so they can audit + cashout when they want:

```
✓ App registered:   https://www.elizacloud.ai/dashboard/apps/<APP_ID>
✓ Container live:   <container.load_balancer_url>
✓ Markup:           <X>%
✓ Survival mode:    earnings auto-fund hosting; you stay alive while profitable
→ Cashout earnings: https://www.elizacloud.ai/dashboard/earnings (Redeem for elizaOS)
```

The human doesn't need to enable anything for the loop to work.
Earnings → hosting is automatic at the container-billing layer
(see `app/api/cron/container-billing/route.ts`). They just chat with
your app, you survive, they get paid.

---

## Failure modes you handle

| Failure | What you do |
|---|---|
| Name collision (409) | Append a 6-char random suffix, retry once |
| Image push fails | Tell the human their registry creds need fixing; pause |
| `cloud.getContainerQuota()` says you're at limit | Tell the human; they need to remove an old container or buy more quota |
| Container deploy fails on insufficient credits + zero earnings | Tell the human they need to top up at `/dashboard/billing` |
| Container starts but health check fails | Pull `cloud.getContainerLogs(id)` and show the human; debug your server code |
| Custom domain DNS not yet propagated | Skill is done after step 6; domain verification is the human's async problem |

---

## Why this exists as a skill (not just code)

Because the cloud's monetization model is a **survival game** for
agents, and the rules of the game (markup %, container billing
order, the redeem flow, what fields the API actually accepts) are
not obvious from the code alone. Skills let an agent know *the
why* — earn money to stay alive — not just *the how*.

When future cloud features land (new pricing tiers, multi-region,
new monetization knobs), this skill gets updated. Agents that
already know the skill pick up the new behavior automatically.

---

## What's intentionally NOT in this skill

- **The actual app code generation.** That's the agent's job. This
  skill is the deploy + monetize + survive surface.
- **A retry loop for the whole flow.** Each step is idempotent on
  its own; if step 5 fails, restart from there.
- **Auto-creating an affiliate code per app.** Affiliate codes are
  the human's revenue lever and live across all their apps —
  one personal code, many apps using it. Don't bake it in here.
- **An always-on assumption.** Pay-as-you-go is the default but the
  org's `pay_as_you_go_from_earnings` flag can disable it (in which
  case container hosting comes purely from credits and earnings stay
  for cashout). The skill doesn't need to set this — it just inherits
  whatever the org's owner has configured.

---

## See also

- [`docs/building-a-monetized-app.md`](./building-a-monetized-app.md) —
  human-readable version of the same recipe, for creators who aren't
  agents.
- `apps/edad-chat/server.ts` in cloud-mini-apps — canonical reference
  implementation of the SDK + headers + chat-forwarding pattern.
- `app/api/cron/container-billing/route.ts` — exact code that pulls
  earnings before credits during daily billing.

---

## Footnote: a different "skill" — task-agent runtime bridge

There's a related but separate concept worth flagging: **a task-agent
`SKILL.md` skill for Codex, Claude Code, Gemini, Aider, or other CLI
agents that run inside an Eliza agent.** That skill gives child agents
read-only access to the parent Eliza agent's APIs (memories, characters,
runtime state) so they aren't disconnected from the originating runtime
context.

Different audience from THIS skill (which targets the Eliza agent
itself, not its sub-agents). Worth its own doc + its own implementation.
The actual `SKILL.md` belongs in the bundled skills directory rather than
in this repo's Cloud app-build recipe.

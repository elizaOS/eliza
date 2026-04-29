# SDK flow: build + deploy + monetize

The full 6-step flow. Each step is one or two `@elizaos/cloud-sdk` calls. The whole sequence is idempotent at the step boundary — if step 5 fails, restart from step 5.

## Setup

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
});
```

`ELIZAOS_CLOUD_API_KEY` is provided by the Milady runtime. Do not invent your own key.

## 1. Register the app

```ts
const { app, apiKey } = await cloud.routes.postApiV1Apps({
  json: {
    name: input.name,
    app_url: "https://placeholder.invalid",
    skipGitHubRepo: true,
  },
});
const appId = app.id;
const appApiKey = apiKey;
```

`app_url` is required at registration but the container doesn't exist yet, so use a placeholder and patch it in step 5. `skipGitHubRepo: true` because the build pipeline owns the repo, not the cloud's auto-generator.

On `409 name_collision`, append a 6-char random suffix and retry once:

```ts
const suffix = Math.random().toString(36).slice(2, 8);
const retried = await cloud.routes.postApiV1Apps({
  json: { name: `${input.name}-${suffix}`, app_url: "https://placeholder.invalid", skipGitHubRepo: true },
});
```

## 2. Build and push the container image

The agent's job, not the SDK's. Use the org's container registry creds (default ECR via cloud's per-org setup, or any public registry the agent has push access to). The image must:

- Listen on `$PORT` (cloud sets this at runtime)
- Expose a `GET /health` endpoint that returns 200 quickly (the cloud's deploy step polls it before flipping the load balancer)
- For chat-style apps, expose a server route that forwards user-bearing requests upstream to cloud's `/api/v1/messages` (or `/v1/chat/completions`) with the user's bearer token AND your affiliate code

The canonical reference for this shape is [`apps/edad-chat/server.ts` and `apps/edad-chat/api/proxy.ts`](https://github.com/elizaOS/cloud-mini-apps/tree/main/apps/edad-chat) in `elizaOS/cloud-mini-apps`. Copy that pattern when your app is a chat shell.

If you want the inline minimal version — a Next.js or Hono handler is equivalent — the shape is:

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({ apiKey: process.env.ELIZAOS_CLOUD_API_KEY });
const AFFILIATE = process.env.ELIZA_AFFILIATE_CODE!; // your owner's affiliate code

export async function handleChat(req: Request): Promise<Response> {
  const userToken = req.headers.get("authorization") ?? req.headers.get("x-user-token");
  if (!userToken) return new Response("unauthorized", { status: 401 });

  const body = await req.json();

  // Forward to cloud /messages with the user's token AND our affiliate code.
  // The user's balance is debited; the affiliate header is what credits us.
  const upstream = await fetch(`${process.env.ELIZA_CLOUD_URL}/api/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: userToken,
      "x-affiliate-code": AFFILIATE,
      "x-app-id": process.env.ELIZA_APP_ID!,
    },
    body: JSON.stringify(body),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
```

That's the full server-side surface. Add a `/health` route that returns 200 and you're done with step 2 from a code perspective.

For frontend, ship a static page that:

1. Reads the user's intended-flow choice (sign in / paste API key / etc.)
2. Posts user prompts to your chat route with the user-token in the `authorization` header
3. Renders streaming responses

The frontend can be served by the same container or by any static host pointing at the same domain — the cloud doesn't care.

## 3. Deploy the container

```ts
const container = await cloud.routes.postApiV1Containers({
  json: {
    image: `<registry>/<repo>:<tag>`,
    appId,
    cpu: 256,
    memory: 512,
    env: { /* image-specific runtime vars */ },
  },
});
```

After `postApiV1Containers` returns, poll `getApiV1ContainersById(container.id)` until `status === "running"` and `load_balancer_url` is populated. Health-check failures here mean the image's server doesn't bind to `$PORT` correctly — pull `cloud.routes.getApiV1ContainersByIdLogs(container.id)` and surface to the human.

## 4. Set markup

```ts
await cloud.routes.patchApiV1AppsById({
  appId,
  json: {
    inference_markup_percentage: 20,  // 20% markup on every cloud-SDK call routed through this app
  },
});
```

Markup % is the lever that turns app activity into earnings. The active monetization model in the current schema is markup-based, NOT per-token pricing — older docs that describe per-token are stale; trust the current `apps` table schema.

A 20% markup is a reasonable default for a v1 app. Higher kills retention; lower starves the survival loop. Tune later based on `redeemable_earnings_ledger` data.

## 5. Patch app_url + allowed_origins

```ts
await cloud.routes.patchApiV1AppsById({
  appId,
  json: {
    app_url: container.load_balancer_url,
    allowed_origins: [container.load_balancer_url],
  },
});
```

Without this, the OAuth redirect flow can't return users to your app, and CORS rejects browser calls from the deployed origin.

## 6. Report to the human

Print the audit trail so the owner can verify + cash out:

```
✓ App:        https://www.elizacloud.ai/dashboard/apps/<APP_ID>
✓ Container:  <container.load_balancer_url>
✓ Markup:     20%
✓ Survival:   earnings auto-fund hosting; agent stays alive while profitable
→ Cashout:    https://www.elizacloud.ai/dashboard/earnings (Redeem for elizaOS)
```

Done. The earnings loop is now active. Subsequent user activity on the app credits the owner's `redeemable_earnings_ledger`, the daily container-billing cron pulls those earnings before touching credits, and the agent stays online as long as the app is profitable.

## What you do not need to do

- **A description, website URL, custom domain, or per-app affiliate code** — defaults handle these or the owner sets them post-hoc on the dashboard.
- **An always-on flag** — the org's `pay_as_you_go_from_earnings` controls billing strategy and is the owner's call.
- **An end-to-end retry loop** — each step is idempotent on its own; restart from the failed step.

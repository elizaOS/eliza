# SDK flow: build + deploy + monetize

The full 6-step flow. Each step is one or two `@elizaos/cloud-sdk` calls. The whole sequence is idempotent at the step boundary — if step 5 fails, restart from step 5.

## Setup

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
});
```

`ELIZAOS_CLOUD_API_KEY` is provided by the Eliza runtime. Do not invent your own key.

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

The agent's job, not the SDK's. Push to GHCR, Docker Hub, or any registry the
Cloud container nodes can pull from. The current container API takes a full
image reference in the `image` field; ECR credential vending is retired. The
image must:

- Listen on `$PORT` (cloud sets this at runtime)
- Expose a `GET /health` endpoint that returns 200 quickly (the cloud's deploy step polls it before flipping the load balancer)
- For chat-style apps, expose a server route that forwards user-bearing requests upstream to cloud's `/api/v1/apps/<appId>/chat` with the user's bearer token

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

  // Forward to the app-scoped chat endpoint with the user's token.
  // The user's app balance is debited; the app's configured markup credits us.
  const appId = process.env.ELIZA_APP_ID!;
  const upstream = await cloud.routes.postApiV1AppsByIdChatRaw({
    pathParams: { id: appId },
    headers: {
      authorization: userToken.startsWith("Bearer ") ? userToken : `Bearer ${userToken}`,
      ...(AFFILIATE ? { "x-affiliate-code": AFFILIATE } : {}),
    },
    json: body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
```

That's the full server-side surface. Add a `/health` route that returns 200 and you're done with step 2 from a code perspective.

For frontend, ship a page that:

1. Starts the Eliza Cloud app-auth flow with `/app-auth/authorize`
2. Stores the returned user token after validating `state`
3. Posts user prompts to your same-origin chat route with the user token
4. Renders streaming responses

The frontend can be served by the same container or by any static host pointing at the same domain — the cloud doesn't care.

## 3. Deploy the container

```ts
const created = await cloud.routes.postApiV1Containers({
  json: {
    name: input.name,
    project_name: input.slug,
    image: `<registry>/<repo>:<tag>`,
    port: 3000,
    desired_count: 1,
    cpu: 256,
    memory: 512,
    health_check_path: "/health",
    environment_vars: {
      PORT: "3000",
      ELIZA_APP_ID: appId,
      ELIZA_CLOUD_URL: process.env.ELIZA_CLOUD_PUBLIC_URL ?? "https://www.elizacloud.ai",
      ELIZA_AFFILIATE_CODE: process.env.ELIZA_AFFILIATE_CODE ?? "",
    },
  },
});
const container = created.data;
```

After `postApiV1Containers` returns, poll `getApiV1ContainersById(container.id)`
until the response has a usable `load_balancer_url` / `publicUrl`, then verify
`GET <url>/health`. Health-check failures here mean the image's server doesn't
bind to `$PORT` correctly — pull `cloud.routes.getApiV1ContainersByIdLogs` when
the sidecar is available and surface the logs to the human.

## 4. Set markup

```ts
await cloud.routes.putApiV1AppsByIdMonetization({
  pathParams: { id: appId },
  json: {
    monetizationEnabled: true,
    inferenceMarkupPercentage: 100,
    purchaseSharePercentage: 10,
  },
});
```

Markup % is the lever that turns app activity into earnings. Use the
monetization endpoint above; older docs that patch `inference_markup_percentage`
directly on the app row are stale.

100% markup is the current default for agent-built v1 apps. Tune later from real usage and `redeemable_earnings_ledger` data.

## 5. Patch app_url + allowed_origins

```ts
await cloud.routes.patchApiV1AppsById({
  pathParams: { id: appId },
  json: {
    app_url: container.load_balancer_url ?? container.publicUrl,
    allowed_origins: [container.load_balancer_url ?? container.publicUrl],
  },
});
```

Without this, the OAuth redirect flow can't return users to your app, and CORS rejects browser calls from the deployed origin.

## 6. Report to the human

Print the audit trail so the owner can verify + cash out:

```
✓ App:        https://www.elizacloud.ai/dashboard/apps/<APP_ID>
✓ Container:  <container.load_balancer_url>
✓ Markup:     100%
✓ Survival:   earnings auto-fund hosting; agent stays alive while profitable
→ Cashout:    https://www.elizacloud.ai/dashboard/earnings (Redeem for elizaOS)
```

Done. The earnings loop is now active. Subsequent user activity on the app credits the owner's `redeemable_earnings_ledger`, the daily container-billing cron pulls those earnings before touching credits, and the agent stays online as long as the app is profitable.

## What you do not need to do

- **A description, website URL, custom domain, or per-app affiliate code** — defaults handle these or the owner sets them post-hoc on the dashboard.
- **An always-on flag** — the org's `pay_as_you_go_from_earnings` controls billing strategy and is the owner's call.
- **An end-to-end retry loop** — each step is idempotent on its own; restart from the failed step.

## Worker credential boundary

When this flow runs inside an orchestrated worker, prefer `USE_SKILL parent-agent`
Cloud commands for account-bound operations instead of passing the parent
account's raw Cloud API key into the child. The `ELIZAOS_CLOUD_API_KEY`
examples above are for trusted app-builder/runtime code where Eliza explicitly
injects the key.

# SDK flow: build + deploy + monetize

The full 6-step flow. Each step is one or two `@elizaos/cloud-sdk` calls. The whole sequence is idempotent at the step boundary — if step 5 fails, restart from step 5.

## Setup

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
});
```

`ELIZAOS_CLOUD_API_KEY` is provided by the Eliza parent/app runtime. Do not
invent your own key, and do not pass owner API keys or wallet private keys into
spawned child workers. In orchestrated workers, use `USE_SKILL parent-agent`
Cloud commands for account-bound operations.

## 1. Register the app

```ts
const { app, apiKey } = await cloud.createApp({
  name: input.name,
  app_url: "https://placeholder.invalid",
  skipGitHubRepo: true,
});
const appId = app.id;
const appApiKey = apiKey;
```

`app_url` is required at registration but the deployed URL doesn't exist yet, so use a placeholder and patch it in step 5. `skipGitHubRepo: true` makes this a **template app**: the cloud stamps the first-party template image onto it at create time (`app.metadata.imageTag`), so create → deploy resolves to a prebuilt, allowlisted image with no build step — build-from-repo is disabled.

On `409 name_collision`, append a 6-char random suffix and retry once:

```ts
const suffix = Math.random().toString(36).slice(2, 8);
const retried = await cloud.createApp({
  name: `${input.name}-${suffix}`,
  app_url: "https://placeholder.invalid",
  skipGitHubRepo: true,
});
```

## 2. The app image — PREBUILT and first-party only

You do **not** build and push your own container image. App deploys are gated to
a **prebuilt, allowlisted, first-party image**:

- **Template apps** (`skipGitHubRepo: true`, step 1) get the first-party template
  image stamped onto them automatically at create time
  (`app.metadata.imageTag`). The default is
  `ghcr.io/elizaos/example-edad:showcase` — a working chat-forwarder showcase app
  — overridable via the `APP_DEFAULT_TEMPLATE_IMAGE` env on the deploy backend.
  So a template app needs no image work from you at all: go straight to step 3.
- **The apps-deploy allowlist is `ghcr.io/elizaos/*` ONLY by default**
  (`APPS_DEPLOY_IMAGE_ALLOWLIST`, fail-closed). An image outside the first-party
  namespace — Docker Hub, your own GHCR org, anything you built and pushed — is
  rejected at deploy time. There is no "push to any registry the nodes can pull"
  path here.
- **build-from-repo is disabled** (no `APPS_IMAGE_REGISTRY` wired). A repo-linked
  app whose build-from-repo is off will not silently fall back to a default image
  — it fails closed until an explicit prebuilt `ghcr.io/elizaos/*` image is set.

To ship genuinely custom app code, an operator publishes a first-party
`ghcr.io/elizaos/*` image (the `build-example-app-images` workflow publishes the
`:showcase` tags) and points the app at it via `metadata.imageTag`, or enables
build-from-repo (deferred). Until then, the template image is the deploy artifact.

The first-party image (template or operator-published) listens on `$PORT`,
exposes a `GET /health` that returns 200 quickly, and — for a chat app — forwards
user-bearing requests upstream to the cloud's `/api/v1/messages` with the user's
bearer token and an `x-app-id: <appId>` header (debits the user's org balance and
records creator earnings). The canonical reference for that shape is
[`packages/examples/cloud/edad/server.ts`](https://github.com/elizaos/eliza/blob/develop/packages/examples/cloud/edad/server.ts)
— the same code published as the default template image.

The inline minimal version of that forwarder — a Next.js or Hono handler is
equivalent — is:

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({ apiKey: process.env.ELIZAOS_CLOUD_API_KEY });
const AFFILIATE = process.env.ELIZA_AFFILIATE_CODE!; // your owner's affiliate code

export async function handleChat(req: Request): Promise<Response> {
  const userToken = req.headers.get("authorization") ?? req.headers.get("x-user-token");
  if (!userToken) return new Response("unauthorized", { status: 401 });

  const body = await req.json();

  // Forward to /api/v1/messages with the user's token + x-app-id.
  // The user's ORG credit balance is debited; the app's configured markup
  // credits the creator via recordCreatorEarnings; x-affiliate-code is honored.
  const appId = process.env.ELIZA_APP_ID!;
  const upstream = await cloud.routes.postApiV1MessagesRaw({
    headers: {
      authorization: userToken.startsWith("Bearer ") ? userToken : `Bearer ${userToken}`,
      "x-app-id": appId,
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

That's the full server-side surface the first-party image implements (plus a
`/health` route returning 200). For a template app you write none of this — the
template image already ships it; this is the reference for when an operator
publishes a custom first-party image.

The template image also ships the frontend. For reference, a chat frontend:

1. Starts the Eliza Cloud app-auth flow with `/app-auth/authorize`
2. Stores the returned user token after validating `state`
3. Posts user prompts to your same-origin chat route with the user token
4. Renders streaming responses

The frontend can be served by the same container or by any static host pointing at the same domain — the cloud doesn't care.

## 3. Deploy the app

Deploy is a single typed call on the app — the backend resolves the app's
prebuilt image (`metadata.imageTag`, stamped in step 1) and runs it. You do not
pass an image or container shape; the template/first-party image and the
`ELIZA_APP_ID` attribution env are wired by the deploy backend.

```ts
const deploy = await cloud.deployApp(appId);
// Optional: pass extra non-secret env the image reads.
// const deploy = await cloud.deployApp(appId, { env: { SOME_FLAG: "1" } });

// Poll until the deploy lands.
let status = await cloud.getAppDeployStatus(appId);
while (status.status !== "ready" && status.status !== "error") {
  await new Promise((r) => setTimeout(r, 5_000));
  status = await cloud.getAppDeployStatus(appId);
}
if (status.status === "error") {
  // status.error carries the deploy failure reason — surface it to the human.
  throw new Error(`deploy failed: ${status.error}`);
}
const appUrl = status.vercelUrl; // the deployed URL (else the app's *.apps.elizacloud.ai subdomain)
```

> **The deploy is GATED.** `cloud.deployApp` (`POST /api/v1/apps/:id/deploy`)
> returns `503 { code: "apps_deploy_disabled" }` unless `APPS_DEPLOY_ENABLED=1`
> on the Worker, **and** the org is on the production deploy allowlist (`403`
> otherwise) — see `packages/cloud/api/v1/apps/[id]/deploy/route.ts`. This is the
> intended fail-clean: a deploy that can't run returns an error instead of
> stranding an app with no URL (#8434). If you hit the 503, the apps-deploy
> backend isn't armed for your environment yet — report that to the human rather
> than working around it. There is no per-container logs/health/metrics SDK
> surface; the deploy status (`status` + `error` above) is the signal.

## 4. Set markup

```ts
await cloud.updateMonetization(appId, {
  monetizationEnabled: true,
  inferenceMarkupPercentage: 100,
  purchaseSharePercentage: 10,
});
```

Markup % is the lever that turns app activity into earnings. Use the
monetization endpoint above; older docs that patch `inference_markup_percentage`
directly on the app row are stale.

100% markup is the current default for agent-built v1 apps. Tune later from real usage and `redeemable_earnings_ledger` data.

## 5. Patch app_url + allowed_origins

```ts
await cloud.updateApp(appId, {
  app_url: appUrl,
  allowed_origins: [appUrl],
});
```

`appUrl` is the deployed URL from step 3 (`getAppDeployStatus().vercelUrl`, else
the app's auto-assigned `*.apps.elizacloud.ai` subdomain). Without this, the
OAuth redirect flow can't return users to your app, and CORS rejects browser
calls from the deployed origin.

## 6. Report to the human

Print the audit trail so the owner can verify + cash out:

```
✓ App:        https://www.elizacloud.ai/dashboard/apps/<APP_ID>
✓ Live URL:   <appUrl from getAppDeployStatus().vercelUrl, else *.apps.elizacloud.ai>
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

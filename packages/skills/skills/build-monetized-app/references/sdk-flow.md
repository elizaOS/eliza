# SDK flow: build + deploy + monetize

The full 6-step flow. Each step is one or two `@elizaos/cloud-sdk` calls. The whole sequence is idempotent at the step boundary — if step 5 fails, restart from step 5.

## Setup

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
});

const cloudApiOrigin = (
  process.env.ELIZA_CLOUD_API_ORIGIN ?? "https://api.eliza.app"
).replace(/\/$/, "");
```

`ELIZAOS_CLOUD_API_KEY` is provided by the Eliza parent/app runtime. Do not
invent your own key, and do not pass owner API keys or wallet private keys into
spawned child workers. In orchestrated workers, use `USE_SKILL parent-agent`
Cloud commands for account-bound operations.

## 1. Register the app

```ts
const { app } = await cloud.createApp({
  name: input.name,
  app_url: "https://placeholder.invalid",
  skipGitHubRepo: true,
});
const appId = app.id;
```

`app_url` is required at registration but the deployed URL does not exist yet,
so use a placeholder and patch it later. `skipGitHubRepo: true` avoids creating
an empty repository; it does **not** make the stamped example image the user's
custom product. Keep this single `appId` for the managed frontend, optional
database/backend, review, monetization, analytics, and later edits.

On `409 name_collision`, append a 6-char random suffix and retry once:

```ts
const suffix = Math.random().toString(36).slice(2, 8);
const retried = await cloud.createApp({
  name: `${input.name}-${suffix}`,
  app_url: "https://placeholder.invalid",
  skipGitHubRepo: true,
});
```

## 2. Publish the custom frontend; prepare a backend only when needed

Publish the product's actual static files with `deployAppFrontend`; this gives
the app version history, activation, and rollback without paying for a
container:

```ts
await cloud.deployAppFrontend(appId, {
  files: [{ path: "index.html", content: renderedIndexHtml }],
  entrypoint: "index.html",
  spaFallback: true,
  activate: true,
  buildMeta: { source: "agent", gitCommit },
});
```

For a monetized AI app, the browser needs a same-origin server-side proxy for
OAuth/user-token forwarding. Build that custom backend, publish it as a
prebuilt image, and pass the explicit image to `deployApp`. The default image
namespace is first-party and fail-closed; an operator may grant the owning org
an additional namespace through
`organizations.settings.allowed_image_namespaces`. Prefer a digest-pinned
reference. Missing image publication or namespace approval is a real blocker;
never substitute the example/template image and call it the requested app.

The custom backend image listens on `$PORT`,
exposes a `GET /health` that returns 200 quickly, and — for a chat app — forwards
user-bearing requests upstream to the cloud's `/api/v1/messages` with the user's
bearer token and an `x-app-id: <appId>` header (debits the user's org balance and
records creator earnings). Keep the proxy server-side so owner credentials
never enter the browser bundle.

The inline minimal version of that forwarder — a Next.js or Hono handler is
equivalent — is:

```ts
const AFFILIATE = process.env.ELIZA_AFFILIATE_CODE!; // your owner's affiliate code

export async function handleChat(req: Request): Promise<Response> {
  const userToken = req.headers.get("authorization") ?? req.headers.get("x-user-token");
  if (!userToken) return new Response("unauthorized", { status: 401 });

  const body = await req.json();

  // Forward to /api/v1/messages with the user's token + x-app-id.
  // The user's ORG credit balance is debited; the app's configured markup
  // credits the creator via recordCreatorEarnings; x-affiliate-code is honored.
  const appId = process.env.ELIZA_APP_ID!;
  const upstream = await fetch(`${cloudApiOrigin}/api/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: userToken.startsWith("Bearer ") ? userToken : `Bearer ${userToken}`,
      "x-app-id": appId,
      ...(AFFILIATE ? { "x-affiliate-code": AFFILIATE } : {}),
    },
    body: JSON.stringify(body),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
```

That is the essential server-side surface, plus a `/health` route returning
200. It authenticates with the signed-in user's token; it does not need the
owner's Cloud key at runtime.

The managed frontend or backend-served UI:

1. Starts the Eliza Cloud app-auth flow with `/app-auth/authorize`
2. Stores the returned user token after validating `state`
3. Posts user prompts to your same-origin chat route with the user token
4. Renders streaming responses

The frontend may be served by the backend container itself. A managed static
frontend needs its same-origin `/chat` route wired to that backend before it is
considered complete; do not expose the owner's Cloud key in browser code.

## 3. Deploy the app

Deploy the explicit custom backend image on the same app identity. The app
deploy backend validates the image namespace/digest policy, persists it as the
app's deploy image, creates the app-owned container, and injects the platform
owned `ELIZA_APP_ID` attribution env. If the app database mode is `isolated`, it
also provisions and injects that app's database.

```ts
await cloud.deployApp(appId, {
  image: "ghcr.io/<approved-namespace>/<app>@sha256:<digest>",
});
// Optional: pass extra non-secret env the image reads.
// const deploy = await cloud.deployApp(appId, { env: { SOME_FLAG: "1" } });

// Poll until the deploy lands.
let status = await cloud.getAppDeployStatus(appId);
while (status.status !== "READY" && status.status !== "ERROR") {
  await new Promise((r) => setTimeout(r, 5_000));
  status = await cloud.getAppDeployStatus(appId);
}
if (status.status === "ERROR") {
  // status.error carries the deploy failure reason — surface it to the human.
  throw new Error(`deploy failed: ${status.error}`);
}
if (!status.vercelUrl) throw new Error("deploy became READY without a production URL");
const appUrl = status.vercelUrl;
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

## 4. Patch the verified URL and submit review

```ts
await cloud.updateApp(appId, {
  app_url: appUrl,
  allowed_origins: [new URL(appUrl).origin],
});

const review = await cloud.routes.postApiV1AppsByIdReview({
  pathParams: { id: appId },
});
if (review.review?.review_status !== "approved") {
  throw new Error("app review did not approve monetization");
}
```

`appUrl` is the verified URL from the managed frontend or backend deploy.
Without the correct URL/origin, OAuth cannot safely return users to the app.
A rejected review is a real product blocker; do not bypass it.

## 5. Set markup after approval

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

## 6. Verify billing and report to the human

Print the audit trail so the owner can verify + cash out:

```
✓ App:        https://cloud.eliza.app/cloud/apps/<APP_ID>
✓ Live URL:   <appUrl from getAppDeployStatus().vercelUrl, else *.apps.eliza.app>
✓ Markup:     100%
✓ Survival:   earnings auto-fund hosting; agent stays alive while profitable
→ Cashout:    https://cloud.eliza.app/cloud/monetization (Redeem for elizaOS)
```

Before claiming success, sign in as a real test user, send one message through
the same-origin proxy, and verify both the user's org debit and the creator
markup ledger entry. Then the earnings loop is active: subsequent user activity
credits the owner's `redeemable_earnings_ledger`, and container billing can pull
those earnings before credits when the org setting enables it.

## What you do not need to do

- **A description, website URL, custom domain, or per-app affiliate code** — defaults handle these or the owner sets them post-hoc on the dashboard.
- **An always-on flag** — the org's `pay_as_you_go_from_earnings` controls billing strategy and is the owner's call.
- **An end-to-end retry loop** — each step is idempotent on its own; restart from the failed step.

## Worker credential boundary

When this flow runs inside an orchestrated worker, use `USE_SKILL parent-agent`
Cloud commands for account-bound operations instead of passing the parent
account's raw Cloud API key into the child. The direct SDK credential above is
for the trusted parent builder only. The deployed app authenticates upstream
with each signed-in user's bearer token plus `x-app-id`; it does not receive the
owner key.

# @elizaos/cloud-sdk

TypeScript SDK for Eliza Cloud API access, CLI login, API-key auth, agent management, model APIs, containers, billing credits, and generic endpoint calls.

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
});

const models = await cloud.listModels();
const credits = await cloud.getCreditsBalance();
const agents = await cloud.listAgents();

// Curated public Cloud API routes are also exposed through cloud.routes.
const app = await cloud.routes.getApiV1AppsById({
  pathParams: { id: "app_123" },
});
const stream = await cloud.routes.postApiV1ChatCompletionsRaw({
  json: { model: "gpt-4o-mini", messages: [], stream: true },
});
```

## Sign in with Eliza Cloud (web app) + app-credits

A third-party web app can let users sign in with their Eliza Cloud account — no
API key pasting — and bill inference to a registered app's credits (the app
owner earns the configured markup). The client exposes the whole flow:

```ts
const cloud = new ElizaCloudClient(); // no key needed to start the login

// 1. Start a login session and open the hosted login (a tab works well).
const { sessionId, browserUrl } = await cloud.startCliLogin();
window.open(browserUrl, "_blank");

// 2. Poll until the user authorizes (handles the deadline/interval/terminal
//    states for you; throws on expiry/error/timeout).
const { apiKey, userId } = await cloud.waitForCliLogin(sessionId);
cloud.setApiKey(apiKey!);

// 3. Show/buy app-credits for your registered app.
const balance = await cloud.getAppCreditsBalance("app_123");
const checkout = await cloud.createAppCreditsCheckout({
  app_id: "app_123",
  amount: 5,
  success_url: location.origin,
  cancel_url: location.origin,
});

// 4. Run inference billed to the app's credits via the `appId` option
//    (sends the `X-App-Id` header). Omit `appId` to bill the caller's own credits.
//    Add `affiliateCode` to attribute the call to an affiliate for revenue share
//    (sends `X-Affiliate-Code`; read by the credit-billed inference routes).
const reply = await cloud.createChatCompletion(
  { model: "anthropic/claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
  { appId: "app_123", affiliateCode: "aff_xyz" },
);
```

For a third-party OAuth-style app sign-in, send the user to the canonical
Eliza Cloud app authorization route. Use the SDK helper so your app does not
accidentally link to bare `/authorize`, which is not a Cloud app-auth route:

```ts
import { buildAppAuthorizeUrl } from "@elizaos/cloud-sdk";

const authorizeUrl = buildAppAuthorizeUrl({
  appId: "app_123",
  redirectUri: "https://example.app/auth/eliza/callback",
  state: crypto.randomUUID(),
});

window.location.assign(authorizeUrl);
```

The generated URL is
`https://elizacloud.ai/app-auth/authorize?app_id=...&redirect_uri=...&state=...`.
Use `/app-auth/authorize`; do not use `/authorize`.

`waitForCliLogin(sessionId, { timeoutMs?, intervalMs?, signal? })` and the
`{ appId, affiliateCode }` options on `createChatCompletion` / `createResponse` /
`createEmbeddings` / `generateImage` / `transcribeAudio` exist so browser apps
don't have to hand-roll the polling loop or a raw `fetch` to send `X-App-Id` /
`X-Affiliate-Code`. `appId` bills the app and credits the creator markup;
`affiliateCode` credits the affiliate's revenue share. Both are per-call and
sent only when set.

> Browser note: `startCliLogin` / `pollCliLogin` are CORS-friendly (token auth,
> no cookies). `pairWithToken` is server/agent-only — it sets an `Origin` header
> that browsers forbid `fetch` from overriding.

`cloud.routes` is generated from the public Cloud API route tree under
`apps/api`, including both Next-style exported HTTP handlers and Hono
`app.get` / `app.post` / `app.all` route modules. It intentionally excludes
admin, cron, webhook, internal, dashboard, auth, and MCP transport routes from
the package root SDK surface. The route audit still inventories the full route
tree so stale generated wrappers fail before publish.

JSON endpoints expose a typed method plus a `Raw` variant. Always-stream,
binary, and text routes return `Response` from the primary generated method;
mixed routes such as chat completions keep the JSON method and use `Raw` when
the request asks for streaming.

Refresh and verify route coverage after adding or changing API routes:

```bash
node packages/cloud/sdk/scripts/generate-public-routes.mjs
node packages/cloud/sdk/scripts/audit-api-routes.mjs
```

Run live e2e tests against the real API with:

```bash
ELIZA_CLOUD_SDK_LIVE=1 ELIZAOS_CLOUD_API_KEY=eliza_... bun run test:e2e
```

The live suite is intentionally split by capability:

- `ELIZA_CLOUD_SDK_LIVE=1` runs public real-API checks for CLI login bootstrap and model listing.
- `ELIZAOS_CLOUD_API_KEY` or `ELIZA_CLOUD_API_KEY` enables authenticated read checks.
- `ELIZA_CLOUD_SESSION_TOKEN` enables browser-session-only API key management checks.
- `ELIZA_CLOUD_SDK_LIVE_GENERATION=1` enables paid generation checks.
- `ELIZA_CLOUD_SDK_LIVE_RELAY=1` enables gateway relay lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_DESTRUCTIVE=1` must be combined with the specific resource flag before tests create or mutate resources.
- `ELIZA_CLOUD_SDK_LIVE_CONTAINERS=1` and `ELIZA_CLOUD_SDK_CONTAINER_IMAGE_URI=...` enable container lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_AGENT=1` enables Eliza agent lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_PROFILE_WRITE=1`, `ELIZA_CLOUD_SDK_PROFILE_FIELD=...`, and `ELIZA_CLOUD_SDK_PROFILE_VALUE=...` enable profile write checks.
- `ELIZA_CLOUD_SDK_LIVE_OPENAPI=1` forces the OpenAPI check when testing an environment where `/api/openapi.json` is public. The hosted production endpoint currently requires auth.

Build and publish:

```bash
bun run build
npm publish --access public
```

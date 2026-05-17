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
bun run generate:routes
bun run check:routes
bun run audit:routes
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

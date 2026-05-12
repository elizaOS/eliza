# @elizaos/cloud-routing

Canonical "cloud-default, local-override" routing helper for Eliza Cloud-integrated plugins. Every plugin that can optionally route through Eliza Cloud uses this single function to decide where its API calls go.

## Three branches, no fallback noise

`resolveCloudRoute(runtime, spec)` returns a discriminated union with exactly one of three `source` values:

### 1. `local-key` — user has a local API key

```ts
const route = resolveCloudRoute(runtime, {
  service: "birdeye",
  localKeySetting: "BIRDEYE_API_KEY",
  upstreamBaseUrl: "https://public-api.birdeye.so",
  localKeyAuth: { kind: "header", headerName: "X-API-KEY" },
});

if (route.source === "local-key") {
  // route.baseUrl = "https://public-api.birdeye.so"
  // route.headers = { "X-API-KEY": "<key>" }
}
```

### 2. `cloud-proxy` — no local key, Eliza Cloud connected

```ts
if (route.source === "cloud-proxy") {
  // route.baseUrl = "https://www.elizacloud.ai/api/v1/apis/birdeye"
  // route.headers = { Authorization: "Bearer <cloud-api-key>" }
}
```

### 3. `disabled` — neither available

```ts
if (route.source === "disabled") {
  // route.reason explains why — log it and bail
  return;
}
```

Callers branch on `source` once at plugin init. There are no silent fallbacks — if the service is disabled, the plugin knows immediately and can exit cleanly.

## Cloud connection check

`isCloudConnected(runtime)` returns `true` iff:

- `ELIZAOS_CLOUD_API_KEY` is a non-empty trimmed string
- `ELIZAOS_CLOUD_ENABLED` is `"true"`, `"1"`, or boolean `true`

## Per-feature hybrid routing

Users can pin individual capabilities (LLM, RPC, tool use, embeddings, media, TTS, STT) to `"local"`, `"cloud"`, or `"auto"` independently. The feature registry in `features.ts` is the single source of truth — there is no `if (feature === "llm")` branching anywhere; adding a feature is a one-line append to `FEATURES`.

```ts
import { resolveFeatureCloudRoute } from "@elizaos/cloud-routing";

const route = resolveFeatureCloudRoute(runtime, "llm", {
  service: "openai",
  localKeySetting: "OPENAI_API_KEY",
  upstreamBaseUrl: "https://api.openai.com/v1",
  localKeyAuth: { kind: "bearer" },
});
// route.policy is "local" | "cloud" | "auto"
// route.source is "local-key" | "cloud-proxy" | "disabled"
```

Per-feature settings keys follow `ELIZAOS_CLOUD_ROUTING_<FEATURE_UPPER>` (e.g. `ELIZAOS_CLOUD_ROUTING_LLM`, `ELIZAOS_CLOUD_ROUTING_TOOL_USE`).

Policy semantics:

- `local` — only `local-key` is acceptable. Cloud is **not** consulted even if connected.
- `cloud` — only `cloud-proxy` is acceptable. Local keys are ignored.
- `auto` — defer to the canonical `resolveCloudRoute` precedence (local-key wins, cloud-proxy fills in, disabled otherwise). This is the default.

Use `getFeaturePolicy(runtime, feature)` to read one policy or `getFeaturePolicyMap(runtime)` to read all of them as a typed map.

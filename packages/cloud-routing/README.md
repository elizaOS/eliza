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

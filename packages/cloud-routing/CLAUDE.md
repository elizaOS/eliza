# @elizaos/cloud-routing

Shared routing resolver that decides whether a service call should use a locally configured API key, be proxied through Eliza Cloud, or be disabled.

## Purpose / role

This package is a pure utility library with no runtime dependencies. It provides the routing logic that plugins use to choose between three sources for any external API: a local key set directly in the agent's settings, a cloud proxy (via `ELIZAOS_CLOUD_API_KEY`), or disabled. It also defines and resolves per-feature routing policies (`local` / `cloud` / `auto`).

Consumers: `plugins/plugin-wallet`, `plugins/plugin-streaming`, `plugins/plugin-tailscale`, and `packages/cloud-api` / `packages/cloud-shared` reference it via tsconfig path aliases.

## Layout

```
packages/cloud-routing/
  src/
    index.ts        — re-exports everything; this is the public surface
    features.ts     — FEATURES registry (llm, rpc, tool_use, embeddings, media, tts, stt)
                      and helpers: getFeature, isFeature, isFeaturePolicy
    resolve.ts      — resolveCloudRoute, resolveFeatureCloudRoute,
                      getFeaturePolicy, getFeaturePolicyMap,
                      isCloudConnected, cloudServiceApisBaseUrl,
                      toRuntimeSettings
    types.ts        — CloudRoute, FeatureCloudRoute, RouteSpec, CloudRouteSource
    resolve.test.ts — vitest unit suite (imported via ./resolve.ts direct path)
  dist/             — compiled output (tsc NodeNext)
```

## Key exports / surface

All exports are re-exported from `src/index.ts`:

**Types**
- `CloudRouteSource` — `"local-key" | "cloud-proxy" | "disabled"`
- `CloudRoute` — discriminated union on `source`; routable variants add `baseUrl`, `headers`, `reason`
- `FeatureCloudRoute` — `CloudRoute & { feature: string; policy: FeaturePolicy }`
- `RouteSpec` — caller-provided descriptor: `{ service, localKeySetting, upstreamBaseUrl, localKeyAuth }`
- `RuntimeSettings` — interface with `getSetting(key: string): string | boolean | number | null | undefined`
- `FeaturePolicy` — `"local" | "cloud" | "auto"`
- `FeaturePolicyMap` — `Record<Feature, FeaturePolicy>`
- `Feature` — union of registered feature ids

**Functions**
- `toRuntimeSettings(runtime)` — adapts any object with `getSetting(key): unknown` to `RuntimeSettings`
- `resolveCloudRoute(runtime, spec)` — returns a `CloudRoute`; prefers `local-key` over `cloud-proxy` over `disabled`
- `resolveFeatureCloudRoute(runtime, feature, spec, policyOverride?)` — policy-aware resolver
- `getFeaturePolicy(runtime, feature)` — reads per-feature setting, falls back to `DEFAULT_FEATURE_POLICY` (`"auto"`)
- `getFeaturePolicyMap(runtime)` — returns one entry per feature with defaults applied
- `isCloudConnected(runtime)` — true when `ELIZAOS_CLOUD_API_KEY` is set and `ELIZAOS_CLOUD_ENABLED` is truthy
- `cloudServiceApisBaseUrl(runtime, service)` — returns cloud proxy `{ baseUrl, headers }` or null

**Constants**
- `FEATURES` — readonly tuple of feature definitions (id, settingKey, description)
- `FEATURE_IDS` — array of feature id strings
- `FEATURE_POLICIES` — `["local", "cloud", "auto"]`
- `DEFAULT_FEATURE_POLICY` — `"auto"`

## Commands

```bash
bun run --cwd packages/cloud-routing build       # tsc --noCheck + prepare-package-dist
bun run --cwd packages/cloud-routing typecheck   # tsgo --noEmit
bun run --cwd packages/cloud-routing lint        # biome check src
```

There is no `test` script in this package. Tests in `src/resolve.test.ts` are consumed by the monorepo root test runner (vitest).

## Config / env vars

Read by the resolve functions at call time via `runtime.getSetting()`:

| Env var | Purpose |
|---|---|
| `ELIZAOS_CLOUD_API_KEY` | Cloud API key; required for cloud-proxy source |
| `ELIZAOS_CLOUD_ENABLED` | Must be `"true"`, `"1"`, or boolean `true` to enable cloud routing |
| `ELIZAOS_CLOUD_BASE_URL` | Override cloud base URL; defaults to `https://www.elizacloud.ai/api/v1` |
| `ELIZAOS_CLOUD_ROUTING_LLM` | Per-feature policy for LLM calls |
| `ELIZAOS_CLOUD_ROUTING_RPC` | Per-feature policy for blockchain RPC |
| `ELIZAOS_CLOUD_ROUTING_TOOL_USE` | Per-feature policy for tool/function execution |
| `ELIZAOS_CLOUD_ROUTING_EMBEDDINGS` | Per-feature policy for embeddings |
| `ELIZAOS_CLOUD_ROUTING_MEDIA` | Per-feature policy for image/audio/video |
| `ELIZAOS_CLOUD_ROUTING_TTS` | Per-feature policy for text-to-speech |
| `ELIZAOS_CLOUD_ROUTING_STT` | Per-feature policy for speech-to-text |

Each per-feature var accepts `"local"`, `"cloud"`, or `"auto"` (case-insensitive, whitespace-tolerant).

## How to extend

**Add a new routable feature:**
1. Add an entry to the `FEATURES` array in `src/features.ts` with a unique `id` and `settingKey`.
2. The `Feature` type, `FEATURE_IDS`, `getFeature`, `isFeature`, and `getFeaturePolicyMap` all derive from the array — no further changes needed.
3. Add a test fixture in `src/resolve.test.ts` covering the new feature id.

**Use in a plugin:**
```ts
import {
  resolveCloudRoute,
  toRuntimeSettings,
  type RouteSpec,
} from "@elizaos/cloud-routing";

const SPEC: RouteSpec = {
  service: "my-service",
  localKeySetting: "MY_SERVICE_API_KEY",
  upstreamBaseUrl: "https://api.my-service.com/v1",
  localKeyAuth: { kind: "bearer" },
};

const route = resolveCloudRoute(toRuntimeSettings(runtime), SPEC);
if (route.source === "disabled") throw new Error(route.reason);

const response = await fetch(`${route.baseUrl}/endpoint`, {
  headers: route.headers,
});
```

Use `resolveFeatureCloudRoute` instead of `resolveCloudRoute` when the caller wants to respect the user's per-feature policy setting (the `ELIZAOS_CLOUD_ROUTING_*` env vars).

## Conventions / gotchas

- **No runtime dependencies.** This package has only devDependencies. Keep it that way.
- **`toRuntimeSettings` is required.** The elizaOS `AgentRuntime.getSetting()` returns `unknown`; wrap it before passing to any resolve function.
- **Local key wins in `auto` mode.** `resolveCloudRoute` checks the local key first; cloud proxy is the fallback.
- **`cloud-proxy` source requires both `ELIZAOS_CLOUD_API_KEY` and `ELIZAOS_CLOUD_ENABLED`.** Setting the key alone is not enough.
- **Trailing slashes are stripped** from all base URLs before concatenating paths.
- **`eliza-source` export condition** (`src/index.ts` direct) is used in tsconfig path alias mode for packages that live in the same monorepo checkout.

# @elizaos/plugin-tailscale

Tailscale tunnel backend plugin for elizaOS — exposes a local agent port through either the locally-installed `tailscale` CLI or an Eliza Cloud auth-key-minting path.

## Purpose / role

This plugin adds a Tailscale-backed `serviceType="tunnel"` implementation to an Eliza agent. It registers no actions of its own; user-facing tunnel operations go through the canonical `TUNNEL` action from `@elizaos/plugin-tunnel`. Backend selection (local CLI vs. cloud) happens at `init()` time via `selectTunnelBackend`. The plugin is opt-in — add `@elizaos/plugin-tailscale` to the agent's plugin list to enable it. If another plugin has already claimed the `"tunnel"` slot (`tunnelSlotIsFree` returns false), this plugin logs a warning and leaves the existing tunnel service in place.

## Plugin surface

**Providers**
- `tailscaleStatus` — injects current tunnel state (active, url, port, uptime, provider) as compact JSON into the LLM context on every turn. Dynamic, cache-scope `turn`, context-gated to `settings`/`connectors`.

**Services** (registered dynamically in `init`, not declared statically)
- `LocalTailscaleService` — wraps the local `tailscale` CLI (`tailscale serve` / `tailscale funnel`). Requires `tailscale` to be installed and the user already authenticated to a tailnet.
- `CloudTailscaleService` — calls `POST /v1/apis/tunnels/tailscale/auth-key` on Eliza Cloud to mint a scoped ephemeral auth key, then runs `tailscale up` + `tailscale serve/funnel` locally. Requires `ELIZAOS_CLOUD_API_KEY`.

Both services implement `ITunnelService` from `@elizaos/plugin-tunnel` and register under `serviceType="tunnel"`. Consumers call `getTunnelService(runtime)` and stay backend-agnostic.

**ConnectorAccountProvider** — registered into `ConnectorAccountManager` at `init()`; surfaces multi-account Tailscale config through the standard connector account CRUD surface. Provider id: `"tailscale"`.

## Layout

```
src/
  index.ts                          Plugin definition, init(), all public re-exports
  types.ts                          Re-exports ITunnelService, TunnelStatus, TunnelProvider from @elizaos/plugin-tunnel; adds TailscaleBackendMode
  environment.ts                    validateTailscaleConfig() — reads + validates all env vars via zod
  accounts.ts                       Multi-account config: readTailscaleAccounts(), resolveTailscaleAccount(), TailscaleAccountConfig
  accounts.test.ts
  connector-account-provider.ts     createTailscaleConnectorAccountProvider() — adapts accounts.ts to ConnectorAccountManager
  connector-account-provider.test.ts
  providers/
    tailscale-status.ts             tailscaleStatusProvider — injects tunnel status into LLM context
  services/
    TunnelBackendSelector.ts        readBackendMode(), selectTunnelBackend() — chooses LocalTailscaleService or CloudTailscaleService
    LocalTailscaleService.ts        Drives local `tailscale` CLI; requires tailscale installed + authed
    CloudTailscaleService.ts        Mints cloud auth key, joins tailnet, runs serve/funnel
    CloudTailscaleService.test.ts
  __tests__/
    TailscaleTestSuite.ts           elizaOS test suite class (used in plugin.tests)
```

## Commands

All scripts defined in `package.json`:

```bash
bun run --cwd plugins/plugin-tailscale build           # tsup ESM build + .d.ts
bun run --cwd plugins/plugin-tailscale typecheck       # tsgo --noEmit
bun run --cwd plugins/plugin-tailscale test            # vitest run
bun run --cwd plugins/plugin-tailscale test:watch      # vitest watch
bun run --cwd plugins/plugin-tailscale test:coverage   # vitest --coverage
bun run --cwd plugins/plugin-tailscale lint            # biome check --write --unsafe
bun run --cwd plugins/plugin-tailscale lint:check      # biome check (no write)
bun run --cwd plugins/plugin-tailscale format          # biome format --write
bun run --cwd plugins/plugin-tailscale format:check    # biome format (no write)
bun run --cwd plugins/plugin-tailscale clean           # rm -rf dist coverage
```

## Config / env vars

Config resolution order for each key: account record in `character.settings.tailscale.accounts` → `TAILSCALE_ACCOUNTS` JSON setting → flat runtime setting → `process.env`.

| Var | Default | Notes |
|-----|---------|-------|
| `TAILSCALE_BACKEND` | `auto` | `local` / `cloud` / `auto`. In `auto`, picks cloud if `isCloudConnected(runtime)` returns true. |
| `TAILSCALE_AUTH_KEY` | — | Optional pre-minted auth key (local backend). |
| `TAILSCALE_TAGS` | `tag:eliza-tunnel` | Comma-separated ACL tags for cloud-minted keys. |
| `TAILSCALE_FUNNEL` | `false` | Truthy: use `tailscale funnel` (public Internet). Falsy: use `tailscale serve` (tailnet-only HTTPS). |
| `TAILSCALE_DEFAULT_PORT` | `3000` | Fallback port when none is specified. |
| `TAILSCALE_AUTH_KEY_EXPIRY_SECONDS` | `3600` | Expiry hint for cloud auth-key minter. |
| `TAILSCALE_ACCOUNTS` | — | JSON array or object of `TailscaleAccountConfig` records for multi-account setups. |
| `TAILSCALE_DEFAULT_ACCOUNT_ID` | `default` | Which account entry to use when multiple are configured. |
| `ELIZAOS_CLOUD_API_KEY` | — | **Required** for cloud backend. |
| `ELIZAOS_CLOUD_BASE_URL` | `https://api.elizacloud.ai/api/v1` | Override cloud base URL. |

## How to extend

**Add a new provider:**
1. Create `src/providers/<name>.ts` exporting a `Provider` object.
2. Import and add it to the `providers` array in `src/index.ts`.

**Add an action:**
1. Create `src/actions/<name>.ts` exporting an `Action` object.
2. Import and add it to the `actions` array in `src/index.ts`.

**Add a new tunnel backend service:**
1. Implement `ITunnelService` (from `../types`) and extend `Service` from `@elizaos/core`. Set `static serviceType = "tunnel"`.
2. Add the new class as an option in `src/services/TunnelBackendSelector.ts`.
3. Export the class from `src/index.ts`.

## Conventions / gotchas

- **First-active-wins tunnel slot.** Only one service can hold `serviceType="tunnel"`. If another plugin (e.g. `@elizaos/plugin-ngrok`) registers first, this plugin's `init()` logs the conflict and leaves the existing tunnel service in place. Enable only one tunnel plugin at a time.
- **`tailscale` binary required at runtime.** `LocalTailscaleService.start()` throws if `which tailscale` fails. The cloud backend also requires the local CLI for `tailscale up`/`serve`/`funnel`/`logout`.
- **No actions registered here.** All start/stop/status user interactions go through `@elizaos/plugin-tunnel`'s canonical `TUNNEL` action.
- **Cloud backend billing.** Each `startTunnel()` call on `CloudTailscaleService` makes a POST to Eliza Cloud that debits org credits. `getLastProvisioningBilling()` returns the billing payload from the last provision.
- **Multi-account config.** `TailscaleAccountConfig` can be declared in `character.settings.tailscale.accounts` (array or keyed object) or via `TAILSCALE_ACCOUNTS` JSON. Per-account fields mirror the flat env vars — see `src/accounts.ts` for field aliases.
- **Peer dep on `@elizaos/plugin-tunnel`.** `getTunnelService`, `ITunnelService`, `TunnelStatus`, and `tunnelSlotIsFree` all come from there — do not duplicate them here.

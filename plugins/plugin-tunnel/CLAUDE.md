# @elizaos/plugin-tunnel

Local Tailscale-CLI tunnel backend for elizaOS agents.

## Purpose / role

Adds tunnel management (start/stop/status) to an Eliza agent using the locally-installed `tailscale` CLI (`tailscale serve` / `tailscale funnel`). The plugin registers under `serviceType="tunnel"` — a shared slot that coexists with `@elizaos/plugin-elizacloud` (hosted headscale) and `@elizaos/plugin-ngrok` via a first-active-wins convention: `init` only registers `LocalTunnelService` when no other tunnel service has already claimed the slot AND the `tailscale` binary is on PATH.

Add it to a character's `plugins` array — it has no hard dependencies beyond the local `tailscale` binary.

## Plugin surface

| Kind | Name | Description |
|---|---|---|
| Action | `TUNNEL` | Single dispatcher. Similes: `OPEN_TUNNEL`, `CREATE_TUNNEL`, `CLOSE_TUNNEL`, `CHECK_TUNNEL`, `TUNNEL_INFO`. Accepts sub-op `action=start|stop|status` plus optional `port` for `start`. |
| Provider | `TUNNEL_STATE` | Reads `getStatus()` from whichever tunnel service won the slot; exposes text summary + raw status `data`. Contexts: `devtools`, `system`. |
| Service | `LocalTunnelService` | Wraps `tailscale serve --bg --https=443` / `tailscale funnel`. Reads DNS name via `tailscale status --json`. |

No evaluators, routes, or events.

## Layout

```
src/
  index.ts                  Plugin object + re-exports. Registration guard lives here.
  types.ts                  ITunnelService, TunnelStatus, TunnelProvider, getTunnelService(),
                            tunnelSlotIsFree() — shared contract for all tunnel plugins.
  environment.ts            tunnelEnvSchema (zod), validateTunnelConfig(). Reads TUNNEL_* with
                            legacy TAILSCALE_* fallback.
  actions/
    tunnel.ts               TUNNEL dispatcher action (exported as tunnelAction).
    start-tunnel.ts         handleStartTunnel — extracts port from options or via LLM, calls startTunnel().
    stop-tunnel.ts          handleStopTunnel.
    get-tunnel-status.ts    handleGetTunnelStatus — formats uptime.
  providers/
    tunnel-state.ts         TUNNEL_STATE provider.
  services/
    LocalTunnelService.ts   Concrete service; checkTailscaleInstalled() also exported from here.
  __tests__/
    TunnelTestSuite.ts      Plugin test suite registered in the Plugin object.
    unit/                   Unit tests.
```

## Commands

All scripts are defined in `package.json`. Run from repo root or with `--cwd`:

```bash
bun run --cwd plugins/plugin-tunnel build        # tsc compile → dist/
bun run --cwd plugins/plugin-tunnel dev          # tsc --watch
bun run --cwd plugins/plugin-tunnel typecheck    # tsgo --noEmit (no emit, type-check only)
bun run --cwd plugins/plugin-tunnel test         # bun test (all tests)
bun run --cwd plugins/plugin-tunnel test:unit    # bun test src/__tests__/ (unit only)
bun run --cwd plugins/plugin-tunnel lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-tunnel lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-tunnel format       # biome format --write
bun run --cwd plugins/plugin-tunnel format:check # biome format (read-only)
```

## Config / env vars

Read via `validateTunnelConfig(runtime)` in `src/environment.ts`. `TUNNEL_*` are canonical; `TAILSCALE_*` are accepted as aliases for one release window.

| Env var | Default | Notes |
|---|---|---|
| `TUNNEL_TAGS` | `tag:eliza-tunnel` | Comma-separated ACL tags — informational only; user authenticates separately |
| `TUNNEL_FUNNEL` | `false` | `true`/`1` → use `tailscale funnel` (public internet); `false` → `tailscale serve` (tailnet only) |
| `TUNNEL_DEFAULT_PORT` | `3000` | Fallback port when none is extracted from the user's message |

None are required; all have defaults. The device must already be authenticated (`tailscale up`) — this plugin does not run `tailscale up`.

## How to extend

**Add a new TUNNEL sub-op** (e.g. `restart`):
1. Create `src/actions/restart-tunnel.ts` — export `handleRestartTunnel(runtime, message, state, options, callback): Promise<ActionResult>`.
2. In `src/actions/tunnel.ts`, import it, add `'restart'` to `SUPPORTED_OPS`, and add a `case 'restart':` in the switch.

**Add a new provider**:
1. Create `src/providers/<name>.ts` — export a `Provider` object.
2. Add it to the `providers` array in `src/index.ts`.

**Add a new service method** to `ITunnelService` (e.g. for a new tunnel backend):
1. Add the method signature to `ITunnelService` in `src/types.ts`.
2. Implement it in `LocalTunnelService` in `src/services/LocalTunnelService.ts`.
3. Other tunnel plugins (`plugin-elizacloud`, `plugin-ngrok`) must implement the new method too before consuming it.

## Conventions / gotchas

- **First-active-wins slot**: `runtime.getService('tunnel')` returns the first registered service. Plugin order in `character.plugins` determines priority. `tunnelSlotIsFree()` is the guard — always call it in `init` before registering.
- **No auto-start**: the service registers on plugin init, but `startTunnel(port)` is only called when the agent receives a `TUNNEL` action with `action=start`. The device must already be authenticated with `tailscale up`.
- **Port extraction**: if no `port` is passed via action options, `handleStartTunnel` calls `ModelType.TEXT_SMALL` to extract a port from the user's message text. The default is `3000`.
- **DNS name resolution**: after `tailscale serve/funnel`, the service calls `tailscale status --json` and parses `Self.DNSName` (trailing dot stripped). If that fails, `startTunnel` throws — the tunnel command ran but the URL is unknown.
- **Funnel vs. serve**: `TUNNEL_FUNNEL=true` switches from `tailscale serve --bg --https=443 localhost:<port>` (tailnet-only HTTPS) to `tailscale funnel <port>` (public internet). Reset commands differ accordingly (`tailscale funnel reset` vs `tailscale serve reset`).
- **`promoteSubactionsToActions`**: `index.ts` spreads `promoteSubactionsToActions(tunnelAction)` into the `actions` array. This `@elizaos/core` helper reads the `action` parameter enum (`start|stop|status`) and registers virtual top-level actions (`TUNNEL_START`, `TUNNEL_STOP`, `TUNNEL_STATUS`) that delegate to the parent's handler, while keeping the `TUNNEL` umbrella registered too.
- **`serviceType` declaration**: `src/types.ts` extends `@elizaos/core`'s `ServiceTypeRegistry` with `TUNNEL: 'tunnel'` via module augmentation — do not declare it elsewhere.

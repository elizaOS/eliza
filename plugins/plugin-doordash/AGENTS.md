# @elizaos/plugin-doordash

First-party agent facade for DoorDash consumer ordering. It requires
`@elizaos/plugin-mcp` and normalizes the managed Cloud service or a connected
self-hosted MCP adapter into the stable `DOORDASH` action.

For app-originated turns, prefer `@elizaos/plugin-browser`'s `workspace` target
and leave `DOORDASH` unavailable so the planner selects `BROWSER`. Connector
turns such as iMessage use the Cloudflare Browser Run-backed MCP adapter. An app
turn may fall back to Cloudflare only when no workspace target is available.

## Boundaries

- The plugin never stores DoorDash credentials, passwords, browser profiles, or
  cookies. Cloud authentication stays in a user-bound Cloudflare Browser Run
  session and uses Live View for human login.
- The plugin supports the tool dialects exposed by
  `markswendsen-code/mcp-doordash` and `SpunkySarb/doordash-mcp`; do not import or
  copy their browser automation into this package.
- Cart mutations are reversible. `place_order` is a financial side effect and
  must always use core's user-message confirmation gate.
- Clearing the adapter session also requires the user-message confirmation gate.
- Confirmation is bound to a fresh cart plus checkout preview digest. A changed
  cart or total starts a new confirmation instead of consuming the old one.
- Never accept an LLM-supplied `confirm` boolean as authorization.
- A successful order result requires a provider-derived order ID. Synthetic or
  missing IDs are an unverified failure, never success.
- DoorDash does not provide a generally available consumer ordering API. Keep
  the adapter boundary explicit and document that browser/internal-API adapters
  may break or violate DoorDash terms.

## Layout

```text
src/action.ts       DOORDASH action and checkout confirmation
src/adapter.ts      MCP server/tool discovery and dialect normalization
src/types.ts        stable operations and structural MCP types
auto-enable.ts      explicit feature or MCP URL gate
```

## Configuration

Enable `features.doordash`, add `@elizaos/plugin-doordash`, and configure a
plugin-mcp server named `doordash`. An HTTPS endpoint can instead be declared
with `MCP_SERVER_DOORDASH_URL`; local stdio adapters belong in character MCP
settings.

## Verification

```bash
bun run --cwd plugins/plugin-doordash test
bun run --cwd plugins/plugin-doordash typecheck
bun run --cwd plugins/plugin-doordash lint:check
bun run --cwd plugins/plugin-doordash build
```

Live acceptance additionally requires a real user-owned DoorDash session. Test
search, menu, cart, preview, explicit confirmation, an authoritative order ID,
and tracking against the exact revision. Do not place a paid order without the
operator's explicit authorization.

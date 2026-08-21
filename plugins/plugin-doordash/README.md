# @elizaos/plugin-doordash

DoorDash consumer-ordering capabilities for Eliza agents through a configured
MCP adapter. The agent gets one stable `DOORDASH` action even when the backing
server uses a different tool vocabulary.

## Capabilities

- Check authentication status
- Set a delivery address or clear the adapter session when supported
- Search restaurants and cuisines
- Browse menus
- Add or remove cart items
- Inspect active carts and order history
- Preview checkout
- Place an explicitly confirmed order
- Track an order

The plugin recognizes both reviewed community adapters:

- [`markswendsen-code/mcp-doordash`](https://github.com/markswendsen-code/mcp-doordash)
- [`SpunkySarb/doordash-mcp`](https://github.com/SpunkySarb/doordash-mcp)

See [ADAPTER_REVIEW.md](./ADAPTER_REVIEW.md) for the pinned-source comparison,
security findings, integration decision, and Cloud acceptance checklist.

It does not embed either community adapter. Eliza Cloud uses its existing
Firecrawl hosted-browser boundary; self-hosted agents can configure either
reviewed adapter. All browser-based consumer automation can break when
DoorDash changes and may be incompatible with DoorDash's terms.

## Configure a local adapter

Install `@elizaos/plugin-mcp` and this plugin, then add a server named
`doordash` to character settings. For example, after installing the packaged
Strider adapter:

```json
{
  "plugins": ["@elizaos/plugin-mcp", "@elizaos/plugin-doordash"],
  "settings": {
    "mcp": {
      "servers": {
        "doordash": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@striderlabs/mcp-doordash"],
          "timeoutInMillis": 120000
        }
      }
    }
  },
  "features": {
    "doordash": true
  }
}
```

For a remote adapter, keep its URL out of character data:

```bash
MCP_SERVER_DOORDASH_URL=https://adapter.example.com/mcp
MCP_SERVER_DOORDASH_TYPE=streamable-http
```

Eliza Cloud exposes the same authenticated transport at
`/api/mcps/doordash/streamable-http`. When `FIRECRAWL_API_KEY` is configured,
the route creates a short-lived browser session bound to the exact Cloud user
and returns an interactive login view through `status`. DoorDash credentials
and cookies remain inside that provider session. An operator can instead set
`MCP_DOORDASH_STREAMABLE_HTTP_URL` to use a reviewed external implementation.

## Checkout safety

`place_order` does not trust a model-generated boolean. It reads the current
cart and a fresh checkout preview, computes a SHA-256 digest over both, and asks
the user to confirm that exact state. If the cart or total changes, the digest
changes and a new confirmation is required. The adapter must return a real
DoorDash order ID; missing and timestamp-generated fallback IDs are rejected as
unverified.

Community adapters may not meet this contract. Search, menus, carts, and history
can still work while checkout fails closed.

## Cloud managed adapter

The first-party Cloud path:

- authenticates every MCP request and isolates hosted sessions per Eliza user;
- returns an interactive provider login view without accepting credentials;
- never returns or persists browser cookies through MCP;
- makes `confirm=false` non-purchasing and guards a confirmed checkout state
  against duplicate submission;
- rejects a missing or ambiguous provider order ID;
- supports confirmed session revocation through `clear_session`.

Neither reviewed community repository currently satisfies this multi-user
Cloud contract by itself.

## Development

```bash
bun run --cwd plugins/plugin-doordash test
bun run --cwd plugins/plugin-doordash typecheck
bun run --cwd plugins/plugin-doordash lint:check
bun run --cwd plugins/plugin-doordash build
```

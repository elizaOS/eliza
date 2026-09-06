# MCP transport ownership

Production MCP routes use Hono JSON-RPC handlers in [mcp/route.ts](mcp/route.ts)
and the [transport gateway](src/lib/mcp/mcps-transport-gateway.ts). The gateway
serves built-in tools locally and forwards vendor transports to upstream MCP
servers. These paths do not import `mcp-handler`.

The temporary `cloud-mcp-smoke` workspace tested a different transport stack
and had no production consumers. It is removed because that dependency is
not part of the chosen implementation. Its removal makes no claim that
`mcp-handler` was verified compatible or incompatible with workerd.

Runtime compatibility must be validated against the production routes and
their deployment configuration, rather than the discontinued harness.

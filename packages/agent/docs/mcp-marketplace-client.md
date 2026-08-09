# MCP marketplace client

`@elizaos/agent/services/mcp-marketplace` is the typed client for reading the
official MCP Registry. Existing calls remain valid:

```ts
const { results } = await searchMcpMarketplace("filesystem", 10);
const server = await getMcpServerDetails("io.github.example/filesystem");
```

Both functions also accept request controls. The search function takes them as
its third argument; the details function takes them as its second argument:

```ts
const controller = new AbortController();

await searchMcpMarketplace("filesystem", 10, {
  signal: controller.signal,
  timeoutMs: 5_000,
  maxResponseBytes: 512 * 1024,
});
```

Defaults are a 10-second deadline and a 2 MiB response limit. Responses are
read incrementally and validated before marketplace types are returned. To
keep the boundary finite, overrides are capped at a two-minute deadline and an
8 MiB response.

Failures throw `McpMarketplaceError`. Callers can branch on its stable `code`:

- `aborted`
- `timeout`
- `network_error`
- `http_error` (with `status` when available)
- `response_too_large`
- `invalid_response`
- `invalid_options`

`getMcpServerDetails()` preserves the existing `null` result for HTTP 404.

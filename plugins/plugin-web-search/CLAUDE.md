# @elizaos/plugin-web-search

Provides the credential-free `WEB_SEARCH` action through Parallel MCP. The default
and `./edge` exports share the same public-read action. Hosts and coding tools use
`./keyless-web-search` for the shared transport. No API key is required.

Keep fixed provider URLs, redirect rejection, response size rejection, and complete
accepted results. Failed or empty searches return an explicit unavailable result.
The former service-based search category and provider-specific options are removed.

Run from the repository root:

```bash
bun run --cwd plugins/plugin-web-search test
bun run --cwd plugins/plugin-web-search typecheck
bun run --cwd plugins/plugin-web-search lint:check
bun run --cwd plugins/plugin-web-search build
```

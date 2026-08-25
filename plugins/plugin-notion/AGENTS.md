# @elizaos/plugin-notion

Native Notion provider adapter. Projects a connected Notion workspace into the
notes/documents capabilities: workspace search, page reads (flattened block
plain text with citation deep links), page creation, and paragraph appends.
Registers `NotionService` (`runtime.getService("notion")`) and a
ConnectorAccountManager provider for the workspace-bound OAuth flow. No MCP
runtime is involved; this plugin speaks the Notion REST API (2022-06-28)
directly over fetch.

## Architecture

- `src/client.ts` — fetch-based REST client. All upstream failures become
  typed `ElizaError`s (`NOTION_AUTH_EXPIRED`, `NOTION_RATE_LIMITED`,
  `NOTION_NOT_FOUND`, `NOTION_MALFORMED_RESPONSE`, `NOTION_UPSTREAM_FAILURE`,
  `NOTION_INVALID_REQUEST`); callers branch on `code`, never on HTTP details.
  `ELIZA_MOCK_NOTION_BASE` overrides the base URL for protocol-faithful mock
  servers.
- `src/credential-resolver.ts` — account → bearer token. Order: BYO
  `NOTION_TOKEN` setting (local mode, account id `default`/`local`), then
  metadata credential refs, then connector-account storage records, then vault
  refs. Notion tokens do not expire; revocation surfaces as
  `NOTION_AUTH_EXPIRED` and requires reconnecting.
- `src/connector-account-provider.ts` — OAuth start/complete. Notion has no
  PKCE, no refresh tokens, and no incremental scopes; access is scoped by what
  the user shares with the connection in Notion's consent UI. Tokens are
  persisted as durable credential refs via the shared
  `persistConnectorCredentialRefs` helper
  (`@elizaos/plugin-google-workspace/connector-credential-refs`) — never in
  account metadata.
- `src/service.ts` / `src/index.ts` — `NotionService` and the plugin entry.

## Invariants

- Every read result carries the canonical `notion.so` URL for citations.
- Search/read is the default posture; `createPage`/`appendToPage` are the
  explicit write surface.
- Tokens never appear in account metadata, logs, or error contexts.

## Validation

```bash
bun run --cwd plugins/plugin-notion test
bun run --cwd plugins/plugin-notion typecheck
bun run --cwd plugins/plugin-notion lint:check
```

Tests use deterministic protocol-faithful fakes (request handlers serving real
wire shapes), not mocks of the client under test.

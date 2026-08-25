# @elizaos/plugin-dropbox

Native Dropbox provider adapter. Projects a connected Dropbox account into the
files/documents capabilities: folder listing, search, text-file reads, uploads,
and deep links. Registers `DropboxService` (`runtime.getService("dropbox")`)
and a ConnectorAccountManager provider for the PKCE offline OAuth flow. No MCP
runtime is involved; this plugin speaks the Dropbox API v2 directly over fetch.

## Architecture

- `src/client.ts` — fetch-based API v2 client. RPC endpoints go to the api
  host; `download`/`upload` go to the content host with `Dropbox-API-Arg`
  headers (non-ASCII escaped). All upstream failures become typed
  `ElizaError`s (`DROPBOX_AUTH_EXPIRED`, `DROPBOX_RATE_LIMITED`,
  `DROPBOX_NOT_FOUND`, `DROPBOX_MALFORMED_RESPONSE`,
  `DROPBOX_UPSTREAM_FAILURE`, `DROPBOX_INVALID_REQUEST`). File limitation UX:
  `downloadText` refuses binary (`DROPBOX_FILE_NOT_TEXT`) and oversized
  (`DROPBOX_FILE_TOO_LARGE`) files instead of returning garbage — callers
  offer `getTemporaryLink` instead. `ELIZA_MOCK_DROPBOX_BASE` /
  `ELIZA_MOCK_DROPBOX_CONTENT_BASE` override base URLs for protocol-faithful
  mock servers.
- `src/credential-resolver.ts` — account → live bearer token. Order: BYO
  `DROPBOX_ACCESS_TOKEN` setting (local mode, account id `default`/`local`),
  then metadata credential refs, storage records, vault refs. Dropbox access
  tokens are short-lived: the resolver runs the OAuth refresh grant when the
  stored expiry is within the skew window and caches the refreshed token in
  memory. A rejected refresh surfaces as `DROPBOX_AUTH_EXPIRED`.
- `src/connector-account-provider.ts` — PKCE `token_access_type=offline`
  OAuth. Default scopes are the read set (`account_info.read`,
  `files.metadata.read`, `files.content.read`) plus the explicit write
  escalation pair (`files.metadata.write`, `files.content.write`); callers may
  narrow via `scopes`, and unrecognized or empty selections fail closed.
  Token sets are persisted as durable credential refs via the shared
  `persistConnectorCredentialRefs` helper
  (`@elizaos/plugin-google-workspace/connector-credential-refs`) — never in
  account metadata.
- `src/service.ts` / `src/index.ts` — `DropboxService` and the plugin entry.

## Invariants

- Every entry carries a deterministic `dropbox.com` deep link (folder browse
  or file preview) for citations.
- List/search/read is the default posture; `upload` is the explicit write
  surface, `mode: "add"` by default so accidental overwrites fail.
- Tokens never appear in account metadata, logs, or error contexts.

## Validation

```bash
bun run --cwd plugins/plugin-dropbox test
bun run --cwd plugins/plugin-dropbox typecheck
bun run --cwd plugins/plugin-dropbox lint:check
```

Tests use deterministic protocol-faithful fakes (request handlers serving real
wire shapes), not mocks of the client under test.

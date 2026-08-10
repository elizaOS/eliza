# @elizaos/plugin-google-workspace

Personal Google Workspace connector backed only by Google's official MCP resources, plus a separate service-account Google Chat messaging connector.

## Responsibility

`GoogleWorkspaceService` is the typed personal-Google facade used by assistant, calendar, inbox, and finance domains. Personal execution goes through one direct OAuth 2.0 grant and the official product-specific Streamable HTTP MCP resources:

| Product | Resource |
| --- | --- |
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` |
| Calendar | `https://calendarmcp.googleapis.com/mcp/v1` |
| Drive | `https://drivemcp.googleapis.com/mcp/v1` |
| Docs | `https://docsmcp.googleapis.com/mcp/v1` |
| Sheets | `https://sheetsmcp.googleapis.com/mcp/v1` |
| Slides | `https://slidesmcp.googleapis.com/mcp/v1` |
| Chat | `https://chatmcp.googleapis.com/mcp/v1` |
| People | `https://people.googleapis.com/mcp/v1` |
| Workspace search | `https://workspacemcp.googleapis.com/mcp/v1` |

There is no personal-Google REST fallback, OAuth Mode A/B, broker execution mode, Gmail delivery connector, or Meet API client. The connector owns OAuth, vault references, account policy, capability curation, exact tool calls, and stable DTO normalization. `@elizaos/plugin-mcp/resource-engine` owns guarded stateless MCP transport.

Google Chat bot messaging under `src/chat/` is deliberately separate. It uses service-account credentials, webhooks, and a `MessageConnector`; it is not the personal Chat MCP resource and must not share personal OAuth tokens.

## Supported behavior

- Gmail: search/read, labels/state, and draft creation. Gmail MCP has no send tool, so every outbound email outcome is explicitly a draft.
- Calendar: read/list/search only. The official MCP event schema has no atomic provider version, so create/update/delete/respond fail closed; consumers poll bounded time windows instead of using push channels or sync tokens.
- Drive, Docs, Sheets, Slides: reviewed MCP read/write tools.
- Personal Chat: reviewed MCP list/search/send tools.
- People and universal Workspace search: reviewed read tools.
- There is no Meet link, space, conference-record, transcript, recording, or report API here.

Runtime discovery is authoritative because the Google resources are Developer Preview. A capability is usable only when all of these agree:

1. The OAuth token has a reviewed scope.
2. The account or agent binding allows the product and stable capability.
3. `tools/list` exposes the reviewed tool name and schema.
4. The binding is still active immediately before the call.

Read tools and Gmail draft creation may materialize as namespaced dynamic actions. Other writes remain behind typed policy-owning consumers. Never auto-promote an entire vendor tool list.

## Layout

```text
src/
  index.ts                         plugin entry and separate Chat services
  service.ts                       MCP-only personal Google typed facade
  types.ts                         stable connector DTOs and service interfaces
  scopes.ts                        stable capabilities and least-privilege OAuth scopes
  auth.ts                          fixed Google OAuth provider metadata
  connector-account-provider.ts   direct OAuth flow and MCP account lifecycle
  connector-credential-refs.ts    vault-ref persistence helpers
  credential-resolver.ts           vault-backed token resolution and refresh client
  mcp/
    capability-host.ts             per-account product attachment and dynamic actions
    access-token-provider.ts       short-lived bearer projection
    calendar-read-adapter.ts       MCP Calendar DTO normalization
  chat/                            separate service-account Google Chat connector
```

The canonical endpoint/tool/scope manifest lives in `packages/shared/src/contracts/google-workspace-mcp.ts` so local and Cloud hosts cannot drift.

## Security invariants

- Refresh tokens and OAuth client secrets are durable vault/secret-manager values. Database rows and public DTOs contain opaque refs and non-secret metadata only.
- The MCP engine receives only a short-lived access token from a runtime callback. Never serialize raw authorization headers into character or MCP settings.
- Every call rechecks the live account or binding; disconnect/revoke must remove actions and deny planned calls.
- Remote resources pass core MCP config validation and the SSRF-guarded fetch path. Do not add arbitrary remote endpoints or bypass redirect credential stripping.
- Dynamic actions are owned by object identity. A collision must never unregister another plugin's action.
- Official tool names are reviewed contracts. Additions require live `tools/list` inspection, scope verification from protected-resource metadata, tests, and manifest updates.
- Never label a Gmail draft as sent or delivered.
- Never restore Calendar watch/sync, Gmail filters, raw subscription headers, or Meet operations through direct REST.

## Configuration

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are resolved from the runtime secrets service. The callback URI is derived by the control-plane OAuth start route and preserved on the flow; it is never an environment prerequisite. Any environment value is compatibility input that must be explicitly migrated into the vault rather than copied into account metadata.
Set `GOOGLE_OAUTH_VAULT_MIGRATE_FROM_ENV=1` only for that one-time compatibility migration; normal operation fails closed when the vault entry is absent.

The separate Chat connector resolves `GOOGLE_CHAT_SERVICE_ACCOUNT`, `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`, or `GOOGLE_APPLICATION_CREDENTIALS`, plus its webhook audience and space settings. Keep that path isolated from personal OAuth.

## Commands

```bash
bun run --cwd plugins/plugin-google-workspace build
bun run --cwd plugins/plugin-google-workspace typecheck
bun run --cwd plugins/plugin-google-workspace test
bun run --cwd plugins/plugin-google-workspace lint:check
bun run --cwd plugins/plugin-google-workspace format:check
```

## Change checklist

When adding a personal Google capability:

1. Verify the official resource, `tools/list` name, input/output schemas, annotations, and protected-resource scopes live.
2. Update the shared manifest and its contract test.
3. Update `scopes.ts`, typed service DTOs, and exact adapter mapping.
4. Decide explicitly whether the tool is safe for dynamic action promotion.
5. Cover disconnect, revoked binding, partial product failure, schema drift, and exact arguments.
6. Exercise the real Google Developer Preview resource before claiming support.

Read the root `AGENTS.md`, this package README, and the nearest consumer guide before changing public service contracts.

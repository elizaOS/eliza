# @elizaos/plugin-google-workspace

Personal Google Workspace for elizaOS through Google's official MCP servers.

The plugin keeps the elizaOS product seam—OAuth, vault-backed credentials, agent/account policy, approvals, audit-friendly typed methods, and dynamic actions—but it no longer owns personal Google REST clients. Each selected product attaches its official Google MCP resource directly with a short-lived OAuth bearer.

## What is supported

| Product | Behavior |
| --- | --- |
| Gmail | Search/read, labels, trash/spam, and create drafts |
| Calendar | Read/list/search only; polling replaces watches |
| Drive | Search/read metadata/content and create/copy files |
| Docs | Read and update documents |
| Sheets | Read and update spreadsheet data |
| Slides | Read and update presentations |
| Personal Chat | Search/list/send through the user-scoped Chat MCP resource |
| People | Search contacts/directory and read the user profile |
| Workspace search | Read-only cross-product search |

Important limitations:

- Gmail MCP does not send mail. Email workflows create a draft and return a draft receipt.
- Google provides no Meet MCP server. Meet links, artifacts, conference APIs, transcripts, recordings, and reports are not part of this connector.
- Calendar MCP has no push watch, sync-token, idempotency, or atomic provider-version API. Calendar consumers poll bounded windows and reconcile locally; mutations fail closed.
- Gmail filters and raw subscription-header extraction are not available.
- Google Workspace MCP is Developer Preview, so the runtime exposes only reviewed tools that are present in live discovery.

The service-account Google Chat bot connector remains in `src/chat/` as a separate messaging surface. It does not share personal OAuth credentials.

## Architecture

```text
Connect Google
  -> direct OAuth authorization-code + PKCE
  -> refresh token and client secret in vault/secret manager
  -> account bound to selected agent/products
  -> one attachment per official Google MCP product resource
  -> tools/list checked against the reviewed manifest
  -> curated namespaced actions appear
  -> exact tool calls recheck the live binding and use a short-lived bearer
```

There is one OAuth model. There is no Mode A/Mode B or cloud-broker/agent-host execution mode.

The official endpoint and capability manifest is shared with Cloud in `packages/shared/src/contracts/google-workspace-mcp.ts`. The low-level guarded transport lives in `@elizaos/plugin-mcp/resource-engine`.

## Configuration

A Google Cloud OAuth client and redirect URI are required. The client secret must be stored in the runtime secrets service; connector accounts store only secret references.

```text
GOOGLE_CLIENT_ID
GOOGLE_REDIRECT_URI
GOOGLE_CLIENT_SECRET   # vault/secret-manager value
```

For a one-time migration from an existing environment value, set
`GOOGLE_OAUTH_VAULT_MIGRATE_FROM_ENV=1`. Without that explicit flag, a missing
vault entry fails closed.

Enable the Workspace APIs and MCP service APIs for the products you expose, configure the OAuth consent screen, and register the redirect URI.

## Usage

```ts
import { googlePlugin } from "@elizaos/plugin-google-workspace";

const character = {
  plugins: [googlePlugin],
};
```

Every typed method is account-scoped:

```ts
const google = runtime.getService("google");

const events = await google.listEvents({
  accountId: "google-account-id",
  timeMin: new Date().toISOString(),
  limit: 10,
});

const draft = await google.createGmailDraft({
  accountId: "google-account-id",
  to: [{ email: "recipient@example.com" }],
  subject: "Hello",
  text: "Review this draft before sending.",
});
```

The second call creates a Gmail draft; it does not send an email.

## Development

```bash
bun run --cwd plugins/plugin-google-workspace build
bun run --cwd plugins/plugin-google-workspace typecheck
bun run --cwd plugins/plugin-google-workspace test
bun run --cwd plugins/plugin-google-workspace lint:check
```

See [CLAUDE.md](./CLAUDE.md) for package invariants and the root [AGENTS.md](../../AGENTS.md) for repository verification requirements.

# @elizaos/plugin-dropbox

Native Dropbox adapter for elizaOS agents: folder listing, search, text reads,
uploads, temporary links, and citation deep links — no MCP runtime required.

## Usage

```ts
import { dropboxPlugin, DropboxService } from "@elizaos/plugin-dropbox";

const dropbox = runtime.getService<DropboxService>("dropbox");
const page = await dropbox.search({ accountId: "default", query: "invoice" });
```

## Configuration

Managed mode (Cloud OAuth or self-hosted app):

- `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET`, `DROPBOX_REDIRECT_URI` — the
  app registered at https://www.dropbox.com/developers/apps with scoped access
  (`account_info.read`, `files.metadata.read/write`,
  `files.content.read/write`) and the redirect URI registered.

Local/self-hosted BYO mode:

- `DROPBOX_ACCESS_TOKEN` — a generated access token; used for account id
  `default`. Short-lived tokens without a refresh token stop working when they
  expire.

See `CLAUDE.md` for architecture, error codes, and validation commands.

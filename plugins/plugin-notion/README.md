# @elizaos/plugin-notion

Native Notion adapter for elizaOS agents: workspace search, page reads with
citation deep links, page creation, and appends — no MCP runtime required.

## Usage

```ts
import { notionPlugin, NotionService } from "@elizaos/plugin-notion";

const notion = runtime.getService<NotionService>("notion");
const page = await notion.search({ accountId: "default", query: "roadmap" });
```

## Configuration

Managed mode (Cloud OAuth or self-hosted public integration):

- `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_REDIRECT_URI` — the
  public integration registered at https://www.notion.so/my-integrations with
  the redirect URI added under OAuth settings.

Local/self-hosted BYO mode:

- `NOTION_TOKEN` — an internal integration token; used for account id
  `default`. The integration only sees pages explicitly shared with it.

See `CLAUDE.md` for architecture, error codes, and validation commands.

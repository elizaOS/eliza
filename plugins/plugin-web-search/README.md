# @elizaos/plugin-web-search

Adds live web search to an Eliza agent via the [Tavily](https://tavily.com/) API.

## What it does

Installing this plugin registers a `WebSearchService` (`ServiceType.WEB_SEARCH`) that any other plugin or action can call to search the web. It also registers the `"web"` search category so the elizaOS core search-dispatch layer routes web queries to this service automatically.

Capabilities exposed through the service:

- **General web search** — ranked results with optional AI-generated answer.
- **News search** — topic-filtered results with freshness control (day / week / month).
- **Image search** — includes image URLs in results.
- **Video search** — delegates to general search (Tavily has no separate video endpoint).
- **Page info** — fetches a URL and extracts title, description, and raw HTML content.

No actions are registered by the plugin itself. Other plugins that rely on web search call `runtime.getService(ServiceType.WEB_SEARCH)` and invoke the service directly.

## Installation

Add the package to your agent:

```bash
bun add @elizaos/plugin-web-search
```

Then include it in your character config:

```typescript
import { webSearchPlugin } from "@elizaos/plugin-web-search";

export default {
    plugins: [webSearchPlugin],
    // ...
};
```

## Configuration

| Environment variable | Required | Description |
|---------------------|----------|-------------|
| `TAVILY_API_KEY` | Yes | API key from [app.tavily.com](https://app.tavily.com). Without it the service starts in a degraded (inert) state and throws a descriptive error on first use. |

Set the key in your environment or agent settings:

```env
TAVILY_API_KEY=tvly-...
```

## Calling the service from another plugin

```typescript
import { ServiceType } from "@elizaos/core";
import type { IWebSearchService } from "@elizaos/core";

const svc = runtime.getService<IWebSearchService>(ServiceType.WEB_SEARCH);

// General search
const result = await svc.search("latest developments in open-source LLMs", {
    limit: 5,
    searchDepth: "advanced",
    includeAnswer: true,
});

// News search
const news = await svc.searchNews("AI regulation", { freshness: "week" });

// Image search (always returns image results; no flag needed)
const images = await svc.searchImages("northern lights", { limit: 10 });
```

`SearchResponse` shape:

```typescript
{
    query: string;
    answer?: string;         // AI-generated summary (when includeAnswer is true)
    responseTime?: number;
    results: Array<{
        title: string;
        url: string;
        description: string;
        content: string;
        rawContent?: string;
        score: number;
        publishedDate?: Date;
    }>;
    images: Array<{ url: string; description?: string }>;
}
```

## Search options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | number | 3 | Maximum number of results |
| `topic` / `type` | `"general"` \| `"news"` | `"general"` | Tavily topic filter |
| `searchDepth` | `"basic"` \| `"advanced"` | `"basic"` | Tavily crawl depth |
| `includeAnswer` | boolean | true | Request an AI-generated answer |
| `includeImages` | boolean | false | Include image results |
| `days` | number | 3 | Freshness window in days (news searches) |

## Development

```bash
bun run --cwd plugins/plugin-web-search build      # compile
bun run --cwd plugins/plugin-web-search dev        # watch mode
bun run --cwd plugins/plugin-web-search lint       # biome check
bun run --cwd plugins/plugin-web-search typecheck  # type-check only
```

## Dependencies

- [`@elizaos/core`](https://github.com/elizaOS/eliza) — elizaOS runtime interfaces
- [`@tavily/core`](https://www.npmjs.com/package/@tavily/core) — Tavily search client


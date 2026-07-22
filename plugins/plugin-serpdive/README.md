# @elizaos/plugin-serpdive

Adds live web search to an Eliza agent via the [SERPdive](https://serpdive.com) API.

SERPdive returns extracted, answer-ready page content instead of links: each
result carries the actual text of the page (url, title, date, content),
already extracted and cleaned for LLM consumption, so agents quote and cite
straight from the tool output. On a
[public, replayable 1,000-question benchmark](https://github.com/edendalexis/serpdive-benchmark),
SERPdive runs at the same speed as Tavily, feeds the LLM 20.2% fewer tokens,
and wins 60.7% of decided quality duels against Tavily's default search.

## What it does

Installing this plugin registers a `SerpdiveSearchService`
(`ServiceType.WEB_SEARCH`) that any other plugin or action can call to search
the web. It also registers the `"web"` search category so the elizaOS core
search-dispatch layer routes web queries to this service automatically.

Capabilities exposed through the service:

- **General web search** — extracted page content with optional synthesized answer.
- **News search** — delegates to general search; SERPdive infers freshness and
  locale from the query itself (no separate news endpoint).
- **Image / video search** — delegate to general search; `images` stays empty
  rather than fabricating entries (SERPdive has no media endpoints).
- **Suggestions / trending** — derived from unique result titles.
- **Page info** — fetches a URL and extracts title, description, and raw HTML
  content (plain fetch, not SERPdive-backed).

No actions are registered by the plugin itself. Other plugins that rely on web
search call `runtime.getService(ServiceType.WEB_SEARCH)` and invoke the
service directly.

This plugin is a drop-in alternative to `@elizaos/plugin-web-search`: the
option shapes match, `searchDepth: "basic" | "advanced"` maps to SERPdive's
`mako` (fast, key sentences) and `moby` (full page text) models, and a native
`model` option is available as an escape hatch. Use one web-search provider
per agent: both register `ServiceType.WEB_SEARCH`.

## Installation

Add the package to your agent:

```bash
bun add @elizaos/plugin-serpdive
```

Then include it in your character config:

```typescript
import { serpdivePlugin } from "@elizaos/plugin-serpdive";

export default {
    plugins: [serpdivePlugin],
    // ...
};
```

## Configuration

| Environment variable | Required | Description |
| --- | --- | --- |
| `SERPDIVE_API_KEY` | Yes (service is inert without it) | SERPdive API key. Free at [serpdive.com/dashboard/keys](https://serpdive.com/dashboard/keys) — 1,000 credits per month, no card required. |

Without a key the plugin boots inert instead of crashing the agent: `search()`
throws a descriptive, recoverable error until a key is provided.

## Usage

```typescript
import { ServiceType } from "@elizaos/core";

const search = runtime.getService(ServiceType.WEB_SEARCH);

const response = await search.search("what changed in the EU AI Act this month", {
    limit: 5,               // hard cap on delivered results (1-10)
    includeAnswer: true,    // also synthesize a direct answer from the sources
    searchDepth: "basic",  // "basic" → mako (fast), "advanced" → moby (full pages)
});

for (const result of response.results) {
    // result.content is the extracted text of the page, not a snippet
    console.log(result.title, result.url, result.publishedDate);
}
```

Localization is automatic: the language of the query picks where the search
runs. There is no country or locale parameter.

## Costs

One `mako` search costs 1 credit, one `moby` search 1.5. The synthesized
answer is included in the price. Failed searches are never billed. Full
pricing: [serpdive.com](https://serpdive.com/#pricing).

## Links

- [API reference](https://serpdive.com/docs)
- [Public benchmark](https://github.com/edendalexis/serpdive-benchmark) — replayable end to end
- [SDK](https://www.npmjs.com/package/serpdive) (zero runtime dependencies)

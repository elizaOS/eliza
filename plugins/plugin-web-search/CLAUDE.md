# @elizaos/plugin-web-search

Adds live web search to an Eliza agent via the Tavily API.

## Purpose / role

Registers a `WebSearchService` (implementing `IWebSearchService`) that lets any part of the elizaOS runtime call `runtime.getService(ServiceType.WEB_SEARCH)` to execute web and news queries against Tavily. The plugin also registers the `"web"` search category so the core search-dispatch layer knows how to route web searches to this service. It is opt-in: add it to the `plugins` array of your agent character config to enable it. If `TAVILY_API_KEY` is absent at boot the service starts in a degraded (inert) state and throws a descriptive error on first use rather than crashing agent initialisation.

## Plugin surface

| Kind | Name | What it does |
|------|------|-------------|
| Service | `WebSearchService` (`ServiceType.WEB_SEARCH`) | Tavily-backed implementation of `IWebSearchService`; fulfils `search`, `searchNews`, `searchImages`, `searchVideos`, `getSuggestions`, `getTrendingSearches`, `getPageInfo`. |
| Search category | `"web"` (`WEB_SEARCH_CATEGORY`) | Registered with `runtime.registerSearchCategory` so core search dispatch can route to this service. Filters: `topic` (general/news), `searchDepth` (basic/advanced), `includeImages`. |

No actions, providers, evaluators, or routes are registered.

## Layout

```
src/
  index.ts                     Plugin object (webSearchPlugin), WEB_SEARCH_CATEGORY definition,
                               registerWebSearchCategory helper. Entry point.
  types.ts                     SearchResult, SearchImage, SearchResponse, SearchOptions
                               (extends @elizaos/core types). Also re-exports
                               ImageSearchOptions, NewsSearchOptions, VideoSearchOptions.
  services/
    webSearchService.ts        WebSearchService class. Wraps @tavily/core. Contains
                               normalizeResponse(), freshnessToDays(), parsePublishedDate()
                               helpers and getPageInfo() (raw fetch + regex scrape).
```

## Commands

All scripts run from the plugin root:

```bash
bun run --cwd plugins/plugin-web-search build       # tsup ESM + .d.ts
bun run --cwd plugins/plugin-web-search dev         # tsup watch
bun run --cwd plugins/plugin-web-search lint        # biome check src/
bun run --cwd plugins/plugin-web-search lint:fix    # biome check --write src/
bun run --cwd plugins/plugin-web-search format      # biome format src/
bun run --cwd plugins/plugin-web-search format:fix  # biome format --write src/
bun run --cwd plugins/plugin-web-search typecheck   # tsgo --noEmit
```

No `test` script exists in this package; tests live upstream in the agent package.

## Config / env vars

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TAVILY_API_KEY` | Yes (to be functional) | — | Tavily API key. Without it the service boots inert and throws on first `search()` call. |

Read via `runtime.getSetting("TAVILY_API_KEY")` inside `WebSearchService.initialize()`.

The `agentConfig.pluginParameters` in `package.json` declares this key so elizaOS character config editors can surface it in the UI.

## How to extend

**Add a new search method on the service:**
1. Add the method signature to `IWebSearchService` in `@elizaos/core` (or add it locally on `WebSearchService` if it is plugin-specific).
2. Implement it in `src/services/webSearchService.ts`. Reuse `normalizeResponse()` to keep the return shape consistent.
3. Export any new types from `src/types.ts`.

**Add a new search category filter:**
Edit `WEB_SEARCH_CATEGORY.filters` in `src/index.ts`. Filter names must match keys the consumer passes to `WebSearchService.search()` via `SearchOptions`.

**Add an action:**
1. Create `src/actions/<name>.ts` that exports an `Action` object.
2. Import and push it into `webSearchPlugin.actions` in `src/index.ts`.

## Conventions / gotchas

- **Graceful degradation.** The service does not throw during `init`; it sets `this.configured = false` and logs a warning. Callers that invoke `search()` without a key get an `Error` with a clear message.
- **Tavily client is stateless.** `stop()` is a no-op — there is nothing to tear down.
- **`searchVideos` and `getSuggestions`/`getTrendingSearches` are stubs.** `searchVideos` delegates to plain `search()` (Tavily has no dedicated video endpoint). `getSuggestions` and `getTrendingSearches` always return `[]`.
- **`getPageInfo` uses a raw `fetch` + regex.** It is not Tavily-backed — it downloads the HTML directly and extracts `<title>` and `<meta name="description">`. `metadata`, `images`, and `links` fields are always empty.
- **`@tavily/core` is the only external runtime dep** (`^0.7.0`). Keep it pinned close to avoid API contract drift.
- For repo-wide conventions (logger-only, ESM modules, naming, architecture rules) see the root `AGENTS.md`.

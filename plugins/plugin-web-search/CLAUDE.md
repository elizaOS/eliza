# @elizaos/plugin-web-search

Adds live web search through a full Tavily service on Node and a minimal
credential-free `./edge` action on Workers.

## Purpose / role

The default export registers a Tavily-backed `WebSearchService` for full Node
runtimes. `@elizaos/plugin-web-search/edge` is a separate genuine plugin export
containing only the public, read-only `WEB_SEARCH` action. It uses fixed keyless
Parallel/Exa MCP endpoints through the bounded transport in `@elizaos/core`, so
it imports no Tavily client, Node service, credential, browser control, or
private account state. Loading an export remains a host policy decision; edge
compatibility does not imply automatic approval for every Shared deployment.

## Plugin surface

| Kind | Name | What it does |
|------|------|-------------|
| Service | `WebSearchService` (`ServiceType.WEB_SEARCH`) | Tavily-backed implementation of `IWebSearchService`; fulfils `search`, `searchNews`, `searchImages`, `searchVideos`, `getSuggestions`, `getTrendingSearches`, `getPageInfo`. |
| Search category | `"web"` (`WEB_SEARCH_CATEGORY`) | Registered with `runtime.registerSearchCategory` so core search dispatch can route to this service. Filters: `topic` (general/news), `searchDepth` (basic/advanced), `includeImages`. |
| Edge action | `WEB_SEARCH` from `./edge` | Stateless public-network read with bounded Parallel/Exa results; safe for an explicitly allowlisted Worker runtime. |

No actions, providers, evaluators, or routes are registered.

## Layout

```
src/
  index.ts                     Plugin object (webSearchPlugin), WEB_SEARCH_CATEGORY definition,
                               registerWebSearchCategory helper. Entry point.
  edge.ts                      Worker-safe plugin/action and explicit compatibility metadata.
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
bun run --cwd plugins/plugin-web-search typecheck   # tsc --noEmit
bun run --cwd plugins/plugin-web-search test        # vitest run --config ./vitest.config.ts
```

Tests live next to the service code and run through Vitest.

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

**Add a Node-only action:**
1. Create `src/actions/<name>.ts` that exports an `Action` object.
2. Import and push it into `webSearchPlugin.actions` in `src/index.ts`.

## Conventions / gotchas

- **Graceful degradation.** The service does not throw during `init`; it sets `this.configured = false` and logs a warning. Callers that invoke `search()` without a key get an `Error` with a clear message.
- **Tavily client is stateless.** `stop()` returns immediately because there is nothing to tear down.
- **Tavily is the only search provider.** `searchVideos` uses Tavily web search with a video-oriented query and image inclusion because Tavily has no dedicated video endpoint. `getSuggestions` and `getTrendingSearches` derive distinct result titles from Tavily general/news searches.
- **Tavily is only in the default Node export.** The `./edge` export uses the
  keyless core transport and must stay free of Node imports, secrets, private
  account access, writes, and arbitrary provider URLs.
- **`getPageInfo` uses a raw `fetch` + regex.** It is not Tavily-backed — it downloads the HTML directly and extracts `<title>` and `<meta name="description">`. `metadata`, `images`, and `links` fields are always empty.
- **`@tavily/core` is the only external runtime dep** (`^0.7.0`). Keep it pinned close to avoid API contract drift.
- For repo-wide conventions (logger-only, ESM modules, naming, architecture rules) see the root `CLAUDE.md`.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.

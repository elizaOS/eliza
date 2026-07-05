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

**Add an action:**
1. Create `src/actions/<name>.ts` that exports an `Action` object.
2. Import and push it into `webSearchPlugin.actions` in `src/index.ts`.

## Conventions / gotchas

- **Graceful degradation.** The service does not throw during `init`; it sets `this.configured = false` and logs a warning. Callers that invoke `search()` without a key get an `Error` with a clear message.
- **Tavily client is stateless.** `stop()` returns immediately because there is nothing to tear down.
- **Tavily is the only search provider.** `searchVideos` uses Tavily web search with a video-oriented query and image inclusion because Tavily has no dedicated video endpoint. `getSuggestions` and `getTrendingSearches` derive distinct result titles from Tavily general/news searches.
- **`getPageInfo` uses a raw `fetch` + regex.** It is not Tavily-backed — it downloads the HTML directly and extracts `<title>` and `<meta name="description">`. `metadata`, `images`, and `links` fields are always empty.
- **`@tavily/core` is the only external runtime dep** (`^0.7.0`). Keep it pinned close to avoid API contract drift.
- For repo-wide conventions (logger-only, ESM modules, naming, architecture rules) see the root `AGENTS.md`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->

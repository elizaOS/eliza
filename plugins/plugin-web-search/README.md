# @elizaos/plugin-web-search

Uses an explicitly authorized Chromium profile for host web searches, with
credential-free Parallel search when no granted browser is available before dispatch.
Select **Use this browser** in the Browser panel to grant the current agent access
to that exact profile; **Stop using this browser** revokes it. Saved selection takes
precedence over `WEB_SEARCH_BROWSER_PROFILE_ID` and `WEB_SEARCH_BROWSER_TARGET_ID`.
A remote profile requires a separate owner grant; conversation relay permission
alone does not grant browser access.

The host uses `./browser-web-search`. It retains complete observed page text and
never replays a dispatched search through another provider after read failures,
consent pages, or human checks. The public edge action remains credential-free.
Provider failures return an explicit unavailable result.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-web-search build  # build
bun plugins/plugin-web-search/scripts/test-browser-search.mjs # real Linux Chromium + Google
```

The live browser check needs the built extension and `/usr/bin/chromium`. It uses
a disposable profile and records evidence in `test-results/browser-search/`. A
Google consent or human-check page is an explicit failure, not a passing search.

Public edge search can use Bing and Google RSS discovery after a Parallel
outage. It keeps feed headlines and descriptions as excerpts, with coverage
and failed-feed names. News dates are feed-reported; web feed crawl dates are
not publisher dates. It does not replay a dispatched browser search, bypass
authentication denials, or treat malformed evidence as permission to retry.

Hosts can compose `publicMarketDataPlugin` from the `market-data` entry point
for read-only Nasdaq quotes and SEC filing/fact reads. SEC requests require
`SEC_USER_AGENT` with the owner's own contact identity. Results keep source
time, fiscal periods, units and coverage; they do not establish current listing
from a historical SEC ticker map or make a trading decision.

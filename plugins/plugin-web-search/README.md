# @elizaos/plugin-web-search

Adds live web search through an owner-authorized Chromium profile, with Tavily as
the Node API fallback and a separate credential-free Worker-safe `./edge` action.

In the Browser panel, choose **Use this browser** under Agent web search. This
persists the exact connected Chromium profile for the active agent. **Stop using
this browser** revokes the selection. The setting is stored per agent and does not
change the process environment. It permits searches in that profile's signed-in
search session. Advanced host configuration can set `WEB_SEARCH_BROWSER_PROFILE_ID`
and `WEB_SEARCH_BROWSER_TARGET_ID` (default `chromium-device`); a saved selection
or explicit disable takes precedence. Never share an owner's profile with tenants.
General searches open a new background tab and retain complete observed page text.
Read failures, consent pages and human checks remain on that tab; they never cause
a second search through another provider.

`TAVILY_API_KEY` enables fallback when no granted browser is available before
dispatch, and serves API-only filters/news/images. A missing key does not disable
an authorized browser. A paired remote device must register a profile-bound browser
target with an owner-authorized browser capability; conversation relay permission
alone does not grant browser access. The host `WEB_SEARCH` action uses
`./browser-web-search` for this routing and otherwise retains its keyless providers;
the stateless `./edge` action does not access local profiles.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-web-search build  # build
bun run --cwd plugins/plugin-web-search test   # tests
bun plugins/plugin-web-search/scripts/test-browser-search.mjs # real Linux Chromium + Google
```

The live browser check needs the built extension and `/usr/bin/chromium`. It uses
a disposable profile and records evidence in `test-results/browser-search/`. A
Google consent or human-check page is an explicit failure, not a passing search.

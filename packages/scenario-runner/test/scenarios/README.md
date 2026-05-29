# Scenario Runner Deterministic PR Catalog

`bun run --cwd packages/scenario-runner test:pr:e2e` runs the zero-cost PR
catalog with `SCENARIO_USE_LLM_PROXY=1` and
`SCENARIO_LLM_PROXY_STRICT=1`:

- `deterministic-pr-smoke` covers the deterministic LLM proxy reply plus
  VIEWS manager, pin, detached window, and mounted-view interact flows.
- `deterministic-app-control-actions` covers VIEWS list, search, show,
  broadcast, create/edit, direct edit, and confirmed delete plus APP list,
  launch, relaunch, `load_from_directory`, and create/edit.
- `deterministic-generated-app-routes` covers a generated app loaded through the
  real AppRegistryService and app-manager routes: registry persistence,
  catalog tile data, generated hero SVG, `/api/apps/:slug/*` package routing,
  run-scoped message/control dispatch, HTTP `load-from-directory`, and
  app-control GUI/TUI view registration.
- `deterministic-todos-actions` covers strict natural-language routing into
  `TODO`, then the real `TODO` action against real TodosService DB state and
  CURRENT_TODOS provider output for write, create, update, complete, cancel,
  delete, list, clear, and active-only provider rendering.
- `deterministic-streaming-actions` covers the real `STREAM` action and stream
  route handler for start, status, stop, provider status rendering, exact
  loopback route responses, and stream destination lifecycle side effects.
- `deterministic-xr-view-actions` covers the real XRSessionService WebSocket,
  XR view catalog/route surface, `XR_LIST_VIEWS`, `XR_OPEN_VIEW`,
  `XR_SWITCH_VIEW`, `XR_RESIZE_VIEW`, `XR_CLOSE_VIEW`, and `XR_QUERY_VISION`
  with a deterministic image-description model and binary camera frame.
- `deterministic-mcp-actions-routes` covers the real `@elizaos/plugin-mcp`
  service against a committed stdio MCP fixture, the parent `MCP` router,
  `MCP_READ_RESOURCE`, `MCP_CALL_TOOL`, `MCP_SEARCH_ACTIONS`,
  `MCP_LIST_CONNECTIONS`, strict deterministic LLM JSON for tool selection and
  arguments, deterministic tool/resource response synthesis, and
  `/api/mcp/status` route capability reporting for the discovered fixture tool
  and resource.
- `deterministic-workflow-actions-routes` covers real embedded workflow services
  from `@elizaos/plugin-workflow` by seeding and executing a Manual Trigger ->
  Set workflow, then asserting `WORKFLOW` execution listing, `/workflows/:id`,
  `/executions`, and exact runData output.
- `deterministic-github-actions-routes` covers the real GitHub promoted issue
  parent `GITHUB` router, promoted issue actions (`GITHUB_ISSUE_CREATE`,
  assign, close, reopen, comment, label), `GITHUB_PR_LIST`,
  `GITHUB_PR_REVIEW`, and `GITHUB_NOTIFICATION_TRIAGE` with confirmation
  gating where required, a fake Octokit client ledger, and
  `/api/github/token` against an isolated empty state directory.
- `deterministic-view-switching` covers every built-in view route through the
  VIEWS show action.
- `deterministic-app-control-nl-routing` covers natural-language APP/VIEWS
  routing with strict Stage 1 and planner fixtures, proving the real message
  runtime selects APP/VIEWS and then executes the real handlers without a live
  provider key.
- `deterministic-browser-actions` covers the browser plugin's keyless web/JSDOM
  command path through promoted BROWSER subactions: get, wait, type, click,
  screenshot, open, list tabs, and close.
- `deterministic-lifeops-scheduled-tasks` covers the real LifeOps
  `SCHEDULED_TASKS` handler and repository-backed `ScheduledTask` state
  transitions for create, list, get, snooze, complete, and history.
- `deterministic-coding-tools-actions` covers the real coding-tools `FILE`,
  `SHELL`, and `WORKTREE` handlers against an isolated throwaway git repo under
  `/tmp`, including file side effects and worktree cleanup.
- `deterministic-agent-skills-actions` covers the real agent-skills parent and
  promoted virtual actions: search, details, install, toggle, sync, uninstall,
  and `USE_SKILL`, with a mocked ClawHub registry/download endpoint and real
  skill storage side effects.
- `deterministic-media-emote-actions` covers `GENERATE_MEDIA` image/audio
  dispatch through deterministic runtime model handlers and `PLAY_EMOTE`
  through the real companion emote action with a mocked `/api/emote` endpoint.

The direct action scenarios assert handler parameters, `ActionResult` fields,
and exact loopback request/response ledgers. The natural-language scenario
asserts the same handler side effects after strict `RESPONSE_HANDLER` and
`ACTION_PLANNER` fixture JSON routes the message through the real runtime. The
shared `_helpers/app-control-http-stub.ts` wrapper prevents one scenario's
loopback stubs from leaking into the next.

Live-mode scenario execution remains separate:

```bash
bun run --cwd packages/scenario-runner test:live:e2e
```

That script intentionally does not set `SCENARIO_USE_LLM_PROXY`; the CLI still
requires a real provider key for live natural-language planner runs.

## Residual Gaps

- Cross-plugin LifeOps/Gmail/calendar action flows beyond `SCHEDULED_TASKS`
  remain live or mock-ledger coverage outside this PR catalog. They should not
  be promoted to zero-key deterministic PR scenarios until their action names
  and structured payloads are supplied by the strict registry.
- Browser bridge, desktop Chromium, and autofill-login branches remain outside
  the zero-key browser scenario because they require a real browser session,
  paired companion, or credential vault state.
- The scenario runtime currently removes `UPDATE_ENTITY` from
  `runtime.actions`, so entity-update realism is intentionally lower than a
  production runtime until action-selection ambiguity is resolved.
- `GENERATE_MEDIA` and `PLAY_EMOTE` are covered at the action-contract layer
  with deterministic model/API stubs; they still do not render real model
  output or animate an actual companion scene in the zero-key PR catalog.
- MCP resource reads and tool calls are keyless-covered with a real stdio MCP
  fixture; the tool-call path uses strict LLM JSON fixtures for selection and
  argument generation, then executes the real stdio tool.

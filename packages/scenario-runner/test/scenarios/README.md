# Scenario Runner Deterministic PR Catalog

`bun run --cwd packages/scenario-runner test:pr:e2e` runs the zero-cost PR
catalog with `SCENARIO_USE_DETERMINISTIC_MODEL=1`. The core deterministic model
provider always requires an exact fixture or explicit resolver:

- `deterministic-pr-smoke` covers the deterministic model reply plus
  VIEWS manager, pin, detached window, and mounted-view interact flows.
- `deterministic-app-control-actions` covers VIEWS list, search, show,
  broadcast, create/edit, direct edit, and confirmed delete plus APP list,
  launch, relaunch, `load_from_directory`, and create/edit.
- `deterministic-background-actions` covers the real `BACKGROUND` handler:
  named-color and hex color set, programmable GLSL shader presets (natural
  phrasing + explicit `preset` param), a live-shader uniform tweak, undo, redo,
  and reset — asserting the exact ordered `background:apply` broadcast ledger.
- `deterministic-settings-voice-actions` covers the real `SETTINGS` voice
  section: continuous-chat on/off, silence window, RMS threshold, and the
  invalid-mode / out-of-range rejections — asserting the exact ordered
  `PUT /api/config` persisted-prefs ledger and matching `voice-settings:apply`
  broadcast ledger, including the #14910 twin-default seeding.
- `deterministic-document-actions` covers the real core `DOCUMENT` handler and
  DocumentService DB state: list, an owner-only mutation-wall refusal for a
  whitelisted connector-admin (ADMIN) non-owner — the resolved tier is pinned
  via the real roles resolution so the fixture cannot silently degrade to
  GUEST — the owner delete (document actually gone), and the not-found /
  missing-id rejections.
- `deterministic-generated-app-routes` covers a generated app loaded through the
  real AppRegistryService and app-manager routes: registry persistence,
  catalog tile data, generated hero SVG, `/api/apps/:slug/*` package routing,
  run-scoped message/control dispatch, HTTP `load-from-directory`, and
  app-control GUI view registration plus compatibility-mode list fallback.
- `deterministic-todos-actions` covers strict natural-language routing into
  `TODO`, then the real `TODO` action against real TodosService DB state and
  CURRENT_TODOS provider output for write, create, update, complete, cancel,
  delete, list, clear, and active-only provider rendering.
- `deterministic-mcp-actions-routes` covers the real `@elizaos/plugin-mcp`
  service against a committed stdio MCP fixture, the parent `MCP` router,
  `MCP_READ_RESOURCE`, `MCP_CALL_TOOL`, `MCP_SEARCH_ACTIONS`,
  `MCP_LIST_CONNECTIONS`, authored strict deterministic model fixtures for
  routing, tool selection, arguments, and response synthesis, plus JSONL
  request/response receipts and child-process teardown proof. It also covers
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
  promoted local actions: toggle, uninstall, and `USE_SKILL`, with real local
  skill storage side effects and no network dependency.
- `deterministic-media-actions` covers `GENERATE_MEDIA` image/audio
  dispatch through deterministic runtime model handlers.

The direct action scenarios assert handler parameters, `ActionResult` fields,
and exact loopback request/response ledgers. The natural-language scenario
asserts the same handler side effects after strict `RESPONSE_HANDLER` and
`ACTION_PLANNER` fixture JSON routes the message through the real runtime. The
shared `_helpers/app-control-http-loopback.ts` wrapper prevents one scenario's
loopback handlers from leaking into the next.

Live-mode scenario execution remains separate:

```bash
bun run --cwd packages/scenario-runner test:live:e2e
```

That script intentionally does not set `SCENARIO_USE_DETERMINISTIC_MODEL`; the CLI still
requires a real provider key for live natural-language planner runs.

- `live-help-knowledge` covers the deleted-Help-view replacement: a real model
  must answer first-run help questions from the bundled help FAQ fragments,
  mention the chat-started rerunnable tutorial/voice/privacy facts, and avoid
  stale "Help view", tutorial launcher tile, or button-below instructions. Run it with
  `eliza-scenarios run packages/scenario-runner/test/scenarios --scenario live-help-knowledge --report <out> --run-dir <dir>`
  and attach the report plus reviewed trajectories.
- `live-lifeops-task-filter-due-window` and `live-plugin-enable-toggle-verb`
  (issue #14368) prove that a real model routes view controls through semantic
  verbs, not the synthetic-DOM bridge: "show me only my overdue tasks" selects
  `SCHEDULED_TASKS action=list dueWindow=overdue` (never `VIEWS agent-fill`) and,
  after a "list my installed plugins" priming turn, "disable the discord plugin"
  selects `PLUGIN action=toggle enabled=false` — the same `PUT /api/plugins/:id`
  the Plugins view's per-card toggle calls (never `VIEWS agent-click`). No
  Tasks/Plugins view is mounted, so the synthetic-DOM path is structurally
  unavailable and each final check asserts no `VIEWS`/`agent-*` capability was
  used. Run both with
  `eliza-scenarios run packages/scenario-runner/test/scenarios --lane live-only '**/live-lifeops-task-filter-due-window.scenario.ts' '**/live-plugin-enable-toggle-verb.scenario.ts' --report <out> --run-dir <dir>`.
  These are live manual evidence assets, not CI gates. Simulated scenario runs
  disable embeddings explicitly; live runs use the configured provider path.
- The chat-widget round-trip legs (MVP ws2 acceptance, #14322/#16939):
  `live-chat-widgets-form-roundtrip` (FORM emit → `[form:submit …]` re-entry →
  values used), `live-chat-widgets-choice-roundtrip` (a `[CHOICE:app-create …]`
  picker, then the bare picked value `cancel` routed back into `APP` and the
  pending-intent task deleted as the domain artifact — this leg also pins the
  threadOps abort guard: a bare option value must be treated as a widget pick,
  never a turn retraction), `live-chat-widgets-config-emission`
  (`[CONFIG:<pluginId>]` for a plugin-setup ask), and
  `live-chat-widgets-followups-restraint` (a factual question comes back with
  no widget markers). The settings-in-chat legs live in
  `plugins/plugin-app-control/test/scenarios/` (`settings-in-chat-config-card`,
  `settings-in-chat-provider-switch`); both seed the production uiWidgets
  guide + agent-level `SETTINGS` action (`_helpers/production-agent-seeds.ts`)
  and the provider switch asserts the persisted per-run `eliza.json` write.
  Run any of them with
  `eliza-scenarios run <scenario-dir> --scenario <id> --report <out> --run-dir <dir>`
  against a live model and attach the hand-read report + trajectories; the
  rendered-surface companion is
  `packages/app/test/ui-smoke/settings-in-chat-live.spec.ts`
  (`ELIZA_UI_SMOKE_LIVE_STACK=1`).

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
- `GENERATE_MEDIA` is covered at the action-contract layer with deterministic
  model doubles; it still does not render real model output in the zero-key PR
  catalog.
- MCP resource reads and tool calls are keyless-covered with a real stdio MCP
  fixture; the tool-call path uses strict LLM JSON fixtures for selection and
  argument generation, then executes the real stdio tool.

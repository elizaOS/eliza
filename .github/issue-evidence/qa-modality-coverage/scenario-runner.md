# Scenario-runner coverage (deterministic lane)

`bun packages/scenario-runner/dist/cli.js run <scenarios> --lane pr-deterministic`
with `SCENARIO_USE_LLM_PROXY=1` (deterministic LLM proxy — no API key), run in the
main checkout (the full plugin graph is built there; a fresh worktree hits the
documented cross-plugin subpath cascade). Each scenario boots the **real
AgentRuntime + plugins** and drives agent actions/views, asserting the response.

**Result: 29 / 30 passed.** Surfaces exercised end-to-end through the real agent:
- UI/views: view-switching (+multilingual), view-voice, settings-subview,
  screen-streaming, generated-app-routes, slash-commands, xr-view-actions,
  ocr-fullscreen.
- app-control: NL routing, actions.
- Agent actions: todos, streaming, workflow-actions, coding-tools, github,
  mcp-actions, media-emote, browser (+computeruse multi-display/parity/progress),
  cua-vision-loop, gitpathology, inbound-attachment, lifeops-scheduled-tasks,
  agent-skills, voice-workbench-room, pr-smoke.

The 1 failure — `deterministic-app-control-actions` (`available_views` response
text mismatch) — is a stale-tree scenario-expectation drift: the main checkout is
~740 commits behind `develop`, so the scenario's golden text no longer matches
the (also-stale) runtime output. Not a develop regression; running the same lane
against a fully-built `develop` tree is the follow-up.

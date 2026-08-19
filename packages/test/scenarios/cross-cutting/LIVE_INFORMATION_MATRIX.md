# Live-information planner matrix

The `cross.live-information-routing` scenario is a diagnostic `live-only` run.
It boots the real in-process scenario runtime and planner, registers the
production `WEB_FETCH` and `WEB_SEARCH` actions, and exercises current weather,
spot price, news, recommendations, an ambiguous historical range, adversarial
parameters, private-host rejection, and public-endpoint failure.

This is not provider-qualified production-ingress evidence. The in-process
runner creates scenario identities and uses local PGLite, so its reports remain
ineligible for publication as provider evidence even when the model and web
requests are live.

## Declared planner backends

Run each configured backend in a separate process from the repository root.
The `--provider` flag fails when the requested backend is unavailable and
cannot be combined with deterministic mode.

```bash
bun --conditions eliza-source --tsconfig-override tsconfig.json \
  packages/scenario-runner/src/cli.ts run packages/test/scenarios \
  --scenario cross.live-information-routing --lane live-only \
  --provider openai --run-dir /tmp/live-info-openai/run \
  --report-dir /tmp/live-info-openai/report \
  --export-native /tmp/live-info-openai/native.jsonl

# Repeat with each configured backend:
#   groq, anthropic, google, openrouter, cli
```

Model selection remains the provider plugin's existing configuration contract
(`*_SMALL_MODEL`, `*_LARGE_MODEL`, or the CLI-inference model settings). Include
the weaker planner that previously reproduced the route miss. Do not infer the
model from requested environment variables: verify the provider/model recorded
in native trajectory rows before describing a run.

## Review boundary

The report stages are deliberately separate:

- `expectedActions` records capability selection.
- `assertTurn` checks action arguments, public HTTPS construction, and explicit
  success/failure semantics.
- `responseJudge` checks grounding and honest failure replies.
- The final check proves that both capability families and a failed fetch were
  observed.

For every backend, manually review the viewer, report, native JSONL and privacy
manifest, trajectory tool arguments/results, final replies, and terminal
backend logs. Attach those artifacts to the issue/PR; do not commit them. Never
persist or upload raw stdout/stderr without a separate secret scan and manual
review. A run is incomplete when the acting model also judges itself: configure
an independent judge and verify that the report does not mark it self-graded.

# Live-information planner matrix

The `cross.live-information-routing` scenario uses the production agent-host
`WEB_FETCH` and `WEB_SEARCH` actions inside the real scenario runtime. It covers
current weather, spot price, news, recommendations, an ambiguous historical
range, adversarial location and asset strings, a private-host SSRF rejection,
and an unavailable public endpoint.

Run the declared matrix from the repository root:

```bash
bun run --cwd packages/test test:live-information
```

The matrix currently evaluates:

| Target | Planner | Purpose |
| --- | --- | --- |
| `openai-cloud-mini` | `gpt-5.4-mini` through the configured Eliza Cloud gateway | Weaker hosted-planner regression target |
| `codex-sol` | `gpt-5.6-sol` through the Codex CLI | Current Codex planner |
| `claude-sonnet` | `claude-sonnet-4-6` through the Claude CLI | Cross-family subscription planner |

Use `--target <id>` to run one target and `--output <dir>` to choose the local
evidence root. By default, output goes under the gitignored
`evidence/live-information/` tree. Each target retains its scenario report,
viewer, trajectories, native JSONL and manifest, and backend log. The top-level
`matrix-summary.json` contains only provider/model labels, exit status, and
relative artifact paths; it never copies provider credentials.

CLI executables outside the plugin's launcher allowlist must be pinned with
`ELIZA_CLI_CODEX_BIN` or `ELIZA_CLI_CLAUDE_BIN`. The pins are executable paths,
not credentials, and the corresponding CLI must already have its own usable
local login. Hosted targets continue to use their configured provider secret.

The run is not complete evidence until a reviewer opens every viewer, inspects
the recorded tool arguments/results and final replies, and confirms that the
successful answers are grounded and the two failure cases remain visibly
unavailable. Generated evidence stays local and is attached to the issue and PR
rather than committed.

The report keeps the failure stages distinct: `expectedActions` records route
selection, `assertTurn` checks URL safety and execution semantics,
`responseJudge` scores grounding, and the final check verifies that both live
capability families and the guarded-failure path were actually exercised.

# Issue 10317 — Sub-agent Credential Bridge Validation

Date: 2026-07-01
Branch: `codex/fix-10317-credential-bridge`

## Verified Passing

```bash
/Users/shawwalters/.bun/bin/bun run --cwd packages/app-core test \
  src/services/credential-tunnel-service.test.ts \
  src/api/credential-tunnel-routes.test.ts \
  src/services/sensitive-requests/owner-app-inline-adapter.test.ts \
  src/runtime/repair-boot-phase.test.ts \
  --coverage.enabled=false
```

Result: 4 files passed, 39 tests passed.

```bash
/Users/shawwalters/.bun/bin/bun run --cwd packages/ui test \
  src/components/chat/MessageContent.sensitive-request.test.tsx \
  src/api/client-agent-credential-tunnel.test.ts \
  --coverage.enabled=false
```

Result: 2 files passed, 11 tests passed.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  /Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-agent-orchestrator test \
  __tests__/unit/bridge-routes.test.ts \
  __tests__/unit/acp-service.test.ts \
  --coverage.enabled=false
```

Result: 2 files passed, 58 tests passed.

```bash
/Users/shawwalters/.bun/bin/bun test \
  packages/core/src/features/sub-agent-credentials/actions/*.test.ts
```

Result: 4 files passed, 13 tests passed.

```bash
/Users/shawwalters/.bun/bin/bun test \
  packages/core/src/sensitive-requests/dispatch-registry.test.ts
```

Result: 1 file passed, 7 tests passed.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  /Users/shawwalters/.bun/bin/bun test \
  packages/core/src/runtime/__tests__/execute-planned-tool-call.test.ts
```

Result: 1 file passed, 25 tests passed. This includes coverage that actions
marked `suppressActionResultClipboard` suppress sensitive `data` from
`ACTION_COMPLETED` event content while still returning the data to the caller.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  /Users/shawwalters/.bun/bin/bun run --cwd packages/agent test \
  src/runtime/sub-agent-credentials-runtime-policy.test.ts \
  --coverage.enabled=false
```

Result: 1 file passed, 3 tests passed.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  /Users/shawwalters/.bun/bin/bun run --cwd packages/scenario-runner test \
  src/executor.test.ts \
  --coverage.enabled=false
```

Result: 1 file passed, 28 tests passed. This includes API-turn response field
capture support and report redaction used by the credential bridge scenarios.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 \
  /Users/shawwalters/.bun/bin/bun --conditions eliza-source \
  --tsconfig-override ../../tsconfig.json \
  src/cli.ts run test/scenarios \
  --lane pr-deterministic \
  --scenario deterministic-sub-agent-credential-request \
  --report ../../.github/issue-evidence/8907-credential-request/001-scenario-report.json \
  --report-dir ../../.github/issue-evidence/8907-credential-request/report-bundle \
  --run-dir ../../.github/issue-evidence/8907-credential-request/run \
  --export-native ../../.github/issue-evidence/8907-credential-request/native.jsonl
```

Result: 1 scenario passed, 0 failed, 0 skipped. Current run id:
`1a66ee20-1deb-4443-be82-31bb6daea234`; provider:
`deterministic-llm-proxy`. The scenario boots a real `AgentRuntime`, real
coding-agent route plugin, real `CredentialTunnelService`, real parent bridge
adapter, real authenticated `/api/credential-tunnel` route, and real owner-app
inline sensitive-request adapter. It covers inactive-session rejection, scope
minting, owner inline form delivery, owner tunnel submission, one-shot child
redemption, replay rejection, and a final memory scan that confirms the scoped
token and dummy credential value never entered persisted chat memories. Evidence
is under `.github/issue-evidence/8907-credential-request/`.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  /Users/shawwalters/.bun/bin/npx -y @zed-industries/codex-acp@0.14.0 --help
```

Result: passed from `/tmp`; `codex-acp` is available through the native
transient command path used by `AcpService`.

Native Codex ACP does not require a globally installed `acpx` binary. The
default/native path uses the transient
`npx -y @zed-industries/codex-acp@0.14.0` command. The legacy CLI transport still
requires `ELIZA_ACP_TRANSPORT=cli` and either a global `acpx` or an explicit
`ELIZA_ACP_COMMAND`.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  RUN_LIVE_NATIVE_ACP=1 LIVE_NATIVE_ACP_TIMEOUT_MS=60000 \
  /Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-agent-orchestrator \
  test:e2e:native
```

Result: passed. The package script built the orchestrator plugin and then
spawned a real native Codex ACP child through the transient
`@zed-industries/codex-acp@0.14.0` command path with an isolated `CODEX_HOME`
linked to the machine's real Codex auth. The child returned the expected final
answer and emitted `NATIVE ACP SMOKE PASSED`.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  RUN_LIVE_CREDENTIAL_ACP=1 \
  LIVE_CREDENTIAL_PROOF_OUT="/Users/shawwalters/.codex/worktrees/b1d3/eliza/.github/issue-evidence/8907-credential-request/8907-live-child-proof.json" \
  OPENAI_API_KEY=sk-scenario-runner-preflight-not-used \
  /Users/shawwalters/.bun/bin/bun --conditions eliza-source \
  --tsconfig-override ../../tsconfig.json \
  src/cli.ts run test/scenarios \
  --lane live-only \
  --scenario live-sub-agent-credential-request \
  --report ../../.github/issue-evidence/8907-credential-request/002-live-scenario-report.json \
  --report-dir ../../.github/issue-evidence/8907-credential-request/live-report-bundle \
  --run-dir ../../.github/issue-evidence/8907-credential-request/live-run \
  --export-native ../../.github/issue-evidence/8907-credential-request/live-native.jsonl
```

Result: 1 live scenario passed, 0 failed, 0 skipped. Current run id:
`68e7e52d-118a-4981-a9c2-9bbd559e939e`; provider: `openai`. The scenario
starts the real runtime route stack, launches a real Codex ACP child through the
native `npx @zed-industries/codex-acp@0.14.0` path, has that child POST the
credential request over the scenario loopback API, captures the owner-app inline
sensitive request, submits the owner credential through the authenticated tunnel
route, waits for the child GET to redeem it, verifies replay returns
`already_redeemed`, verifies the persisted memories contain the inline form and
resolved follow-up but not the credential value, and writes a redacted child
proof artifact:
`.github/issue-evidence/8907-credential-request/8907-live-child-proof.json`.
After artifacts were written, Bun emitted an internal `directory mismatch`
diagnostic for the root `tsconfig.json`; the process still exited 0 and the
scenario report was written as passed.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  ELIZA_NODE_PATH="/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  /Users/shawwalters/.bun/bin/bun run --cwd packages/app test:e2e \
  test/ui-smoke/sensitive-request-in-chat.spec.ts --project=chromium
```

Result: 3 tests passed. The smoke covers secret requests, OAuth requests, and
sub-agent credential tunnel requests in the real chat surface. It verifies
tunneled credentials call `/api/credential-tunnel`, never call `/api/secrets`,
and do not leak raw credential values into chat request bodies or the DOM. It
wrote manually reviewed desktop and mobile screenshots:
`.github/issue-evidence/8907-credential-request/8907-sensitive-request-desktop.png`
and
`.github/issue-evidence/8907-credential-request/8907-sensitive-request-mobile.png`.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  ELIZA_NODE_PATH="/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  /Users/shawwalters/.bun/bin/bun run --cwd packages/app audit:app
```

Result: 369 passed in 14.5 minutes. The audit summary reported
`broken=0`, `needs-work=0`, `needs-eyeball=228`, `good=140`, and
`minimalism-budget-failures=0`. The built-in chat screenshots were manually
opened after capture; desktop and mobile showed no credential-related leakage or
layout breakage in the audited default state. The explicit `ELIZA_NODE_PATH`
uses the bundled Node runtime because this worktree does not have a `node`
binary on PATH.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  /Users/shawwalters/.bun/bin/bun run --cwd packages/core typecheck
```

Result: passed.

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" \
  /Users/shawwalters/.bun/bin/bun run --cwd packages/ui typecheck
```

Result: passed.

```bash
git diff --check
```

Result: passed.

## Known Workspace Limitations

Package typechecks for app-core, agent, and plugin-agent-orchestrator still fail
on existing broader workspace issues:

- `packages/app-core typecheck`: missing optional/native packages
  (`@elizaos/plugin-background-runner`, `@elizaos/plugin-anthropic`,
  `@elizaos/capacitor-*`, `@elizaos/tui`, `@elizaos/cloud-routing`) and
  unrelated `unknown` iOS bridge diagnostics.
- `packages/agent typecheck`: missing `@elizaos/plugin-streaming`,
  `@elizaos/plugin-background-runner`, and `@elizaos/cloud-routing`.
- `plugins/plugin-agent-orchestrator typecheck`: missing
  `@elizaos/agent/utils/atomic-json` from an app-core account bridge import.

`packages/ui typecheck` and `packages/core typecheck` pass.

The deterministic AC4-style runtime/API trajectory and the live Codex ACP
credential roundtrip are captured and manually reviewed under
`.github/issue-evidence/8907-credential-request/`. The deterministic
scenario-runner native JSONL export has zero rows because it is API/final-check
driven. The live native JSONL export has 1 parsed trajectory row from the
external Codex ACP child and 1 passed row. Native Codex ACP does not require
global `acpx`; `acpx` is only relevant to the legacy `ELIZA_ACP_TRANSPORT=cli`
path.

## Evidence Notes

The passing tests cover:

- Parent-runtime credential bridge adapter dispatching owner-only inline
  sensitive requests with tunnel metadata and no scoped token or value in chat.
- Authenticated `/api/credential-tunnel` owner route success and error mapping.
- Owner-app inline form projection for multi-key tunneled credentials.
- UI form submission routing tunneled credentials to `/api/credential-tunnel`
  instead of `/api/secrets`.
- Child-facing orchestrator bridge origin metadata propagation and exact
  rejection code preservation.
- ACP native and CLI child process envs receive their own
  `PARALLAX_SESSION_ID`; parent-only credential plugin registration is skipped
  for those child runtimes.
- Existing core sub-agent credential actions against the widened bridge
  contract.
- Sensitive-request dispatch registry multi-adapter registration, routing, and
  adapter invocation.
- Runtime `ACTION_COMPLETED` event redaction for action definitions marked
  `suppressActionResultClipboard`, preventing scoped credential action `data`
  from entering event/trajectory content.
- Deterministic scenario-runner evidence for the bridge roundtrip using real
  runtime services and API routes. Scenario reports and viewer data redact
  scoped tokens, credential values, and sensitive action result payloads.
- Live Codex ACP credential scenario coverage proving the real native child
  transport, real Codex account materialization, owner inline credential submit,
  one-shot child redemption, replay rejection, and no memory persistence of the
  credential value.
- App chat smoke evidence proving the tunneled credential request is submitted
  through `/api/credential-tunnel`, not `/api/secrets`, and remains absent from
  DOM and chat request payloads.

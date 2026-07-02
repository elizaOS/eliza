# Issue 10317 / 8907 Credential Request Evidence

Date: 2026-07-01
Scenario: `deterministic-sub-agent-credential-request`
Run id: `1a66ee20-1deb-4443-be82-31bb6daea234`
Provider: `deterministic-llm-proxy`

Live scenario: `live-sub-agent-credential-request`
Live run id: `68e7e52d-118a-4981-a9c2-9bbd559e939e`
Live provider: `openai`

## Verdict

Passed deterministic bridge scenario:

```bash
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
  src/cli.ts run test/scenarios \
  --lane pr-deterministic \
  --scenario deterministic-sub-agent-credential-request \
  --report ../../.github/issue-evidence/8907-credential-request/001-scenario-report.json \
  --report-dir ../../.github/issue-evidence/8907-credential-request/report-bundle \
  --run-dir ../../.github/issue-evidence/8907-credential-request/run \
  --export-native ../../.github/issue-evidence/8907-credential-request/native.jsonl
```

Result: 1 passed, 0 failed, 0 skipped. The scenario booted a real
`AgentRuntime`, registered the real coding-agent route plugin, the real
`CredentialTunnelService`, the real sub-agent bridge adapter, and the real
owner-app inline sensitive-request adapter.

Passed live Codex ACP bridge scenario:

```bash
RUN_LIVE_CREDENTIAL_ACP=1 \
LIVE_CREDENTIAL_PROOF_OUT="/Users/shawwalters/.codex/worktrees/b1d3/eliza/.github/issue-evidence/8907-credential-request/8907-live-child-proof.json" \
OPENAI_API_KEY=sk-scenario-runner-preflight-not-used \
bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
  src/cli.ts run test/scenarios \
  --lane live-only \
  --scenario live-sub-agent-credential-request \
  --report ../../.github/issue-evidence/8907-credential-request/002-live-scenario-report.json \
  --report-dir ../../.github/issue-evidence/8907-credential-request/live-report-bundle \
  --run-dir ../../.github/issue-evidence/8907-credential-request/live-run \
  --export-native ../../.github/issue-evidence/8907-credential-request/live-native.jsonl
```

Result: 1 passed, 0 failed, 0 skipped. The live scenario launched a real Codex
ACP child through `npx @zed-industries/codex-acp@0.14.0`, drove the child over
the loopback credential endpoints, captured the owner inline sensitive-request
form, submitted the owner credential through `/api/credential-tunnel`, verified
the child redeemed it once, verified replay returned `already_redeemed`, and
wrote a redacted child proof JSON.

Passed native Codex ACP smoke:

```bash
RUN_LIVE_NATIVE_ACP=1 LIVE_NATIVE_ACP_TIMEOUT_MS=60000 \
  bun run --cwd plugins/plugin-agent-orchestrator test:e2e:native
```

Result: passed. This verifies the default/native transport path without a
globally installed `acpx` binary. The native path uses transient
`npx -y @zed-industries/codex-acp@0.14.0`; `acpx` is only required for the
legacy `ELIZA_ACP_TRANSPORT=cli` path.

Passed app chat smoke:

```bash
ELIZA_NODE_PATH="/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  bun run --cwd packages/app test:e2e \
  test/ui-smoke/sensitive-request-in-chat.spec.ts --project=chromium
```

Result: 3 passed. Desktop and mobile screenshots were captured and manually
opened.

## Criteria Covered

- Unknown child session POST rejected with `410 session_not_active`.
- Active child POST minted a credential scope, scoped token, and one
  sensitive-request id.
- Owner-app inline sensitive request was persisted as a real `messages` memory
  with tunnel routing metadata and form fields for `OPENAI_API_KEY` and
  `STRIPE_API_KEY`.
- Owner POST to `/api/credential-tunnel` staged the credential without returning
  the value or scoped token.
- Child GET to `/api/coding-agents/:sessionId/credentials/OPENAI_API_KEY`
  returned the value once.
- Replay of the same child GET returned `403 already_redeemed`.
- Final check scanned captured `messages` memory writes and passed: scoped token
  and dummy credential value did not enter chat memories.
- Live Codex ACP child proved the same owner-submit → child-redeem → replay
  reject flow with the credential value redacted in evidence and absent from
  persisted message memories.

## Artifacts

- `001-scenario-report.json`: aggregate scenario report.
- `report-bundle/001-deterministic-sub-agent-credential-request.json`: per-scenario report.
- `run/viewer/index.html`: run viewer.
- `native.jsonl` and `native.manifest.json`: native export. This scenario has no
  model-boundary rows because it uses API turns only.
- `8907-bridge-roundtrip.log`: manually redacted roundtrip summary.
- `8907-child-get-response.json`: manually redacted child redemption response.
- `002-live-scenario-report.json`: aggregate live Codex ACP credential report.
- `live-report-bundle/001-live-sub-agent-credential-request.json`: per-scenario
  live report.
- `live-run/viewer/index.html`: live run viewer.
- `live-native.jsonl` and `live-native.manifest.json`: native export for the
  live run. It has 1 parsed trajectory row from the external Codex ACP child and
  1 passed row.
- `8907-live-child-proof.json`: redacted proof written after the live child
  proof file was verified by the scenario final check.
- `8907-live-codex-acp-smoke.log`: manually redacted proof that this machine can
  run a real Codex ACP child through the native transient command path.
- `8907-sensitive-request-desktop.png`: manually reviewed desktop screenshot of
  the credential tunnel request in chat.
- `8907-sensitive-request-mobile.png`: manually reviewed mobile screenshot of
  the credential tunnel request in chat.

Note: scenario reports, report bundles, and viewer data redact scoped tokens,
credential values, child final text, and sensitive action result payloads. The
raw assertion path still validates the one-shot redemption flow before writing
redacted evidence. The live run emitted a Bun internal `directory mismatch`
diagnostic after writing artifacts; the process exited 0 and the live report is
passed.

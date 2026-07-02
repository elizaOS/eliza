# Issue #11221 - Codex ACP Landlock Sandbox Fallback

## Change

- Added Codex ACP sandbox command handling in `AcpService`:
  - `ELIZA_CODEX_ACP_SANDBOX_MODE` / `ELIZA_CODEX_SANDBOX_MODE` appends `-c sandbox_mode=<mode>`.
  - `ELIZA_CODEX_ACP_APPROVAL_POLICY` / `ELIZA_CODEX_APPROVAL_POLICY` appends `-c approval_policy=<policy>`.
  - `ELIZA_CODEX_ACP_LANDLOCK=0` / `ELIZA_CODEX_LANDLOCK=0` forces the no-Landlock fallback.
  - When Linux LSM probing proves Landlock unavailable, Codex ACP starts with `sandbox_mode=danger-full-access` and `approval_policy=never` by default.
  - If Codex still exits with the Landlock panic at startup, the orchestrator retries once with the same no-Landlock fallback before marking the session errored.
- Added `NativeAcpClient` startup stderr capture so exit-101 errors preserve the Codex panic text.
- Documented the deployment knobs in package metadata, README, CLAUDE.md, and AGENTS.md.

## Manual Review

- Reviewed the command strings passed into mocked `NativeAcpClient`:
  - configured sandbox: `codex-acp --stdio -c sandbox_mode=workspace-write -c approval_policy=never`
  - generic alias sandbox: `codex-acp --stdio -c sandbox_mode=read-only -c approval_policy=on-request`
  - no-Landlock probe fallback: `codex-acp --stdio -c sandbox_mode=danger-full-access -c approval_policy=never`
  - panic retry first starts with `codex-acp --stdio`, then retries with the fallback command.
- Reviewed the warning assertions to confirm operators see a clear `Landlock unavailable` fallback log.
- No UI, screenshots, video, live LLM trajectory, DB rows, audio, wallet, or on-chain artifacts apply: this is a Node-only ACP spawn/configuration fix covered by process-command and stderr behavior tests.

## Verification

Passed:

```bash
bun install --frozen-lockfile
bun run --cwd packages/core prebuild && bun run --cwd packages/core build:node
bun run --cwd packages/agent build
bunx vitest run --config vitest.config.ts __tests__/unit/codex-sandbox.test.ts __tests__/unit/acp-service.test.ts __tests__/unit/acp-native-transport.test.ts --testTimeout 60000
bunx vitest run --config vitest.config.ts __tests__/unit --testTimeout 60000
bun run --cwd plugins/plugin-agent-orchestrator typecheck
bun run --cwd plugins/plugin-agent-orchestrator test
bun run --cwd plugins/plugin-agent-orchestrator build
bunx @biomejs/biome check plugins/plugin-agent-orchestrator/src/services/codex-sandbox.ts plugins/plugin-agent-orchestrator/src/services/acp-service.ts plugins/plugin-agent-orchestrator/src/services/acp-native-transport.ts plugins/plugin-agent-orchestrator/__tests__/unit/codex-sandbox.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-service.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-native-transport.test.ts plugins/plugin-agent-orchestrator/package.json plugins/plugin-agent-orchestrator/README.md plugins/plugin-agent-orchestrator/CLAUDE.md plugins/plugin-agent-orchestrator/AGENTS.md --no-errors-on-unmatched
```

Focused Vitest result after rebase: 3 files passed, 71 tests passed.

Full unit result after rebase with explicit timeout: 111 files passed, 1161 tests passed.

Full orchestrator test result after rebase: 140 files passed, 3 skipped; 1419 tests passed, 6 skipped.

Known unrelated failures observed:

```bash
bun run --cwd plugins/plugin-agent-orchestrator lint:check
```

Fails on pre-existing package-wide lint/format issues outside this change, including `src/__tests__/swarm-coordinator-acp-bind.test.ts`, `src/__tests__/keyless-app-creation.e2e.test.ts`, `__tests__/fixtures/fake-acp-agent.mjs`, `src/actions/tasks.ts`, `src/services/completion-envelope.ts`, `src/services/interruption-decider.ts`, `src/services/sub-agent-router.ts`, and `src/services/workspace-diff.ts`. The changed files pass Biome directly.

```bash
bun run verify
```

Fails before Turbo at the current repository type-safety ratchet baseline:

- `as unknown as`: 80 current > 77 baseline
- `?? {}` (core/agent/app-core): 379 current > 377 baseline

The changed files are not listed in the ratchet output.

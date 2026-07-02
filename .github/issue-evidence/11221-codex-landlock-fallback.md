# Issue #11221 Evidence: Codex ACP Landlock Fallback

## Change

- Added Codex ACP command resolution for sandbox overrides:
  - `ELIZA_CODEX_SANDBOX_MODE` / `ELIZA_CODEX_ACP_SANDBOX_MODE`
  - `ELIZA_CODEX_NO_LANDLOCK_SANDBOX_MODE` / `ELIZA_CODEX_ACP_NO_LANDLOCK_SANDBOX_MODE`
  - `ELIZA_CODEX_APPROVAL_POLICY` / `ELIZA_CODEX_ACP_APPROVAL_POLICY`
  - `ELIZA_CODEX_LANDLOCK_AVAILABLE` / `ELIZA_CODEX_ACP_LANDLOCK_AVAILABLE`
- Added Linux Landlock detection from `/sys/kernel/security/lsm`.
- Added a native transport retry path for the known Codex exit-101 Landlock panic.
- Kept existing sandbox config in `ELIZA_CODEX_ACP_COMMAND` authoritative; no duplicate `sandbox_mode` args are appended.

## Validation

### Focused regression tests

Command:

```bash
bunx vitest run --config vitest.config.ts __tests__/unit/codex-sandbox.test.ts __tests__/unit/acp-native-transport.test.ts __tests__/unit/acp-service.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests       69 passed (69)
```

The transport regression simulates the real Codex failure signature:

```text
permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock
```

and verifies a second spawn with:

```text
-c sandbox_mode="danger-full-access" -c approval_policy="never"
```

### Package gates

```bash
bun run --cwd packages/core build
bun run --cwd packages/agent build
bun run --cwd plugins/plugin-agent-orchestrator typecheck
bun run --cwd plugins/plugin-agent-orchestrator build
```

Result: all passed.

### Touched-file lint

```bash
bunx @biomejs/biome check plugins/plugin-agent-orchestrator/src/services/acp-service.ts plugins/plugin-agent-orchestrator/src/services/acp-native-transport.ts plugins/plugin-agent-orchestrator/src/services/codex-sandbox.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-service.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-native-transport.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/codex-sandbox.test.ts
```

Result:

```text
Checked 6 files. No fixes applied.
```

### Known unrelated gate failures

`bun run verify` fails before Turbo at the repository type-safety ratchet:

```text
[type-safety-ratchet] as unknown as: 80 / 77
[type-safety-ratchet] `?? {}` (core/agent/app-core): 379 / 377
[type-safety-ratchet] unsafe cast baseline exceeded
```

`bun run --cwd plugins/plugin-agent-orchestrator test:unit` currently times out in the full suite at `__tests__/unit/task-policy.test.ts`:

```text
keeps the built-in Discord ADMIN gate when only another connector is overridden
Error: Test timed out in 5000ms.
```

That file passes when run by itself:

```text
Test Files  1 passed (1)
Tests       2 passed (2)
```

The timeout is unrelated to Codex ACP command construction or native transport spawn behavior.

`bun run --cwd plugins/plugin-agent-orchestrator lint:check` currently fails on pre-existing formatting/import issues in files outside this change set, including:

- `src/__tests__/swarm-coordinator-acp-bind.test.ts`
- `__tests__/fixtures/fake-acp-agent.mjs`
- `__tests__/unit/interruption-decider.test.ts`
- `src/__tests__/keyless-app-creation.e2e.test.ts`
- `src/actions/tasks.ts`
- `src/services/completion-envelope.ts`
- `src/services/interruption-decider.ts`
- `src/services/sub-agent-router.ts`
- `src/services/workspace-diff.ts`

## Live Platform Evidence

This machine is macOS:

```text
Darwin Shaws-MacBook-Pro.local 25.2.0 Darwin Kernel Version 25.2.0: Tue Nov 18 21:09:56 PST 2025; root:xnu-12377.61.12~1/RELEASE_ARM64_T6041 arm64
```

Docker CLI is installed, but the Docker daemon is not running:

```text
Cannot connect to the Docker daemon at unix:///Users/shawwalters/.docker/run/docker.sock. Is the docker daemon running?
```

So a live Linux no-Landlock container reproduction could not be captured on this host. The no-Landlock behavior is covered by deterministic unit tests that force detection to `false`, and by a transport-level regression that feeds the exact exit-101 panic text through the native ACP process lifecycle.

## UI, Logs, And LLM Trajectories

- UI screenshots/video: N/A - no UI behavior changed.
- Frontend logs/network logs: N/A - no frontend path changed.
- Live LLM trajectory: N/A - no prompt/model/action behavior changed; this is native process command construction and spawn recovery.
- Backend logs: covered by unit assertions around the fallback path and service warning path; no long-running server was started for this infra-only change.

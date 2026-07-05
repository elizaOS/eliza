# #13773 Native Terminal Git Env Isolation

Date: 2026-07-05
Branch: `fix/13773-workspace-isolation`

## What Changed

- Native ACP `terminal/create` now preserves the session-owned `GIT_INDEX_FILE`
  from the trusted session env and removes ACP-requested `GIT_INDEX_FILE`,
  `GIT_DIR`, and `GIT_WORK_TREE` overrides.
- `runGitForAcp()` now uses a bounded synchronous git probe that returns
  `undefined` on git failure/unavailability instead of assuming a subprocess
  object exists. This keeps same-repo git-index setup fail-closed and fixed the
  current unit harness residual from the existing #13773 implementation.

## Verification

Passed:

```bash
bunx vitest run plugins/plugin-agent-orchestrator/__tests__/unit/acp-native-transport.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/workspace-isolation.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-scratch-gc.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-service.test.ts
# Test Files  4 passed (4)
# Tests       92 passed (92)
```

```bash
bunx biome check plugins/plugin-agent-orchestrator/src/services/acp-service.ts plugins/plugin-agent-orchestrator/src/services/acp-native-transport.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-native-transport.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/workspace-isolation.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-scratch-gc.test.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-service.test.ts
# Checked 6 files. No fixes applied.
```

```bash
git diff --check
# passed
```

Known unrelated blocker:

```bash
bun run --cwd plugins/plugin-agent-orchestrator typecheck
# fails because @elizaos/contracts declarations are missing from core/shared imports
```

No UI, browser, mobile, live-model, or screenshot evidence applies; this is a
subprocess environment isolation fix covered by unit-level process-env
assertions.

## Follow-up: case-insensitive git env protection

After #14238 merged, native terminal env protection was hardened to delete
`GIT_INDEX_FILE`, `GIT_DIR`, and `GIT_WORK_TREE` case-insensitively before
restoring the trusted session-owned `GIT_INDEX_FILE`. This covers Windows child
process environments, where variable lookup is case-insensitive.

Passed:

```bash
bunx vitest run plugins/plugin-agent-orchestrator/__tests__/unit/acp-native-transport.test.ts
# Test Files  1 passed (1)
# Tests       21 passed (21)
```

```bash
bunx biome check plugins/plugin-agent-orchestrator/src/services/acp-native-transport.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-native-transport.test.ts .github/issue-evidence/13773-native-terminal-git-env.md
# Checked 2 files. No fixes applied.
```

```bash
git diff --check -- plugins/plugin-agent-orchestrator/src/services/acp-native-transport.ts plugins/plugin-agent-orchestrator/__tests__/unit/acp-native-transport.test.ts .github/issue-evidence/13773-native-terminal-git-env.md
# passed
```

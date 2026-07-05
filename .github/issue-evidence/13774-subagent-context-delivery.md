# 13774 subagent context delivery

## Scope

- Default sub-agent capability prompt advertises `USE_SKILL parent-agent`.
- Spawn workspaces get `SKILLS.md` from the shared `AcpService.spawnSession` path, not only economics task spawns.
- Parent-context bridge exposes task goal, acceptance criteria, and recent decisions when a session is task-bound.
- Loopback bridge adds:
  - `GET /api/coding-agents/:sessionId/skills`
  - `GET /api/coding-agents/:sessionId/skills/:slug`

## Verification

Passed:

```bash
bunx @biomejs/biome check \
  plugins/plugin-agent-orchestrator/src/services/goal-prompt.ts \
  plugins/plugin-agent-orchestrator/src/services/skill-recommender.ts \
  plugins/plugin-agent-orchestrator/src/services/sub-agent-identity.ts \
  plugins/plugin-agent-orchestrator/src/services/skill-manifest.ts \
  plugins/plugin-agent-orchestrator/src/services/acp-service.ts \
  plugins/plugin-agent-orchestrator/src/services/orchestrator-task-service.ts \
  plugins/plugin-agent-orchestrator/src/api/parent-context-routes.ts \
  plugins/plugin-agent-orchestrator/src/setup-routes.ts \
  plugins/plugin-agent-orchestrator/src/services/parent-agent-broker.ts \
  plugins/plugin-agent-orchestrator/src/services/parent-agent-manifest.ts \
  plugins/plugin-agent-orchestrator/src/__tests__/goal-prompt.test.ts \
  plugins/plugin-agent-orchestrator/src/__tests__/skill-manifest.test.ts \
  plugins/plugin-agent-orchestrator/src/__tests__/parent-context-routes.test.ts

bun test \
  ./plugins/plugin-agent-orchestrator/src/__tests__/goal-prompt.test.ts \
  ./plugins/plugin-agent-orchestrator/src/__tests__/skill-manifest.test.ts \
  ./plugins/plugin-agent-orchestrator/src/__tests__/parent-context-routes.test.ts
```

Result: 19 tests passed, 0 failed.

Blocked in this sparse checkout:

```bash
bun run --cwd plugins/plugin-agent-orchestrator typecheck
```

The command fails before completing because this checkout lacks workspace/dependency materialization, including `@elizaos/auth/*`, `coding-agent-adapters`, `git-workspace-service`, `ai`, `file-type`, and `dotenv`. A grep of the typecheck log after fixing the patch-specific issues found no remaining errors for `parent-context-routes`, `parent-agent-broker`, `skill-manifest`, `PARENT_AGENT_BROKER_SLUG`, or `SkillInstructionsResult`.

N/A:

- Screenshots/video: no UI surface changed.
- Live model trajectory: no model/action/provider prompt execution path was exercised; this patch changes sub-agent scaffolding/bridge discovery and deterministic route/service behavior.

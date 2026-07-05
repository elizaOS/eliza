# 13774 subagent context delivery

## Scope

- Default sub-agent capability prompt advertises `USE_SKILL parent-agent`.
- Spawn workspaces get `SKILLS.md` from the shared `AcpService.spawnSession` path, not only economics task spawns.
- Parent-context bridge exposes task goal, acceptance criteria, and recent decisions when a session is task-bound.
- Loopback bridge adds:
  - `GET /api/coding-agents/:sessionId/skills`
  - `GET /api/coding-agents/:sessionId/skills/:slug`

## Verification

Live spawned-agent proof:

```text
bun .codex-tmp-13774/live-13774-proof.ts

{"phase":"spawned","sessionId":"ee378fc4-b201-4a30-b47d-eeb281f1f748","workdir":"/var/folders/n9/khgbz07x3vn8lny5vxd8v1080000gn/T/eliza-13774-live-Jx2hSq/workdir","skillsMdExists":true,"skillsMdHasParentAgent":true}
{"phase":"prompt-result","stopReason":"end_turn","proofExists":true,"proof":"{\"parentAgentMentioned\":true,\"skillsEndpointMentioned\":true,\"summary\":\"SKILLS.md documents parent-agent usage and skill-related local instructions.\"}\n"}
{"phase":"events","events":["ready", "...", "task_complete"]}
```

Manually reviewed live artifacts:

- `.github/issue-evidence/13774-live-spawn-proof/LIVE_13774_PROOF.json`
- `.github/issue-evidence/13774-live-spawn-proof/SKILLS.md`
- `.github/issue-evidence/13774-live-spawn-proof/service.log`

The live run used the machine's real Codex login through native ACP. The spawned agent read the generated `SKILLS.md`, wrote `LIVE_13774_PROOF.json`, and emitted `task_complete`. The copied artifacts exclude Codex auth/cache files.

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
- Real-LLM trajectory: captured by the live Codex ACP proof above.

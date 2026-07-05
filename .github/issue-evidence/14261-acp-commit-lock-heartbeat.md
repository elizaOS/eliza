# #14261 ACP commit-lock live-holder heartbeat

Date: 2026-07-05

## What changed

- Added a detached heartbeat for the ACP shared-worktree commit lock. The wrapper
  blocks inside `spawnSync` while `git commit` and hooks run, so the parent
  process cannot refresh the lock mtime itself during a long critical section.
- Added a regression where session A holds the real commit lock in a pre-commit
  hook beyond a lowered stale threshold while session B waits. Both commits must
  land linearly without stealing the live holder's lock.

## Verification

```bash
bun run --cwd plugins/plugin-agent-orchestrator test -- src/__tests__/acp-git-commit-race.test.ts
```

Result: 1 file / 5 tests passed.

```bash
bun run --cwd plugins/plugin-agent-orchestrator test -- src/__tests__/acp-git-index-isolation.test.ts
```

Result: 1 file / 1 test passed.

```bash
bunx @biomejs/biome@2.5.1 check \
  plugins/plugin-agent-orchestrator/src/services/acp-service.ts \
  plugins/plugin-agent-orchestrator/src/__tests__/acp-git-commit-race.test.ts
```

Result: clean.

```bash
bun run --cwd plugins/plugin-agent-orchestrator build
```

Result: passed.

## Typecheck note

`bun run --cwd plugins/plugin-agent-orchestrator typecheck` was attempted after
generating shared i18n data. It failed before touching the changed ACP files
because this temp worktree resolves many workspace dependencies through
`/home/shaw/milady/eliza/dist/node_modules` without declaration files
(`drizzle-orm`, `yaml`, `fs-extra`, `git-workspace-service`,
`coding-agent-adapters`, and others). No type error cited the changed files.

## Non-applicable evidence

- UI screenshots/video: N/A - deterministic git wrapper behavior; no UI surface.
- Live-LLM trajectories: N/A - no prompt/model/action behavior changed.
- Backend/frontend logs: N/A - the regression drives the real generated git
  wrapper against a real git repository and asserts the resulting git history.

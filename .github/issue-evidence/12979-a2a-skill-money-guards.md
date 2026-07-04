# 12979 - A2A Skill Money Guards

## Change Proven

- `chat_with_agent` fails closed before agent dispatch or room creation.
- `video_generation` / `generate_video` fail closed before credit reservation or generation-row creation.
- Legacy A2A discovery no longer advertises the two disabled paid skills.
- Legacy `message/send` dispatch reaches the same fail-closed guards for `chat_with_agent`, `video_generation`, and `generate_video`.

## Commands Run

```bash
bun install --no-save --ignore-scripts --cache-dir "$HOME/.bun-install-cache-deploy"
node packages/scripts/ensure-workspace-symlinks.mjs
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
bun run --cwd packages/cloud/routing build
bun run build:core
bun test --isolate --coverage-reporter=lcov packages/cloud/shared/src/lib/api/a2a/skills.money-guard.test.ts
bunx @biomejs/biome check packages/cloud/shared/src/lib/api/a2a/skills.ts packages/cloud/shared/src/lib/api/a2a/handlers.ts packages/cloud/shared/src/lib/api/a2a/skills.money-guard.test.ts .github/issue-evidence/12979-a2a-skill-money-guards.md
bun run --cwd packages/cloud/shared typecheck
bun run --cwd packages/cloud/shared lint
git diff --check
```

## Manual Review Notes

- Reviewed `packages/cloud/shared/src/lib/api/a2a/skills.ts`: both exported unsafe skills call `rejectUnwiredPaidSkill(...)` before reading payload fields, reserving credits, creating generation rows, or dispatching to an agent.
- Reviewed `packages/cloud/shared/src/lib/api/a2a/handlers.ts`: legacy discovery omits `chat_with_agent` and `video_generation`; direct legacy dispatch still calls the exported fail-closed guards if callers send those skill ids.
- Reviewed `packages/cloud/shared/src/lib/api/a2a/skills.money-guard.test.ts`: tests use throwing dependency mocks for paid/model/provider paths, prove direct exports fail before context access, cover all three legacy dispatch ids, and assert discovery removal.
- The focused test exited 0 with `4 pass`, `0 fail`, and `13 expect()` calls.

## Evidence N/A

- Real LLM trajectories: N/A - this change disables latent dead-code skill paths and does not invoke a model.
- UI screenshots/video/front-end logs: N/A - no UI or frontend route changed.
- Backend live request logs / cloud stack: N/A - the affected legacy skills are intentionally fail-closed before live paid service dispatch; the regression test proves no paid/model/provider side effects occur.
- DB rows / billing records: N/A - successful behavior is absence of credit reservations, generation rows, and agent dispatch.

# #12269 DB Adapter Error Policy Chunk 1

## Scope

This chunk covers the highest-risk `plugins/plugin-sql/src/base.ts` fallback
sites where adapter failures were previously hidden behind fabricated success
values:

- `deleteAgents` now throws `DB_DELETE_AGENTS_FAILED` instead of returning
  `false`.
- `countAgents` now throws `DB_COUNT_AGENTS_FAILED` instead of returning `0`.
- `createEntities` now throws `DB_CREATE_ENTITIES_FAILED` instead of returning
  `[]`.
- `ensureEntityExists` now propagates a typed `DB_ENSURE_ENTITY_FAILED` error
  instead of returning `false` from its catch path.
- `updateComponent` now uses structured logger output and throws
  `DB_UPDATE_COMPONENT_FAILED` instead of `console.error` plus silent success.

## Real Database Evidence

Command run after rebasing on `origin/develop`:

```bash
bun run --cwd plugins/plugin-sql test -- __tests__/integration/error-policy.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
Duration    22.39s
```

The test uses `createIsolatedTestDatabase`, which runs the real plugin-sql
migrations against a scratch PGlite database by default, or real Postgres when
`POSTGRES_URL` is set. Each case drops the underlying table with DDL and then
calls the public adapter method. The observed backend logs showed the real
Drizzle/PGlite query failures:

```text
[PLUGIN:SQL] Failed to count agents
[PLUGIN:SQL] Failed to delete agents
[PLUGIN:SQL] Failed to create entities
[PLUGIN:SQL] Failed to update component
```

Assertions verified that each public method rejected with `ElizaError`, the
expected machine code, and a preserved `.cause`.

## Verification Commands

Passed:

```bash
git fetch origin && git rebase --autostash origin/develop
bun install
bun run --cwd plugins/plugin-sql test -- __tests__/integration/error-policy.test.ts
bun run --cwd plugins/plugin-sql typecheck
bun run --cwd plugins/plugin-sql lint:check
bunx biome check plugins/plugin-sql/src/base.ts plugins/plugin-sql/src/__tests__/integration/error-policy.test.ts
bun run --cwd plugins/plugin-sql build
```

Root verify was attempted:

```bash
bun run verify
```

It failed with exit code 137 while building unrelated packages after only 6 of
59 Turbo tasks had completed:

```text
Failed: @elizaos/plugin-capacitor-bridge#build, @elizaos/plugin-github#build,
@elizaos/plugin-x#build
```

The first visible failure was `/bin/bash: ... Killed: 9 NODE_OPTIONS='--max-old-space-size=8192' tsup`
inside `@elizaos/plugin-capacitor-bridge#build`. The touched SQL package was
verified separately with build, typecheck, lint, Biome, and the focused real DB
test above.

## Evidence Matrix

- Screenshots: N/A - no UI surface changed.
- Video walkthrough: N/A - no UI flow changed.
- Frontend console/network logs: N/A - no frontend surface changed.
- Real-LLM trajectories: N/A - no prompt, model, action, provider, or agent
  behavior changed.
- Backend logs: included above from the real PGlite failure test path.
- Domain artifacts: the scratch real database schemas are created by
  `createIsolatedTestDatabase`; the tests drop `agents`, `entities`, and
  `components` to prove real adapter failures are surfaced.

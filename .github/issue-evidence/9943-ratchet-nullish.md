# Issue #9943 - nullish ratchet recovery

Date: 2026-07-01

## Change

- Replaced the `listCharacterSecretKeys` empty-object nullish fallback with an
  explicit absent-secrets branch in `packages/core/src/character-utils.ts`.
- Added a regression test for characters without `settings.secrets`.
- Applied existing Biome formatting fixes that blocked root verify after the
  rebase.
- Restored missing public exports used by the app/electrobun surfaces:
  sub-agent credentials from `@elizaos/core` and view chat bindings from
  `@elizaos/ui`.
- Added the missing Turbo dependency edge so `@elizaos/plugin-hyperliquid`
  typechecks after `@elizaos/app-core` declarations are built.
- Updated task coordinator to import the newly public UI state API instead of
  the deep `@elizaos/ui/state/view-chat-binding` path rejected by view bundle
  rewriting.

## Validation

```bash
bun install --frozen-lockfile
```

Passed.

```bash
bun run audit:type-safety-ratchet
```

Passed. The `?? {}` core/agent/app-core count is back at baseline:

- `?? {}`: 377 / 377
- `?? ""`: 614 / 620
- `?? []`: 573 / 588
- `?? 0`: 376 / 380
- `as unknown as`: 75 / 77

```bash
bun run --cwd packages/core test src/character-utils.test.ts
```

Passed: 1 file, 8 tests.

```bash
bun run --cwd packages/core typecheck
```

Passed.

```bash
bun run --cwd packages/core lint:check
```

Passed: 912 files checked.

```bash
bun run --cwd packages/app-core/platforms/electrobun typecheck
```

Passed.

```bash
NODE_OPTIONS='--max-old-space-size=8192' node packages/scripts/run-turbo.mjs run typecheck --concurrency=8 --filter=@elizaos/plugin-hyperliquid
```

Passed: 58 tasks successful.

```bash
bun run --cwd packages/ui lint
```

Passed.

```bash
bun run --cwd packages/ui typecheck
```

Passed.

```bash
bun run --cwd packages/cloud/api lint
```

Passed.

```bash
bun run --cwd packages/cloud/api typecheck
```

Passed.

```bash
bun test packages/cloud/api/v1/coding-containers/route.test.ts
```

Passed: 5 tests.

```bash
bun run --cwd packages/cloud/shared lint
```

Passed.

```bash
bun run --cwd packages/cloud/shared typecheck
```

Passed.

```bash
bun test packages/cloud/shared/src/db/repositories/__tests__/agent-billing-reactivation.test.ts
```

Passed: 2 tests.

```bash
bun run --cwd plugins/plugin-suno lint
```

Passed.

```bash
bun run --cwd plugins/plugin-linear lint
```

Passed.

```bash
bun run --cwd plugins/plugin-task-coordinator build:views
```

Passed.

```bash
NODE_OPTIONS='--max-old-space-size=8192' node packages/scripts/run-turbo.mjs run typecheck --concurrency=8 --filter=@elizaos/plugin-task-coordinator
```

Passed: 15 tasks successful.

```bash
bun run --cwd packages/app audit:app
```

Passed: 349 Playwright checks. Aesthetic summary reported 348 findings with
`broken=0`, `needs-work=0`, `needs-eyeball=212`, `good=136`, and
`minimalism-budget-failures=0`.

```bash
bun run verify
```

Passed. Turbo build/typecheck completed with 474 successful tasks, then the
post-Turbo audits and 28 dist-path consumer typecheck configs completed
successfully.

```bash
git diff --check
```

Passed.

Real-LLM trajectory: N/A. This change is static TypeScript/export/build-ratchet
work and does not alter agent prompts, model routing, or action behavior.

Video walkthrough: N/A. The only app-adjacent change is an export/import path
repair for view bundle resolution; `audit:app` covered the rendered app
surfaces.

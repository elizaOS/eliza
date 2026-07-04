# Issue 13361 - Sierra-Style Synthetic Fixtures

## Scope

Added eliza-owned synthetic benchmark fixtures inspired by Sierra tau-Knowledge
and tau-Voice methodology without committing Sierra source data.

## Validation

- `bunx vitest run packages/lifeops-bench/src/__tests__/sierra-style-fixtures.test.ts --config packages/lifeops-bench/vitest.config.ts`
  - 1 file, 3 tests passed.
- `bunx @biomejs/biome check packages/lifeops-bench/src/sierra-style-fixtures.ts packages/lifeops-bench/src/__tests__/sierra-style-fixtures.test.ts packages/lifeops-bench/src/README.md`
  - clean.
- `bunx tsc --ignoreConfig --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node packages/lifeops-bench/src/sierra-style-fixtures.ts packages/lifeops-bench/src/__tests__/sierra-style-fixtures.test.ts`
  - clean.
- `git diff --check`
  - clean.

## Package Typecheck Note

`bun run --cwd packages/lifeops-bench typecheck` is blocked in this checkout by
pre-existing unresolved workspace/provider imports outside the new fixture
files, including `@elizaos/auth/*`, `@elizaos/vault`, `@elizaos/agent`,
`@elizaos/plugin-groq`, `@elizaos/plugin-openai`, and
`@elizaos/plugin-anthropic`.

## Evidence Boundary

The committed tests prove the fixture contracts, deterministic backend-state
scoring, and required voice report fields. Publishable voice evidence still
requires real provider/model voice runs and manually reviewed artifacts.

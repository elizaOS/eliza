# Repository Guidelines

- Monorepo: `packages/milaidy` within eliza-ok
- Runtime baseline: Node **22+** (keep Node + Bun paths working)

## Project Structure

- **Source code:** `src/` — CLI wiring in `src/cli/`, config in `src/config/`, providers in `src/providers/`, hooks in `src/hooks/`, types in `src/types/`
- **Tests:** colocated `*.test.ts` alongside source files
- **Build output:** `dist/` (via `tsdown`)
- **Entry points:** `src/entry.ts` (CLI), `src/index.ts` (library), `src/eliza.ts` (ElizaOS runtime)
- **Apps:** `apps/app/` (Capacitor mobile/desktop), `apps/ui/` (web UI), `apps/chrome-extension/`
- **Deployment:** `deploy/` (Docker configs)
- **Scripts:** `scripts/` (build, dev, release tooling)
- **Tests:** `test/` (setup, helpers, mocks, e2e scripts)
- **Skills:** `skills/` (cached skill catalog)

## Build, Test, and Development Commands

- Install deps: `pnpm install`
- Type-check/build: `pnpm build` (runs tsdown + UI build)
- Lint/format: `pnpm check`
- Run CLI in dev: `pnpm milaidy ...` or `pnpm dev:cli`
- Tests: `pnpm test` (parallel unit + playwright), `pnpm test:e2e`, `pnpm test:live`
- Coverage: `pnpm test:coverage`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing; avoid `any` and `unknown` unless absolutely necessary.
- Formatting/linting via Biome; run `pnpm check` before commits.
- Add brief code comments for tricky or non-obvious logic.
- Aim to keep files under ~500 LOC; split/refactor when it improves clarity or testability.
- Naming: use **Milaidy** for product/app/docs headings; use `milaidy` for CLI command, package/binary, paths, and config keys.

## Dependencies

- Direct imports in `src/`: `@elizaos/core`, `@clack/prompts`, `chalk`, `commander`, `dotenv`, `json5`, `zod`
- Workspace plugins (`@elizaos/plugin-*`): loaded at runtime, each with their own `package.json`
- Do not add dependencies unless `src/` code directly imports them

## Testing Guidelines

- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements)
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`; live in `*.live.test.ts`
- Run `pnpm test` before pushing when you touch logic

## Commit & Pull Request Guidelines

- Follow concise, action-oriented commit messages (e.g., `milaidy: add verbose flag to send`)
- Group related changes; avoid bundling unrelated refactors
- PRs should summarize scope, note testing performed, and mention any user-facing changes

## Security & Configuration

- Never commit real secrets, phone numbers, or live configuration values
- Use obviously fake placeholders in docs, tests, and examples
- Configuration lives at `~/.milaidy/milaidy.json`; workspace at `~/.milaidy/workspace/`

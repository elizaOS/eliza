# Repository Guidelines

## Project Structure & Module Organization

- Monorepo managed by `turbo` and `lerna`; scripts run with `bun`.
- Source lives under `packages/*`:
  - `core` (runtime, shared types), `server` (Express API), `client` (React UI), `cli` (elizaos CLI).
  - Plugins and starters: `plugin-*`, `project-*`.
- Other roots: `examples/` (standalone samples), `scripts/` (automation), `plugin-specification/*` (specs).

## Build, Test, and Development Commands

- Install: `bun install` (use Bun only).
- Build all: `bun run build` (filters exclude app/config). Examples: `bun run build:core`, `bun run build:client`.
- Dev/watch: `bun run dev` (monorepo), package-local: `cd packages/core && bun run dev`.
- Start CLI locally: `bun run start` or `bun run start:app` for the app.
- Tests (top level): `bun run test`, or per package:
  - Core: `bun run test:core`
  - Server: `cd packages/server && bun run test`
  - Client unit: `cd packages/client && bun run test:unit`
  - Client e2e: `cd packages/client && bun run test:e2e` (or `test:e2e:with-server`).

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer Bun APIs; avoid Node-only modules where Bun equivalents exist.
- Formatting: Prettier (2 spaces, semicolons, single quotes, trailing comma es5, width 100). Run `bun run format` or `format:check`.
- Linting: `bun run lint` (Prettier; ESLint used in `client`).
- Naming: camelCase (vars/functions), PascalCase (types/components), kebab-case for package folders.

## Testing Guidelines

- Unit tests with Bun test runner; name files `*.test.ts(x)` near sources.
- Use `--coverage` when changing core/server: `bun run test:core` or `cd packages/server && bun run test:coverage`.
- Client: component/unit via Bun/Testing Library; e2e via Cypress (`bun run cypress:open`).

## Commit & Pull Request Guidelines

- Conventional Commits: `feat:`, `fix:`, `chore:`, optional scope (e.g., `fix(server): ...`). Use `[skip ci]` for docs-only.
- PRs must include: clear description, linked issues, test plan, screenshots for UI changes, and pass build/lint/tests.
- Update docs/examples when behavior changes. Keep changes scoped to one concern.

## Security & Config

- Copy `.env.example` to `.env`; never commit secrets. Required: Node `23.x`, Bun `1.2.x`.
- Post-install initializes submodules; if needed, rerun `bash ./scripts/init-submodules.sh`.

# Repository Guidelines

## Project Structure & Module Organization

- Monorepo managed by Bun, Turbo, and Lerna. Workspaces in `packages/*`.
- Key packages: `core` (runtime/types), `cli` (elizaos CLI), `client` (web UI), `server` (API), `app` (desktop), plugins under `plugin-*`.
- Tests live alongside source (e.g., `src/**/*.test.ts`) and UI component tests in `packages/client/src/components/**/*.cy.tsx`.
- Useful paths: `scripts/` (dev/build helpers), `.husky/` (git hooks), `.eliza/` (local data), `test-data/` (fixtures).

## Build, Test, and Development Commands

- Install: `bun install`
- Build all: `bun run build` (Turbo orchestrates package builds)
- Start (CLI runtime): `bun start` or `bun run start:app` (desktop UI)
- Dev watch: `bun run dev`
- Test (monorepo): `bun test`; package-only: `cd packages/core && bun test`
- Lint/format: `bun run lint` (includes Prettier), quick format: `bun run format`
- Clean: `bun run clean` (removes artifacts and rebuilds)

## Coding Style & Naming Conventions

- Language: TypeScript. Avoid `any/unknown`; prefer precise types.
- Prettier: 2 spaces, single quotes, semicolons, width 100 (`.prettierrc`).
- Naming: variables/functions `camelCase`, types/components `PascalCase`, files match main export (e.g., `AgentStore.ts`).
- Keep modules focused; follow existing package patterns.

## Testing Guidelines

- Framework: `bun test` with coverage enabled (`bunfig.toml`).
- Place unit tests next to code: `*.test.ts` or `*.spec.ts`.
- Client UI uses Cypress component tests: `*.cy.tsx` in `packages/client`.
- Aim to maintain/improve coverage; include a brief test plan in PRs.

## Commit & Pull Request Guidelines

- Commits: concise, imperative subject; prefer Conventional Commits (`feat:`, `fix:`, `chore:`) with optional scope (e.g., `core:`).
- PRs: clear description, linked issues (`Closes #123`), screenshots for UI, and “Test Plan” with commands and results. Keep changes scoped to one concern.
- CI must be green: run `bun run build`, `bun test`, and `bun run lint` locally before opening a PR.

## Security & Configuration

- Secrets: use `.env` (see `.env.example`); never commit real keys.
- Minimum toolchain: Node `v23.3.0` (`.nvmrc`), Bun `^1.2.x`.
- Prefer `elizaos` CLI for local workflows; Docker scripts available in `scripts/docker.sh`.


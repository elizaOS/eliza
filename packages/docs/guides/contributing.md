---
title: Contributing Guide
description: How to set up a development environment, follow code conventions, and submit pull requests to the Eliza project.
---

# Contributing Guide

Welcome to Eliza! This guide covers development environment setup and contribution workflow.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Development Environment](#development-environment)
3. [Project Structure](#project-structure)
4. [Building and Testing](#building-and-testing)
5. [Code Style](#code-style)
6. [Pull Request Process](#pull-request-process)
7. [Community](#community)

---

## Getting Started

### Prerequisites

- **Node.js 22 LTS** — Required runtime (`.nvmrc` is pinned)
- **Bun** — Package manager/runtime used by repo scripts
- **Git** — Version control

### Quick Setup

```bash
# Clone the repository
git clone https://github.com/eliza-ai/eliza.git
cd eliza

# Match repository Node version
nvm use || nvm install
node -v  # expected: v22.22.0

# Install dependencies
bun install

# Build the project
bun run build

# Run in development mode
bun run dev
```

---

## Development Environment

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 22.x LTS | Runtime |
| Bun | Latest | Package management + script runner |
| Git | Latest | Version control |

### Optional Tools

| Tool | Purpose |
|------|---------|
| pnpm | Optional package manager for non-repo workflows |
| Docker | Container testing |
| VS Code | Recommended editor |

### Editor Setup

**VS Code Extensions:**
- Biome (handles both formatting and linting)
- TypeScript

**Settings (.vscode/settings.json):**
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome"
}
```

---

## Monorepo Structure

Eliza is a monorepo managed with Bun workspaces. The core elizaOS runtime lives in the `eliza/` git submodule.

```
eliza/
├── eliza/                       # elizaOS submodule (core runtime)
│   ├── packages/
│   │   ├── app-core/            # Main application package (CLI, API, runtime, config)
│   │   ├── agent/               # Upstream elizaOS agent (core plugins, auto-enable maps)
│   │   └── ...                  # Other @elizaos/* packages
│   └── plugins/                 # Official plugins (submodule checkouts)
│       ├── plugin-agent-orchestrator/
│       └── ...
├── apps/
│   ├── app/                 # Desktop/mobile app (Capacitor + React)
│   │   ├── electrobun/      # Electrobun desktop wrapper
│   │   └── src/             # React UI components
│   ├── browser-bridge/      # Browser extension bridge
│   └── homepage/            # Marketing site
├── eliza/                   # elizaOS submodule (core framework)
│   └── packages/
│       └── app-core/        # Main application package (runtime source of truth)
├── skills/                  # Workspace skills and defaults
├── docs/                    # Documentation (this site)
├── scripts/                 # Build and utility scripts
├── test/                    # Test setup, helpers, e2e
├── AGENTS.md                # Repository guidelines
└── tsdown.config.ts         # Build config
```

### Build System

Builds are run via Bun scripts defined in the root `package.json`:

```bash
# Full build (TypeScript + UI)
bun run build

# Typecheck + lint + tests (the main verification suite)
bun run verify

# Run tests only
bun run test
```

### Key Entry Points

| File | Purpose |
|------|---------|
| `eliza.mjs` | npm bin entry |
| `eliza/packages/app-core/src/entry.ts` | CLI process bootstrap |
| `eliza/packages/app-core/src/cli/` | Commander CLI (eliza command) |
| `eliza/packages/app-core/src/runtime/eliza.ts` | Agent loader and runtime boot |
| `eliza/packages/app-core/src/api/` | Dashboard API |
| `eliza/packages/app-core/src/config/` | Plugin auto-enable, config schemas |

---

## Building and Testing

### Build Commands

```bash
# Full build (TypeScript + UI)
bun run build

# Desktop app (Electrobun)
bun run build:desktop

# Mobile (Android)
bun run build:android

# Mobile (iOS)
bun run build:ios
```

### Development Mode

```bash
# Start API + UI with hot reload
bun run dev

# Desktop app development (Electrobun)
bun run dev:desktop

# Desktop with HMR via Vite dev server
bun run dev:desktop:watch
```

### Testing

Coverage thresholds are enforced from `eliza/packages/app-core/scripts/coverage-policy.mjs`: 25% lines/functions/statements, 15% branches. CI fails when coverage falls below these floors.

```bash
# Run all tests (parallel)
bun run test

# Run with coverage
bun run test:coverage

# Watch mode
bun run test:watch

# End-to-end tests
bun run test:e2e

# Live tests (requires API keys)
ELIZA_LIVE_TEST=1 bun run test:live

# Docker-based runtime review
bun run test:docker:review
```

### Runtime fallback for Bun crashes

If Bun segfaults on your platform during long-running sessions, run Eliza on Node runtime:

```bash
ELIZA_RUNTIME=node bun run eliza start
```

### Test File Conventions

| Pattern | Purpose |
|---------|---------|
| `*.test.ts` | Unit tests (colocated with source) |
| `*.e2e.test.ts` | End-to-end tests |
| `*.live.test.ts` | Live API tests |
| `test/**/*.test.ts` | Integration tests |

### `eliza/packages/app-core` in the root Vitest config

The repo root **`vitest.config.ts`** (used by **`bun run test`** via the unit shard) includes:

- **`eliza/packages/app-core/src/**/*.test.ts`** and **`eliza/packages/app-core/src/**/*.test.tsx`** — colocated tests, including TSX, without listing each file.
- **`eliza/packages/app-core/test/live-agent/**/*.test.ts`** — live-agent harness tests.

**Why:** those directories were previously omitted, so new suites never ran in CI. **`*.e2e.test.ts(x)`** is excluded from this job so e2e stays on **`test/vitest/e2e.config.ts`**. **`test/vitest/unit.config.ts`** still omits **`eliza/packages/app-core/test/app/**`** (heavy renderer harness) from the coverage-focused unit pass—**why:** those are run in targeted app workspaces or separate jobs.

---

## Code Style

### TypeScript Guidelines

- **Strict mode** — Always use strict TypeScript
- **Avoid `any`** — Use proper types or `unknown`
- **ESM** — Use ES modules (`import`/`export`)
- **Async/await** — Prefer over raw promises

### Naming Conventions

| Item | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `my-feature.ts` |
| Classes | PascalCase | `MyService` |
| Functions | camelCase | `processMessage` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |
| Actions | UPPER_SNAKE | `RESTART_AGENT` |
| Types/Interfaces | PascalCase | `PluginConfig` |

### Product vs Code Naming

- **Eliza** — Product name, headings, docs
- **eliza** — CLI command, package name, paths, config keys

### Formatting

The project uses **Biome** for formatting and linting:

```bash
# Typecheck + lint + tests (alias for `bun run verify`)
bun run check

# Fix formatting issues
bun run format:fix

# Fix lint issues
bun run lint:fix
```

### File Size

Aim to keep files under **~500 lines**. Split when it improves:
- Clarity
- Testability
- Reusability

### Comments

```typescript
// ✅ Explain WHY, not WHAT
// Rate limit to avoid API throttling during batch operations
const BATCH_DELAY_MS = 100;

// ❌ Don't explain obvious code
// Increment counter by 1
counter++;
```

### Error Handling

```typescript
// ✅ Specific error types with context
throw new Error(`Failed to load plugin "${name}": ${err.message}`);

// ✅ Graceful degradation
try {
  await riskyOperation();
} catch (err) {
  runtime.logger?.warn({ err, context }, "Operation failed, using fallback");
  return fallbackValue;
}

// ❌ Silent swallowing
try {
  await something();
} catch {}
```

---

## Pull Request Process

### Branch Strategy

| Branch | Purpose | Publishes to |
|--------|---------|-------------|
| `develop` | Active development, PRs merge here | Alpha releases |
| `main` | Stable releases | Beta releases |
| GitHub Releases | Tagged versions | Production (npm, PyPI, Snap, APT, Homebrew) |
| `feature/*` | New features | — |
| `fix/*` | Bug fixes | — |

### Creating a PR

1. **Fork and clone** (or branch from develop)
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```

2. **Make changes** with meaningful commits
   ```bash
   git add .
   git commit -m "feat: add new action for X"
   ```

3. **Run checks before pushing**
   ```bash
   bun run check
   bun run test
   ```

4. **Push and create PR**
   ```bash
   git push origin feature/my-feature
   # Then open PR on GitHub
   ```

### Commit Message Format

Use conventional commits:

```
<type>: <description>

[optional body]

[optional footer]
```

**Types:**
- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `refactor:` — Code refactoring
- `test:` — Test additions/changes
- `chore:` — Build, deps, configs

**Examples:**
```
feat: add voice message support to telegram connector

fix: prevent crash when config file is missing

docs: add plugin development guide

refactor: extract session key logic to provider

chore: update @elizaos/core to 2.0.0-alpha.4
```

### PR Checklist

Before submitting:

- [ ] Code builds without errors (`bun run build`)
- [ ] Tests pass (`bun run test`)
- [ ] Linting passes (`bun run check`)
- [ ] New code has tests (if applicable)
- [ ] Documentation updated (if applicable)
- [ ] Commit messages follow conventions
- [ ] PR description explains the change

### Code Review

PRs are reviewed by maintainers. Expect feedback on:

- **Correctness** — Does it work?
- **Design** — Is the approach sound?
- **Style** — Does it follow conventions?
- **Tests** — Is it adequately tested?
- **Docs** — Is it documented?

Claude Code Review is enabled for automated initial feedback.

---

## Community

### Discord

Join the community Discord for help, discussions, and announcements:

**[discord.gg/eliza](https://discord.gg/eliza)**

Channels:
- `#dev` — Development help
- `#showcase` — Share what you've built

### GitHub

- **Issues** — Bug reports, feature requests
- **Discussions** — Questions, ideas, RFC
- **PRs** — Code contributions

### Reporting Issues

When filing an issue:

1. **Check existing issues** — Avoid duplicates
2. **Use templates** — Fill out the provided template
3. **Include reproduction** — Steps to reproduce
4. **Share logs** — Relevant error output
5. **Environment** — OS, Node version, Eliza version

```markdown
## Bug Report

**Describe the bug:**
Brief description

**To reproduce:**
1. Run `eliza start`
2. Send message "..."
3. Error occurs

**Expected behavior:**
What should happen

**Environment:**
- OS: macOS 14.2
- Node: 22.12.0
- Eliza: 2.0.0-alpha.8

**Logs:**
```
[error output here]
```
```

---

## Getting Help

- **Discord** — Fastest response for questions
- **GitHub Issues** — Bug reports and features
- **Documentation** — Check `/docs` first
- **AGENTS.md** — Repository-specific guidelines

---

## Next Steps

- [Plugin Development Guide](/plugins/development) — Build plugins
- [Skills Documentation](/plugins/skills) — Create skills
- [Local Plugin Development](/plugins/local-plugins) — Develop locally
- [First Extension Walkthrough](/guides/first-extension-walkthrough) — Build your first extension

---
title: "Contributing Guide"
sidebarTitle: "Contributing"
description: "Set up your development environment and contribute to Milady."
redirect: /guides/contributing
---

Welcome to the Milady project. This guide covers environment setup, development workflow, and the pull request process.

Before contributing, read [CONTRIBUTING.md](https://github.com/milady-ai/milady/blob/develop/CONTRIBUTING.md) in the repo root for the project's contribution philosophy. Milady is an **agents-only codebase** -- every PR is reviewed and merged by AI agents, not human maintainers. Humans contribute primarily as QA testers and bug reporters.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | >= 22 | Runtime (required by `engines` field) |
| [Bun](https://bun.sh/) | Latest | Package manager and script runner |
| [Git](https://git-scm.com/) | Latest | Version control |

Bun is the project's package manager. All commands in this guide use `bun`.

---

## Setup

```bash
# Clone the repository
git clone https://github.com/milady-ai/milady.git
cd milady

# Install dependencies (initializes submodules + runs bun install)
./install        # Unix / macOS
# install.cmd    # Windows

# Build the project (TypeScript via tsdown + UI build)
bun run build
```

<Info>
Use `./install` (or `install.cmd` on Windows) on a fresh clone. Plain `bun install` works for subsequent updates once the submodules are on disk.
</Info>

After building, verify the CLI works:

```bash
bun run milady --help
```

Configuration is stored at `~/.milady/milady.json` and the workspace lives at `~/.milady/workspace/`.

---

## Development Workflow

### Running in Development

```bash
# Start dev server with auto-reload
bun run dev

# Run UI development only
bun run dev:ui

# Desktop app (Electrobun) development
bun run dev:desktop

# Run the CLI directly
bun run milady start
```

### Testing

The project uses **Vitest 4.x** with V8 coverage. Coverage thresholds are set in `eliza/packages/app-core/scripts/coverage-policy.mjs` at **25%** for lines, functions, and statements, and **15%** for branches.

```bash
# Run all tests (parallel runner)
bun run test

# Watch mode
bun run test:watch

# Run with coverage report
bun run test:coverage

# Run database safety/migration compatibility checks
bun run db:check

# End-to-end tests
bun run test:e2e

# Live API smoke tests (requires API keys)
MILADY_LIVE_TEST=1 bun run test:live:smoke

# Docker-based runtime review
bun run test:docker:review
```

**Test file conventions:**

| Pattern | Location | Purpose |
|---------|----------|---------|
| `*.test.ts` | Colocated with source | Unit tests |
| `*.e2e.test.ts` | `test/` directory | End-to-end tests |
| `*.live.test.ts` | `test/` directory | Live API tests (require real keys) |
| `*.real.test.ts` | Colocated or `test/` | Tests against real services |
| `*.integration.test.ts` | `test/` directory | Integration tests |

### Linting and Formatting

The project uses **Biome 2.x** for both linting and formatting. There is no ESLint or Prettier -- Biome handles everything.

```bash
# Run typecheck + lint + tests (the main pre-push check)
bun run check

# Auto-fix formatting issues
bun run format:fix

# Auto-fix lint issues
bun run lint:fix
```

Key Biome rules configured in `biome.json`:

- `noExplicitAny`: **error** -- avoid `any` types
- `noNonNullAssertion`: warn
- `noImplicitAnyLet`: warn
- Formatter: 2-space indent, spaces (not tabs)
- Import organization is enabled

### Build Commands

```bash
# Full build (TypeScript + UI)
bun run build

# Build using Node.js (instead of Bun runtime)
bun run build

# Desktop app (Electrobun)
bun run build:desktop

# Mobile builds
bun run build:android
bun run build:ios
```

---

## Pull Request Process

### Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Stable releases (published to npm) |
| `develop` | Integration branch (default PR target) |
| `feature/*` | New features |
| `fix/*` | Bug fixes |

Always branch from `develop` and target PRs back to `develop`.

### Step-by-Step

1. **Create a branch from develop**
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```

2. **Make changes** with concise, action-oriented commits
   ```bash
   git commit -m "milady: add verbose flag to send action"
   ```

3. **Run checks before pushing**
   ```bash
   bun run check
   bun run test
   bun run build
   ```

4. **Push and open a PR**
   ```bash
   git push origin feature/my-feature
   ```
   Open the PR against `develop` on GitHub.

### Commit Conventions

The project uses concise, action-oriented commit messages. Conventional commit prefixes are common:

```
feat: add voice message support to telegram connector
fix: prevent crash when config file is missing
test: add regression test for session timeout
refactor: extract session key logic to provider
chore: update @elizaos/core to latest
```

Other accepted styles follow the `milady: description` pattern seen in the repo history (e.g., `milady: fix telegram reconnect on rate limit`).

### The Agent Review Bot

Every PR triggers the **Agent Review** GitHub Actions workflow. Here is how it works:

1. **Classification** -- The workflow automatically classifies your PR as `bugfix`, `feature`, or `aesthetic` based on the title and body.

2. **Claude Code Review** -- An AI agent (Claude Opus) performs a full code review. It evaluates:
   - **Scope** -- Is the change in scope for the project?
   - **Code quality** -- TypeScript strict mode, Biome compliance, file size
   - **Security** -- Prompt injection, credential exposure, supply chain risks
   - **Tests** -- Bug fixes must include regression tests; features must include unit tests

3. **Decision** -- The agent issues one of three verdicts:
   - **APPROVE** -- PR passes review and is auto-merged (squash merge) into `develop`
   - **REQUEST CHANGES** -- Issues found; fix and push again to re-trigger review
   - **CLOSE** -- PR is out of scope and will be closed automatically

4. **Trust scoring** -- Contributors build a trust score over time. Higher trust means expedited reviews; new contributors receive deeper scrutiny.

There is **no human escalation path**. The agent's decision is final. If you disagree, improve the PR and resubmit.

**What gets rejected immediately:**
- Aesthetic/UI redesigns, theme changes, icon swaps, font changes
- "Beautification" PRs that do not improve agent capability
- Untested code for testable changes
- Scope creep disguised as improvements

### PR Checklist

Before submitting, verify:

- [ ] `bun run build` completes without errors
- [ ] `bun run test` passes
- [ ] `bun run check` passes (typecheck + lint)
- [ ] Bug fixes include a regression test
- [ ] New features include unit tests
- [ ] No secrets, real credentials, or live config values in code
- [ ] Commit messages are concise and descriptive
- [ ] PR description summarizes the change and notes testing performed

---

## Code Style

### TypeScript

- **Strict mode** -- Always use strict TypeScript
- **No `any`** -- Biome enforces `noExplicitAny` as an error. Use proper types or `unknown`.
- **ESM** -- Use ES module syntax (`import`/`export`)
- **Async/await** -- Prefer over raw promise chains

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

- **Milady** -- Product name, headings, documentation prose
- **milady** -- CLI binary name, package paths, config keys

### File Size

Keep files under **~500 lines**. Split when it improves clarity, testability, or reusability.

### Comments

```typescript
// Explain WHY, not WHAT
// Rate limit to avoid API throttling during batch operations
const BATCH_DELAY_MS = 100;
```

### Error Handling

```typescript
// Specific error messages with context
throw new Error("Failed to load plugin: " + err.message);

// Graceful degradation over silent swallowing
try {
  await riskyOperation();
} catch (err) {
  runtime.logger?.warn(err, "Operation failed, using fallback");
  return fallbackValue;
}
```

### Editor Setup

Recommended VS Code settings:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome"
}
```

Install the [Biome VS Code extension](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) for in-editor formatting and lint feedback.

---

## Project Structure

```
milady/
├── apps/
│   ├── app/                 # Desktop/mobile app (Capacitor + React)
│   │   ├── electrobun/      # Electrobun desktop wrapper
│   │   └── src/             # React UI components
├── deploy/                  # Docker deployment configs
├── docs/                    # Documentation site
├── packages/                # Workspace packages
├── plugins/                 # Workspace plugin packages
├── scripts/                 # Build, dev, and release tooling
├── skills/                  # Skill catalog cache
├── src/                     # Core source code
│   ├── actions/             # Agent actions
│   ├── api/                 # HTTP API routes
│   ├── cli/                 # CLI command definitions
│   ├── config/              # Configuration handling
│   ├── hooks/               # Runtime hooks
│   ├── plugins/             # Built-in plugins
│   ├── providers/           # Context providers
│   ├── runtime/             # elizaOS runtime wrapper
│   ├── security/            # Security utilities
│   ├── services/            # Background services
│   ├── triggers/            # Trigger system
│   ├── tui/                 # Terminal UI (disabled)
│   └── utils/               # Helper utilities
├── test/                    # Test setup, helpers, e2e scripts
├── AGENTS.md                # Repository guidelines for agents
├── CONTRIBUTING.md          # Contribution philosophy
├── package.json             # Root package config
├── plugins.json             # Plugin registry manifest
├── biome.json               # Biome linter/formatter config
├── tsconfig.json            # TypeScript config
├── tsdown.config.ts         # Build config (tsdown bundler)
├── vitest.config.ts         # Vitest test config
└── milady.mjs               # npm bin entry point
```

### Key Entry Points

| File | Purpose |
|------|---------|
| `src/entry.ts` | CLI entry point |
| `src/index.ts` | Library exports |
| `src/runtime/eliza.ts` | elizaOS runtime initialization |
| `src/runtime/milady-plugin.ts` | Main Milady plugin |
| `milady.mjs` | npm bin entry (`"bin"` in package.json) |

---

## Reporting Issues

When filing a bug report:

1. **Check existing issues** to avoid duplicates
2. **Include reproduction steps** -- what you did, what happened, what you expected
3. **Share your environment** -- OS, Node version, Milady version (`milady --version`)
4. **Attach logs** -- relevant error output

An AI agent triages all incoming issues. Valid bugs are labeled and prioritized. Issues that are out of scope (aesthetic requests, feature creep) will be closed with an explanation.

---

## Further Reading

- [CONTRIBUTING.md](https://github.com/milady-ai/milady/blob/develop/CONTRIBUTING.md) -- Full contribution philosophy
- [AGENTS.md](https://github.com/milady-ai/milady/blob/develop/AGENTS.md) -- Repository guidelines for coding agents
- [Plugin Development Guide](/plugins/development) -- Build plugins
- [Skills Documentation](/plugins/skills) -- Create skills
- [Local Plugin Development](/plugins/local-plugins) -- Develop plugins locally

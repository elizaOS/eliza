---
title: Beginner Development Guide
sidebarTitle: Beginner Dev Guide
summary: End-to-end contributor onboarding for setting up, understanding, and safely extending the Eliza codebase.
description: A complete onboarding guide for new contributors to understand Eliza architecture, local setup, workflow, testing, and safe first contributions.
---

This guide is for developers new to this repository who want to make safe, reviewable contributions quickly.

---

## 1) What this repo is optimizing for

Eliza is a local-first AI assistant built on elizaOS.

The repository prioritizes:

1. Reliability
2. Security
3. Test coverage
4. Runtime compatibility (Node + Bun)

For newcomers, that means:

- Prefer small, scoped changes
- Preserve existing runtime guardrails
- Validate changes with tests/checks

---

## 2) Read this before writing code

Required orientation reading:

1. `README.md` — product and usage framing
2. `CONTRIBUTING.md` — scope and quality bar
3. `AGENTS.md` — repository-specific constraints
4. `docs/agents/runtime-and-lifecycle.md` — startup/initialization truth source

This reading saves you from most early review failures.

---

## 3) Local prerequisites

- Node.js `>=22`
- Bun
- Git

Install dependencies:

```bash
bun install
```

Initialize the elizaOS submodule and link local packages (required for reading/editing runtime source):

```bash
bun run setup:upstreams
```

Recommended quick sanity checks:

```bash
node -v
bun -v
bun run eliza --version
```

---

## 4) Repo map (mental model)

The runtime source lives in the `eliza/` git submodule. Initialize it first:

```bash
bun run setup:upstreams
```

Core areas (all under `eliza/packages/app-core/`):

- `eliza/packages/app-core/src/runtime/` — runtime startup, plugin orchestration, lifecycle
- `eliza/packages/app-core/src/cli/` — CLI parsing, command registration, process behavior
- `eliza/packages/app-core/src/config/` — config types, loading, resolution
- `eliza/packages/app-core/src/api/` — dashboard API server and routes
- `eliza/packages/app-core/src/services/` — business logic (plugin installer, updater, etc.)
- `eliza/packages/app-core/src/connectors/` — connector integration code
- `eliza/packages/agent/` — upstream elizaOS agent submodule (core plugins, auto-enable maps)
- `apps/app/` — desktop/mobile UI app
- `scripts/` — build/dev/release tooling
- `test/` + colocated tests — verification

> **Note:** The `eliza/` directory is a git submodule — these paths will not exist until you run `bun run setup:upstreams` or `git submodule update --init --recursive`. See [CONTRIBUTING.md](https://github.com/eliza-ai/eliza/blob/main/CONTRIBUTING.md) for submodule maintenance details.

---

## 5) Entry points and startup path

Important files to understand first (all inside the `eliza/` submodule):

1. `eliza/packages/app-core/src/entry.ts` (CLI process bootstrap)
2. `eliza/packages/app-core/src/cli/run-main.ts` (dotenv + Commander + error handling)
3. `eliza/packages/app-core/src/cli/program/*` (command registration)
4. `eliza/packages/app-core/src/runtime/eliza.ts` (runtime boot sequence + plugin resolution)
5. `eliza/packages/app-core/src/index.ts` (package exports)

### Suggested reading order (first 60–90 min)

1. Read `eliza/packages/app-core/src/entry.ts` top-to-bottom
2. Trace into `run-main.ts`
3. Open one command registration file (`register.start.ts`, etc.)
4. Read runtime lifecycle doc and compare to `eliza.ts`

---

## 6) Daily commands for development

```bash
bun run dev           # API on :31337, UI on :2138 (dev mode splits them)
bun run build
bun run check
bun run test
bun run test:e2e
bun run test:coverage
```

In dev mode, the API runs on port 31337 and the dashboard UI on port 2138. In production, both share port 2138. The dev orchestrator auto-shifts to the next free port if defaults are busy and syncs the env vars (`ELIZA_API_PORT`, `ELIZA_PORT`).

CLI iteration examples:

```bash
bun run eliza --help
bun run eliza start --verbose
bun run eliza config get agents.defaults.model
```

When you touch logic, at minimum run:

- `bun run check`
- `bun run test`

---

## 7) Test strategy for beginners

### Test naming conventions

- Unit: `*.test.ts` (colocated)
- End-to-end: `*.e2e.test.ts`
- Live/integration-style: `*.live.test.ts`

### Practical rule

If behavior changed, tests should reflect that behavior.

### Good first testing pattern

1. Reproduce bug in a test
2. Confirm test fails
3. Implement fix
4. Confirm test passes

---

## 8) Safe first-task ideas

Great first PR candidates:

- Fix small CLI edge-case with regression test
- Tighten error messaging
- Improve docs accuracy and command examples
- Add missing tests in under-covered files

Avoid early on:

- New plugins/integrations
- Multi-subsystem refactors
- Behavior changes without tests

---

## 9) Critical guardrails (do not casually remove)

Known-sensitive areas in this repo:

- Desktop startup error guards in the desktop agent startup path
- `NODE_PATH` setup supporting dynamic plugin imports
- Bun exports patching logic in dependency patch script

If your change touches these, include explicit reasoning + verification.

---

## 10) Node and Bun compatibility checklist

When touching startup, scripts, or import behavior, verify:

- Node path works (`node --import ...`/CLI entry path)
- Bun path works (`bun run ...` paths)
- No hardcoded assumptions about environment

If you cannot run both paths fully, explain what you validated and why.

---

## 11) A practical contribution workflow

1. Pick one narrow objective
2. Create branch
3. Reproduce issue or define target behavior
4. Add/update tests first where possible
5. Implement minimal change
6. Run checks/tests
7. Self-review diff for scope creep
8. Commit with concise action-oriented message
9. Open PR with clear summary + test evidence

---

## 12) PR quality checklist (before opening)

- [ ] Scope is in-bounds and focused
- [ ] No unrelated refactors included
- [ ] Tests updated for behavior changes
- [ ] Lint/type checks are clean
- [ ] Docs updated when user-facing behavior changed
- [ ] No real secrets in examples/logs/config snippets

---

## 13) Common beginner mistakes

- **Huge PRs** → split into smaller, reviewable units
- **No tests for logic changes** → add regression coverage
- **Overusing new dependencies** → avoid unless required by source code
- **Ignoring platform/runtime assumptions** → test Node/Bun paths
- **Editing generated artifacts** → edit source, regenerate output

---

## 14) Debugging habits that save time

- Run a single focused command before full suite
- Capture exact failing command output in PR notes
- Use logs under `~/.eliza/logs/` for runtime investigation
- Prefer minimal reproducible cases

---

## 15) Suggested deep-dive path after first PR (beginner → advanced)

Treat this as a curriculum. Finish each layer before moving deeper.

### Layer 1 — Core contributor fluency

1. **Runtime lifecycle and startup**
   - `/agents/runtime-and-lifecycle`
   - `/runtime/core`
2. **CLI command model**
   - `/cli/overview`
   - `/cli/start`
   - `/cli/config`
3. **Configuration system**
   - `/configuration`
   - `/config-schema`

### Layer 2 — Feature implementation fluency

1. **Plugins and extension model**
   - `/plugins/architecture`
   - `/plugins/development`
   - `/plugins/schemas`
   - `/plugins/publish`
2. **Skills and actions**
   - `/plugins/skills`
   - `/guides/custom-actions`
3. **Triggers and automation**
   - `/guides/triggers`
   - `/guides/hooks`

### Layer 3 — Product surface fluency

1. **Dashboard feature surface**
   - `/apps/dashboard`
   - `/dashboard/chat`
   - `/dashboard/stream`
2. **Platform-specific app behavior**
   - `/apps/desktop`
   - `/apps/mobile`
   - Browser Relay release-status documentation when browser automation work is in scope

### Layer 4 — Systems and operations fluency

1. **Runtime services and providers**
   - `/runtime/services`
   - `/runtime/providers`
   - `/runtime/events`
2. **Security and sandboxing**
   - `/guides/sandbox`
3. **Data and diagnostics**
   - `/advanced/database`
   - `/advanced/logs`

### Layer 5 — Advanced architecture

Use these when designing non-trivial changes:

- `/architecture` — system shape and major subsystems
- `/agents/runtime-and-lifecycle` — startup, restarts, and lifecycle
- `/plugins/architecture` — plugin load order, providers, and extension points

Read only the sections relevant to your current change.

### Advanced contributor tracks (pick one)

- **Runtime track:** runtime lifecycle + services + providers + memory docs
- **Plugin track:** plugin architecture + local plugins + registry + schemas
- **Platform track:** desktop/mobile docs + release/build docs, plus the Browser Relay status page when relevant
- **API track:** REST docs + contracts + integration/e2e tests

### What “advanced-ready” looks like

You are advanced-ready when you can:

- Trace a user action from CLI/UI to runtime service and back
- Predict side effects of plugin load/order changes
- Add tests that catch regressions in your subsystem
- Explain security implications of your change before review asks

## 16) Definition of “review-ready” for this repo

A contribution is beginner-good and review-ready when it is:

- Small enough to reason about quickly
- Clearly justified
- Backed by tests/checks
- Compatible with existing runtime constraints
- Documented where behavior changed

When unsure, optimize for **clarity, safety, and testability** over cleverness.

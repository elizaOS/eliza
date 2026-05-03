# Steward Repo Cleanup & Contributor Readiness Plan

**Date:** 2026-04-10
**Goal:** Make steward a professional open-source project that contributors can understand, build, test, and submit PRs to. No gaps.

---

## Current Problems

1. **CI is broken** — all recent runs fail on Typecheck (test files import `bun:test` which breaks tsc)
2. **No branch protection** — anyone with access can push directly to develop
3. **No CONTRIBUTING.md** — contributors guess at process
4. **No PR/issue templates** — inconsistent submissions
5. **52 stale local branches** — clutter
6. **7 stale planning docs** at repo root — PLAN.md, SPRINT-PLAN.md, WORKER-PLAN.md, etc. from March hackathon
7. **Package versions scattered** — sdk/react at 0.6-0.7, everything else at 0.3.0
8. **No Docker image CI** — images built manually
9. **No release workflow** — npm publish is manual
10. **No code owners** — no auto-review assignment

---

## Worker Breakdown

### Worker G — Fix CI + Add Comprehensive Workflows
**Branch:** `fix/ci-workflows`

**Tasks:**

1. **Fix the existing CI workflow:**
   - Typecheck step: exclude `__tests__` dirs from tsc (add `"exclude": ["src/__tests__"]` to all package tsconfigs that don't have it)
   - OR change CI to `bunx turbo run build --filter=@stwd/api --filter=@stwd/proxy` (only build what matters)
   - Test step: run `bun test` per package that has tests
   - Verify CI passes on develop HEAD

2. **Add Docker image workflow (`.github/workflows/docker.yml`):**
   ```yaml
   on:
     push:
       branches: [develop]
       tags: ['v*']
   jobs:
     build-and-push:
       - Build image
       - Push to ghcr.io/steward-fi/steward:develop (on branch push)
       - Push to ghcr.io/steward-fi/steward:v0.X.0 + :latest (on tag)
   ```

3. **Add release workflow (`.github/workflows/release.yml`):**
   ```yaml
   on:
     push:
       tags: ['v*']
   jobs:
     publish-npm:
       - Build all packages
       - Publish @stwd/sdk, @stwd/react, @stwd/eliza-plugin to npm
       - Create GitHub release with changelog
   ```

4. **Add PR validation workflow (`.github/workflows/pr.yml`):**
   - Run on PR to develop/main
   - Lint, typecheck, test
   - Check PR title follows conventional commits
   - Label PRs automatically (feat, fix, docs, etc.)

### Worker H — Repo Hygiene + Contributing Guide
**Branch:** `chore/repo-cleanup`

**Tasks:**

1. **Create `CONTRIBUTING.md`:**
   - Prerequisites (Bun 1.3+, Node 18+)
   - Dev setup: clone, install, run
   - Project structure explanation (monorepo, packages, what each does)
   - PR process: branch from develop, conventional commits, describe changes
   - Code style: TypeScript strict, no `any`, BEM CSS for react
   - Testing: where to add tests, how to run
   - Commit format: `feat(sdk): description`, `fix(api): description`

2. **Create PR template (`.github/pull_request_template.md`):**
   - Summary, type (feat/fix/docs), breaking changes
   - Checklist: tests, docs, CI passes
   - Based on revlentless's excellent PR #437 format

3. **Create issue templates:**
   - Bug report (`.github/ISSUE_TEMPLATE/bug_report.md`)
   - Feature request (`.github/ISSUE_TEMPLATE/feature_request.md`)

4. **Create `CODEOWNERS`:**
   ```
   * @0xSolace
   packages/api/ @0xSolace
   packages/auth/ @0xSolace
   .github/ @0xSolace
   ```

5. **Clean up root directory:**
   - Move stale planning docs to `docs/archive/`: PLAN.md, SPRINT-PLAN.md, WORKER-PLAN.md, CROSS-TENANT-PLAN.md, PRODUCTION-PLAN.md, MULTICHAIN-PLAN.md, REDESIGN-BRIEF.md, SUBMISSION.md
   - Keep: README.md, VISION.md (update it), LICENSE, docker-compose files, config files
   - VISION.md should be the north-star doc, not a hackathon artifact

6. **Clean up stale branches:**
   - Delete all local branches except develop + any active feature work
   - Delete merged remote branches

### Worker I — README + Docs Refresh
**Branch:** `docs/readme-refresh`

**Tasks:**

1. **Rewrite README.md:**
   - Keep the strong intro (problem/solution/architecture)
   - Add "Quick Start" section: `npm install @stwd/sdk` + 10-line example
   - Add "Auth Widget" section: show `<StewardLogin />` usage
   - Add "Packages" table with all npm packages + links
   - Add "Self-Hosting" section: docker-compose one-liner
   - Add "Contributing" link
   - Add "Roadmap" high-level (auth widget ✅, cross-tenant ✅, eliza integration 🔜)
   - Remove stale/outdated sections

2. **Update VISION.md:**
   - Refresh from hackathon artifact to living strategic doc
   - Positioning: "high abstraction + open source + self-hostable"
   - Day-one customers: elizaOS, eliza, babylon, hyperscape
   - Competitive landscape table (the 6-box comparison)

3. **Update docs/quickstart.md:**
   - SDK auth quickstart (passkey, email, OAuth)
   - React widget quickstart (`<StewardProvider>` + `<StewardLogin />`)
   - Self-hosting quickstart (docker-compose)

4. **Add docs/auth.md update:**
   - Document all auth methods
   - OAuth setup guide (Google, Discord, Twitter credentials)
   - Cross-tenant identity explanation

### Worker J — Branch Protection + Repo Settings
**This one Sol does directly (requires GitHub API, not code)**

**Tasks:**
1. Set branch protection on `develop`:
   - Require PR reviews (1 approval)
   - Require CI status checks to pass
   - No direct pushes (except admins)
2. Set branch protection on `main` (if exists):
   - Same + require 2 approvals
3. Enable "Automatically delete head branches" on repo
4. Add repo topics: `ai-agents`, `wallet`, `authentication`, `policy-engine`, `open-source`
5. Update repo description if needed

---

## Merge Order

1. **Worker G** (CI fix) — must pass before branch protection
2. **Worker J** (repo settings) — immediately after CI is green
3. **Worker H** (contributing guide + cleanup) — PR through the new process
4. **Worker I** (docs) — PR through the new process

## What This Does NOT Include (Scoped Out)

- Deploying develop to production (separate task)
- Building new features
- Eliza integration
- Dashboard work
- These are documented in `~/.moltbot/projects/steward/NEXT.md`

# CI/CD Workflows

This directory contains GitHub Actions workflows for the elizaOS project (v2.0.0).

## Workflow Overview

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yaml` | Push/PR to main | Main CI - tests, lint, build |
| `pr.yaml` | PR opened/edited | PR title validation |
| `release.yaml` | Push to main, Release | NPM beta/production package releases |
| `claude.yml` | @claude mentions | Interactive Claude assistance |
| `claude-code-review.yml` | PR opened | Automated code review |
| `claude-security-review.yml` | PR opened | Security-focused review |
| `codeql.yml` | Push/PR to main, Weekly | Static security analysis |
| `docs-ci.yml` | PR (docs paths), Manual | Documentation quality checks |
| `image.yaml` | Release, Manual | Docker image builds |
| `tee-build-deploy.yml` | Push to main, Manual | TEE deployment to Phala Cloud |
| `weekly-maintenance.yml` | Weekly, Manual | Dependency/security audits |
| `jsdoc-automation.yml` | Manual | JSDoc generation |

## Release Workflows

### Alpha Tags

Alpha version tags are tags only. They do not publish NPM packages, run packaging
CI, or create GitHub Release entries.

### NPM Beta/Production Packages (`release.yaml`)

Publishes TypeScript/JavaScript packages to NPM.

**Triggers:**

- Push to `main` → Beta release (`@beta` tag)
- GitHub Release created → Production release (`@latest` tag)

**Packages:** All `@elizaos/*` packages in the monorepo

## Test Workflows

### Main CI (`ci.yaml`)

Runs on PRs and pushes to main:

- TypeScript tests with coverage
- Linting and formatting checks
- Build verification
- Interop TypeScript tests (`packages/interop`)

## Code Review Workflows

### Claude Code Review (`claude-code-review.yml`)

Automated PR review using Claude. Checks for:

- Security issues (hardcoded keys, SQL injection, XSS)
- Test coverage
- TypeScript types (no `any`)
- Correct tooling (bun, vitest)

### Claude Security Review (`claude-security-review.yml`)

Dedicated security-focused review for code changes.

### Claude Interactive (`claude.yml`)

Responds to `@claude` mentions in issues and PRs.

## Documentation Workflows

### Docs CI (`docs-ci.yml`)

Consolidated documentation quality workflow:

- **Dead Link Checking:** Scans for broken internal/external links
- **Quality Checks:** Double headers, missing frontmatter, heading hierarchy

Automatically creates PRs with fixes when issues are found.

### JSDoc Automation (`jsdoc-automation.yml`)

Manual workflow for generating JSDoc documentation.

## Manual Release Process

### 1. Create a GitHub Release

1. Go to Releases → Create new release
2. Create a new tag: `v2.0.0` (follows semver)
3. Add release notes
4. Publish release

### 2. Automated Publishing

The release will trigger:

- `release.yaml` → NPM packages

### 3. Manual publishing

Use `bunx lerna publish` from the repo root when automation is not sufficient (see `release.yaml`).

## Setting Up Secrets

### Required Secrets

| Secret | Purpose | How to Get |
|--------|---------|------------|
| `NPM_TOKEN` | NPM publishing | [npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens) |
| `ANTHROPIC_API_KEY` | Claude workflows | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | Tests requiring OpenAI | [platform.openai.com](https://platform.openai.com) |

### Optional Secrets

| Secret | Purpose |
|--------|---------|
| `TURBO_TOKEN` | Turborepo remote caching |
| `PHALA_CLOUD_API_KEY` | TEE deployment |
| `GH_PAT` | Cross-repo operations |

## Package dependencies

NPM packages are ordered by the monorepo graph; `release.yaml` / Lerna handle publish ordering for `@elizaos/*` packages.

## Troubleshooting

### CI Failures

1. Check if tests pass locally: `bun run test`
2. Check formatting: `bun run format:check`
3. Check linting: `bun run lint`

### Release Failures

1. Verify secrets are configured
2. Check workflow logs for specific errors
3. For NPM: ensure package versions are unique

### Claude Workflow Issues

1. Verify `ANTHROPIC_API_KEY` is set
2. Check rate limits on Anthropic API
3. Review Claude's output in workflow logs

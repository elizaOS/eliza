# CI/CD Workflows

This directory contains GitHub Actions workflows for the elizaOS project (v2.0.0).

## Workflow Overview

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yaml` | Push/PR to main | Main CI - tests, lint, build |
| `pr.yaml` | PR opened/edited | PR title validation |
| `release.yaml` | Push to develop/main, Release | NPM package releases |
| `release-python.yaml` | Release, Manual | PyPI package releases |
| `release-rust.yaml` | Release, Manual | Crates.io releases |
| `claude.yml` | @claude mentions | Interactive Claude assistance |
| `claude-code-review.yml` | PR opened | Automated code review |
| `claude-security-review.yml` | PR opened | Security-focused review |
| `codeql.yml` | Push/PR to main, Weekly | Static security analysis |
| `multi-lang-tests.yaml` | Push/PR (Rust/Python paths) | Rust, Python, WASM tests |
| `docs-ci.yml` | PR (docs paths), Manual | Documentation quality checks |
| `image.yaml` | Release, Manual | Docker image builds |
| `tee-build-deploy.yml` | Push to main, Manual | TEE deployment to Phala Cloud |
| `weekly-maintenance.yml` | Weekly, Manual | Dependency/security audits |
| `jsdoc-automation.yml` | Manual | JSDoc generation |

## Release Workflows

### NPM Packages (`release.yaml`)

Publishes TypeScript/JavaScript packages to NPM.

**Triggers:**

- Push to `develop` → Alpha release (`@alpha` tag)
- Push to `main` → Beta release (`@beta` tag)
- GitHub Release created → Production release (`@latest` tag)

**Packages:** All `@elizaos/*` packages in the monorepo

### Python Packages (`release-python.yaml`)

Publishes Python packages to PyPI.

**Triggers:**

- GitHub Release created
- Manual dispatch

**Packages:**

- `elizaos` (packages/python) - Core runtime and types
- `elizaos-plugin-sql` (packages/plugin-sql/python) - SQL database adapters
- Additional plugins as configured

**Required Secrets:** `PYPI_TOKEN`

### Rust Crates (`release-rust.yaml`)

Publishes Rust crates to crates.io.

**Triggers:**

- GitHub Release created
- Manual dispatch

**Crates:**

- `elizaos` (packages/rust) - Core runtime and types
- `elizaos-plugin-sql` (packages/plugin-sql/rust) - SQL database adapters
- Additional plugins as configured

**Required Secrets:** `CRATES_IO_TOKEN`

## Test Workflows

### Main CI (`ci.yaml`)

Runs on PRs and pushes to main:

- TypeScript tests with coverage
- Linting and formatting checks
- Build verification

### Multi-Language Tests (`multi-lang-tests.yaml`)

Tests Rust and Python packages:

- **Rust:** formatting, clippy, tests, release build
- **Python:** ruff linting, pytest
- **WASM:** build verification
- **Interop:** cross-language integration tests
- **SQL Plugin:** PostgreSQL integration tests

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
- `release-python.yaml` → PyPI packages
- `release-rust.yaml` → crates.io crates

### 3. Manual Publishing (if needed)

**Python:**

```bash
cd packages/python
pip install build twine
python -m build
twine upload dist/*
```

**Rust:**

```bash
cd packages/rust
cargo publish
```

## Setting Up Secrets

### Required Secrets

| Secret | Purpose | How to Get |
|--------|---------|------------|
| `NPM_TOKEN` | NPM publishing | [npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens) |
| `PYPI_TOKEN` | PyPI publishing | [pypi.org/manage/account/token/](https://pypi.org/manage/account/token/) |
| `CRATES_IO_TOKEN` | crates.io publishing | [crates.io/settings/tokens](https://crates.io/settings/tokens) |
| `ANTHROPIC_API_KEY` | Claude workflows | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | Tests requiring OpenAI | [platform.openai.com](https://platform.openai.com) |

### Optional Secrets

| Secret | Purpose |
|--------|---------|
| `TURBO_TOKEN` | Turborepo remote caching |
| `PHALA_CLOUD_API_KEY` | TEE deployment |
| `GH_PAT` | Cross-repo operations |

## Package Dependencies

When releasing, packages are published in this order:

1. **Core packages first:**
   - `elizaos` (Python)
   - `elizaos` (Rust)
   - `@elizaos/core` (NPM)

2. **Then dependent packages:**
   - `elizaos-plugin-*` (Python, depends on elizaos)
   - `elizaos-plugin-*` (Rust, depends on elizaos)
   - `@elizaos/plugin-*` (NPM, depends on @elizaos/core)

The workflows handle this ordering automatically.

## Troubleshooting

### CI Failures

1. Check if tests pass locally: `bun run test`
2. Check formatting: `bun run format:check`
3. Check linting: `bun run lint`

### Release Failures

1. Verify secrets are configured
2. Check workflow logs for specific errors
3. For NPM: ensure package versions are unique
4. For crates.io: wait for index propagation (2 min delay built-in)

### Claude Workflow Issues

1. Verify `ANTHROPIC_API_KEY` is set
2. Check rate limits on Anthropic API
3. Review Claude's output in workflow logs

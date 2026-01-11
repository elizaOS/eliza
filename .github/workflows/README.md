# CI/CD Workflows

This directory contains GitHub Actions workflows for the elizaOS project.

## Release Workflows

### NPM Packages (`release.yaml`)

Publishes TypeScript/JavaScript packages to NPM.

**Triggers:**

- Push to `develop` → Alpha release
- Push to `main` → Beta release
- GitHub Release created → Production release

**Packages:**

- All `@elizaos/*` packages in the monorepo

### Python Packages (`release-python.yaml`)

Publishes Python packages to PyPI.

**Triggers:**

- GitHub Release created
- Manual dispatch

**Packages:**

- `elizaos` (packages/python) - Core runtime and types
- `elizaos-plugin-sql` (packages/plugin-sql/python) - SQL database adapters

**Required Secrets:**

- `PYPI_TOKEN` - PyPI API token with upload permissions

### Rust Crates (`release-rust.yaml`)

Publishes Rust crates to crates.io.

**Triggers:**

- GitHub Release created
- Manual dispatch

**Crates:**

- `elizaos-core` (packages/rust) - Core runtime and types
- `elizaos-plugin-sql` (packages/plugin-sql/rust) - SQL database adapters

**Required Secrets:**

- `CRATES_IO_TOKEN` - crates.io API token

## Test Workflows

### Main CI (`ci.yaml`)

Runs on PRs and pushes to main:

- TypeScript tests
- Linting and formatting
- Build verification

### Multi-Language Tests (`multi-lang-tests.yaml`)

Tests Rust and Python packages:

- Rust: formatting, clippy, tests, release build
- Python: ruff, mypy, pytest
- WASM: build verification
- Interop: cross-language integration tests

### Plugin SQL Tests (`plugin-sql-tests.yaml`)

Specific tests for the SQL plugin package.

## Manual Release Process

### 1. Create a GitHub Release

1. Go to Releases → Create new release
2. Create a new tag: `v1.0.0` (follows semver)
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

### PyPI Token

1. Go to https://pypi.org/manage/account/token/
2. Create a token with "Upload packages" scope
3. Add as `PYPI_TOKEN` in repository secrets

### crates.io Token

1. Go to https://crates.io/settings/tokens
2. Create a token with publish scope
3. Add as `CRATES_IO_TOKEN` in repository secrets

### NPM Token

1. Go to https://www.npmjs.com/settings/~/tokens
2. Create a token with publish permissions
3. Add as `NPM_TOKEN` in repository secrets

## Package Dependencies

When releasing, packages should be published in this order:

1. **Core packages first:**
   - `elizaos` (Python)
   - `elizaos-core` (Rust)
   - `@elizaos/core` (NPM)

2. **Then dependent packages:**
   - `elizaos-plugin-sql` (Python, depends on elizaos)
   - `elizaos-plugin-sql` (Rust, depends on elizaos-core)
   - `@elizaos/plugin-sql` (NPM, depends on @elizaos/core)

The workflows handle this ordering automatically.

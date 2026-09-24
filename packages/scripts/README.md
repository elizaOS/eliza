# Repository tooling

`packages/scripts/` is the single home for repository-wide build, test, release,
security, evidence, and development tools. It has no package manifest; root
`package.json` commands invoke its entrypoints. Package-specific scripts remain
in `packages/*/scripts/`; GitHub helpers live in `packages/scripts/github/`.

Run commands from the repository root:

```bash
bun run test:scripts
node packages/scripts/run-script-tests.mjs --inventory
node packages/scripts/audit-scripts.mjs
bun run verify
```

The script test runner discovers tests recursively here and in
`packages/cloud/scripts/`, including untracked files during development.
Relative module imports resolve from their source file; operational outputs and
repository configuration resolve from the checkout root. Keep those paths
correct when moving tools between subdirectories.

# Repository tooling

`packages/scripts/` is the single home for repository-wide build, test, release,
security, evidence, and development tools. It has no package manifest; root
`package.json` commands invoke its entrypoints. Package-specific scripts remain
with their owning packages. Shared workflow installers live in `github/`;
app device preflight lives in `packages/app/scripts/`.

Run commands from the repository root:

```bash
bun run test:e2e
node packages/scripts/audit-scripts-inventory.mjs
node packages/scripts/audit-scripts.mjs
bun run verify
```

The canonical E2E command exercises authentication and assistant/tool flows with
strict deterministic model responses. Additional product flows require explicit
E2E review before joining this lane.
Relative module imports resolve from their source file; operational outputs and
repository configuration resolve from the checkout root. Keep those paths
correct when moving tools between subdirectories.

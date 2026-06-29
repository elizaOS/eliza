# Issue #10059 Evidence: eliza-code ACP package publishability

## Scope

Prepared `@elizaos/example-code` for the existing Lerna npm release train so the cloud agent image can install the `eliza-code-acp` bin once maintainers publish the next release tag.

## Registry Research

- `npm view @elizaos/example-code dist-tags --json` returns E404: the package is not published yet.
- `npm view @elizaos/plugin-coding-tools dist-tags --json` shows `latest: 2.0.0-beta.1` and `beta: 2.0.3-beta.7`, with no `alpha` tag.
- `npm view @elizaos/plugin-agent-orchestrator dist-tags --json` shows `alpha: 2.0.0-alpha.537` and `beta: 2.0.3-beta.7`.
- `npm view @elizaos/plugin-shell dist-tags --json` shows `alpha: 2.0.0-alpha.537` and `beta: 2.0.3-beta.7`.

## Changes

- Added `packages/examples/code` to `lerna.json` so release versioning/publishing sees `@elizaos/example-code`.
- Added package publish metadata and a `files` allowlist for the built ACP/TUI entrypoints.
- Added a shebang to `src/acp.ts` so the npm-installed `eliza-code-acp` bin is directly executable.
- Made npm pack/publish helper scripts invoke npm through `node npm-cli.js` on Windows, avoiding `execFileSync("npm")` and `.cmd` spawn failures.

## Validation

- `bun run --cwd packages/examples/code build`
  - Passes.
  - Builds `dist/index.js` and `dist/acp.js`.
  - `dist/acp.js` starts with `#!/usr/bin/env node`.
- `bunx lerna ls --all --json --scope @elizaos/example-code --loglevel error`
  - Passes.
  - Returns exactly one public package: `@elizaos/example-code` at `packages/examples/code`.
- `node packages/scripts/verify-npm-pack-dist.mjs packages/examples/code`
  - Passes after temporarily moving the generated `packages/examples/code/node_modules` aside on Windows.
  - Output: `ok @elizaos/example-code: 4 packed file(s), dist included`.
  - Note: plain `npm pack` hangs in this Windows checkout when Bun's per-workspace `node_modules` symlink tree is present; a clean staging copy packs normally.
- Clean staging npm dry-run pack:
  - Passes.
  - Files included: `README.md`, `dist/acp.js`, `dist/index.js`, `package.json`.

## Evidence N/A

- Screenshots/video: N/A, packaging/release metadata only.
- Live cloud task: N/A, requires npm publish credentials plus Hetzner/GHCR cloud redeploy access.

## Remaining Cloud Work

- Publish `@elizaos/example-code` under the intended release tag.
- Decide whether cloud should install `@elizaos/plugin-coding-tools@beta` or wait for an `alpha` tag.
- Extend the cloud agent image/runtime to install/load the coding packages and redeploy the Hetzner cloud agent stack.

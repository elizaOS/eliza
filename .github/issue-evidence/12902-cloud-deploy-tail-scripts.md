# Issue #12902: cloud/deploy package script normalization tail

## Scope

Final tail slice for the #12902 package group:

- `packages/cloud/infra`
- `packages/cloud/docs-redirect`
- `packages/cloud/api`
- `packages/cloud/services/coding-remote-runner`
- `packages/cloud/services/agent-server`
- `packages/cloud/services/_smoke-mcp`

`packages/deploy` was reviewed and contains systemd deploy assets, not a package manifest.

## Changes

- Added standard mutating `lint`, read-only `lint:check`, and format verbs where missing.
- Removed the type-only `build` script from `packages/cloud/api`; `typecheck` remains the no-emit type command.
- Removed the fake `agent-server` `test:integration` wrapper that targeted a nonexistent directory with `--pass-with-no-tests`.
- Added real `build`/`clean` and standard check verbs for the temporary `_smoke-mcp` Worker harness.
- Updated matching package-local `CLAUDE.md` and `AGENTS.md` command lists; verified each touched pair remains identical.

## Verification

Passed:

```bash
find packages/cloud packages/registry packages/plugin-remote-manifest packages/plugin-worker-runtime packages/plugin-sub-agent-claude-code -name package.json -maxdepth 4 -print0 | xargs -0 jq -e '.name and (.scripts|type=="object")' >/dev/null
git diff --check
node <static #12902 manifest guard>
# packages=18 issues=0

bun run --cwd packages/cloud/infra lint:check
bun run --cwd packages/cloud/docs-redirect lint:check
bun run --cwd packages/cloud/api lint:check
bun run --cwd packages/cloud/services/coding-remote-runner lint:check
bun run --cwd packages/cloud/services/agent-server lint:check
bun run --cwd packages/cloud/services/_smoke-mcp lint:check

for p in packages/cloud/infra packages/cloud/docs-redirect packages/cloud/api packages/cloud/services/coding-remote-runner packages/cloud/services/agent-server packages/cloud/services/_smoke-mcp; do bun run --cwd "$p" format:check || exit $?; done

bun run --cwd packages/cloud/services/coding-remote-runner test

for d in packages/cloud/infra packages/cloud/docs-redirect packages/cloud/api packages/cloud/services/coding-remote-runner packages/cloud/services/agent-server; do cmp -s "$d/CLAUDE.md" "$d/AGENTS.md" || exit 1; done
```

Notes:

- `packages/cloud/infra lint:check` exited successfully with an existing Biome warning in `tests/terraform-static.test.ts` for a Terraform interpolation string literal.

Blocked by the temp worktree's incomplete dependency install:

```bash
bun run --cwd packages/cloud/infra test
# Cannot find package 'yaml'

bun run --cwd packages/cloud/docs-redirect test
# vitest: command not found

bun run --cwd packages/cloud/services/agent-server test:unit
# Cannot resolve @elizaos/core / @elizaos/cloud-services-common / ioredis

bun run --cwd packages/cloud/services/coding-remote-runner typecheck
bun run --cwd packages/cloud/api typecheck
bun run --cwd packages/cloud/services/agent-server typecheck
bun run --cwd packages/cloud/services/_smoke-mcp typecheck
# Missing @types/node and/or @cloudflare/workers-types

bun run --cwd packages/cloud/services/_smoke-mcp build
# Wrangler reached bundling, then failed to resolve mcp-handler from the incomplete install.
```

The available `/Users/shawwalters/eliza/node_modules` was linked into the worktree before retrying, but it also lacks the dependencies above.

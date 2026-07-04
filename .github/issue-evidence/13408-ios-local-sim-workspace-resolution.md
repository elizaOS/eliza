# Issue 13408: iOS local simulator mobile workspace resolution

## Summary

Fixed the mobile Bun bundle resolver so scoped workspace packages used by the iOS local simulator build resolve from the current checkout instead of stale or incomplete `node_modules` workspace links.

This also covers the related #13441 Turbo cycle blocker that appeared after the resolver failure was fixed. The cycle was broken by removing the unused `@elizaos/agent` dependency edge from `@elizaos/plugin-local-inference`, and the PR adds a direct workspace package-cycle self-test to the Turbo build-dependency audit.

The original targeted bundle failure reproduced in this worktree:

```text
error: Could not resolve: "@elizaos/cloud-routing". Maybe you need to "bun install"?
error: Could not resolve: "@elizaos/plugin-elizacloud". Maybe you need to "bun install"?
```

## Commands and evidence

| Check | Result |
| --- | --- |
| `bun run --cwd packages/agent build:ios-bun` before fix | Failed with unresolved `@elizaos/cloud-routing` and `@elizaos/plugin-elizacloud`; transcript: `/tmp/13408-agent-ios-bundle-before.log` |
| `bun run --cwd packages/agent verify:mobile-workspace-resolution` | Passed: `workspace resolution verified for 7 packages`; transcript: `/tmp/13408-mobile-workspace-resolution-check.log` |
| `bun run --cwd packages/agent build:ios-bun` after fix | Passed and emitted `agent-bundle.js`; transcript: `/tmp/13408-agent-ios-bundle-after.log` |
| `node packages/scripts/audit-turbo-build-deps.self-test.mjs` | Passed: direct workspace package-cycle and phantom override fixture coverage |
| `bun run --cwd plugins/plugin-local-inference typecheck` | Passed after removing the unused `@elizaos/agent` dependency edge |
| `bun install --ignore-scripts` after replacing stale workspace symlinks | Passed; transcript: `/tmp/13408-bun-install-after-stale-symlinks.log` |
| `bun run --cwd packages/app build:web` | Passed, including `verify-chunk-safety`; transcript: `/tmp/13408-app-build-web-after-local-install.log` |
| `bun run --cwd packages/app build:ios:local:sim` | Passed with `** BUILD SUCCEEDED **`; transcript: `/tmp/13408-ios-local-sim-build-final.log` |

The full `node packages/scripts/audit-turbo-build-deps.mjs` repo audit still fails on pre-existing phantom overrides outside this fix. The added self-test exercises the new direct-cycle guard without depending on those existing repository audit blockers.

## Produced simulator artifact

```text
/Users/shawwalters/Library/Developer/Xcode/DerivedData/App-gqhkgffunpcdipeljskkszhyfnbi/Build/Products/Debug-iphonesimulator/App.app
modified: 2026-07-04 15:10:40 EDT
size: 202M
```

The app bundle contains the staged mobile agent payload:

```text
App.app/public/agent/agent-bundle.js
App.app/public/agent/plugins-manifest.json
App.app/public/agent/pglite.wasm
App.app/public/agent/initdb.wasm
App.app/public/agent/pglite.data
```

## UI evidence

Not applicable for this issue. The change is build pipeline/package resolution behavior, and the required proof is a successful local iOS simulator build with the bundled agent payload present in the produced `.app`.

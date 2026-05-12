# Phase 4 - LifeOps, Health, And App Plugin Package Audit

Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`
Mode: dry run / report only

No source files were deleted or modified for this pass. This report covers the
app-oriented plugin family that did not fit into the first subagent batch due
to the active thread limit.

## Guardrails

- Preserve one LifeOps task primitive: `ScheduledTask`.
- Do not add a second runner, graph store, connector dispatch primitive, or
identity merge path.
- LifeOps must not import health internals. Health contributes through public
registries and public package exports.
- Keep connector/channel dispatch typed as `DispatchResult`, not boolean.
- Behavior must remain structural; do not make runner decisions from
`promptInstructions` text.

## Methodology

Read-only commands used:

```sh
git ls-files 'plugins/app-lifeops/**' 'plugins/plugin-health/**' 'plugins/app-*/*' |
  rg -n -i '(contract-stubs|resolver-shim|wave1-types|legacy|deprecated|fallback|stub|shim|compat|unified|consolidated|TODO|FIXME|HACK|@ts-nocheck|eslint-disable|biome-ignore)'
node -e '<package script inventory over plugins/*/package.json>'
rg -n 'Promise<boolean>|return true;|return false;' plugins/app-lifeops/src/routes
rg -n 'detectHealthBackend|health-bridge|SleepRecap|createLifeOpsSleepEpisode|createLifeOpsHealth' packages plugins
```

## High-Confidence No-Behavior Cleanup Candidates

### LHA-01 - Remove Unreferenced LifeOps Resolver Shim

Path:
`plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts`

Evidence:
Prior Phase 3 scan found no live imports of `ResolvedContactShim`,
`ContactResolverShim`, `createContactResolverShim`, or `resolver-shim` outside
the file and historical audit docs. It is explicitly an old resolver shim in
the entity area.

Dry-run action:

```sh
rg -n 'createContactResolverShim|ContactResolverShim|ResolvedContactShim|resolver-shim' plugins/app-lifeops packages plugins test docs
git rm -n -- plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts
```

Validation:

```sh
bun run --cwd plugins/app-lifeops test
bun run --cwd plugins/app-lifeops lint:default-packs
bun run typecheck
```

Risk:
Medium. Delete only if the fresh grep remains clean.

### LHA-02 - Collapse Contract Stubs Into Canonical Contract Exports

Paths:

- `plugins/app-lifeops/src/default-packs/contract-stubs.ts`
- `plugins/plugin-health/src/default-packs/contract-stubs.ts`
- `plugins/plugin-health/src/connectors/contract-stubs.ts`
- `plugins/app-lifeops/src/lifeops/wave1-types.ts`

Evidence:
These files duplicate `ScheduledTask`, default-pack, connector, anchor, bus,
and runtime registry shapes that now have canonical owners. They are still
imported, so this is not a direct delete.

Dry-run action:
Create public canonical contract modules first, replace imports package by
package, then delete stubs only after imports hit zero.

Validation:

```sh
rg -n 'contract-stubs|wave1-types' plugins/app-lifeops/src plugins/plugin-health/src
bun run --cwd plugins/app-lifeops test
bun run --cwd plugins/plugin-health test
bun run typecheck
```

Risk:
High. Done wrong, this violates the LifeOps/health boundary. The target owner
should be shared/public contracts, not LifeOps importing health internals or
health importing LifeOps internals.

## App Plugin Package Hygiene

The app plugin family has uneven quality gates. Current script inventory shows:

| Package | Missing Standard Gates |
| --- | --- |
| `@elizaos/app-2004scape` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-babylon` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-defense-of-the-agents` | no `typecheck` or `lint` script |
| `@elizaos/app-documents` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-elizamaker` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-hyperliquid` | no `typecheck` or `lint` script |
| `@elizaos/app-hyperscape` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-lifeops` | no package-local `typecheck` or `lint` script, though root validation covers it |
| `@elizaos/app-polymarket` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-scape` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-screenshare` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-shopify` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-steward` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-task-coordinator` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-training` | no `typecheck` or `lint` script |
| `@elizaos/app-vincent` | no `typecheck`, `test`, or `lint` script |
| `@elizaos/app-wallet` | no `typecheck`, `test`, or `lint` script |

TODO:
standardize all publishable app packages to expose `build`, `typecheck`,
`test`, and `lint`, even when the implementation is a narrow no-op with a
commented reason. Hidden validation gaps are worse than explicit no-op gates.

## Compatibility And Naming Findings

| Path | Classification | Recommendation |
| --- | --- | --- |
| `plugins/app-lifeops/src/actions/inbox-unified.ts` | Active public action | Keep behavior and action name. Rename filename only after action metadata/spec owners approve. |
| `plugins/app-lifeops/test/inbox-unified-action.test.ts` | Active test | Keep with action until rename policy is approved. |
| `plugins/app-steward/src/routes/*-compat-routes.ts` | Active route compatibility layer | Keep until route aliases are sunset. Do not delete as slop. |
| `plugins/app-training/test/plugin-discord.stub.ts` | Test stub | Keep if tests still import it; otherwise delete with package test validation. |
| `plugins/app-companion/src/types/three-vrm-shim.d.ts` | Type shim | Keep unless upstream `three-vrm` types remove the need. |
| `plugins/plugin-health/src/health-bridge/health-platform-fallback.md` | Markdown under source | Move to docs or delete if obsolete; source folders should not carry markdown fallback notes. |

## Package Boundary TODOs

1. Move LifeOps compatibility health re-exports to direct health imports by
   consumers. Delete LifeOps re-export paths only after cross-repo import scan
   is clean.
2. Make health connector/default-pack contract ownership explicit. The current
   duplicate `contract-stubs.ts` files hide the real public boundary.
3. Turn LifeOps route handler boolean sentinels into a small local route result
   only where `true` conflates success with handled-error response. Do not churn
   all routes mechanically.
4. Add package-local validation scripts to app packages that are published.
5. Move source-adjacent markdown notes out of `src/` unless they are generated
   docs-site inputs.

## Validation Gate

Minimum after this family changes:

```sh
bun run --cwd plugins/app-lifeops test
bun run --cwd plugins/plugin-health test
bun run --cwd plugins/app-companion test
bun run --cwd plugins/app-training test
bun run --cwd plugins/app-trajectory-logger test
bun run lint
bun run typecheck
bun run build
```

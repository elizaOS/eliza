# #13515 — cross-package src relative imports → package barrels + guard

Scope: the three static cross-package src imports in packages/agent production
sources, plus a vitest guard that keeps them out. The residual
plugin-app-manager tsconfig path mapping and the app/app-core escapes are left
for a follow-up, as the issue suggests.

## Changes

| file | before | after |
| --- | --- | --- |
| `packages/agent/src/api/inbox-routes.ts` | `import { resolveEffectiveMuteState, setRoomMuteUntil, setWorldMuteState } from "../../../core/src/services/message/mute-state.ts"` | `from "@elizaos/core"` (barrel re-exports at `services/message.ts:1526-1534`, surfaced via `index.node.ts:299 export * from "./services/message"`) |
| `packages/agent/src/services/relationships-graph.ts` | value+type re-export block `from "../../../core/src/services/relationships-graph-builder.ts"` | `from "@elizaos/core"` (`index.node.ts:312 export * from "./services/relationships-graph-builder"`) |
| `packages/agent/src/config/zod-schema.agent-runtime.ts` | `import { parseDurationMs } from "../../../shared/src/cli/parse-duration.ts"` | `from "@elizaos/shared"` (`shared/src/index.ts:26 export * from "./cli/parse-duration.js"`) |

New guard: `packages/agent/src/__tests__/no-cross-package-src-imports.test.ts`
— walks all production agent sources (tests/`__tests__`/`.d.ts` excluded,
they never reach dist) and fails on any static import/export-from specifier
that resolves outside `packages/agent`. Dynamic-import fallback path strings
(e.g. the plugin-sql source-checkout fallback in `runtime/eliza.ts:294`,
which is a `path.resolve` argument, not an import specifier) are intentionally
not matched.

## Litter proof (the actual bug)

On this branch, from `packages/agent`:

```
$ find ../core/src ../shared/src -name "*.js" ! -path "*node_modules*" | wc -l
0                                    # before build
$ bunx tsc --noCheck -p tsconfig.build.json ; echo EXIT:$?
EXIT:0
$ find ../core/src ../shared/src -name "*.js" ! -path "*node_modules*" | wc -l
0                                    # after build — was 112+ on develop
```

`git status` after the build: only the three edited sources + the new test.
No gitignored .js litter emitted into `packages/core/src` or
`packages/shared/src`.

Dist now references the barrels, not sibling src:

```
dist/api/inbox-routes.js:36
  import { resolveEffectiveMuteState, setRoomMuteUntil, setWorldMuteState, } from "@elizaos/core";
dist/config/zod-schema.agent-runtime.js:11
  import { parseDurationMs } from "@elizaos/shared";
```

`grep -rn "core/src\|shared/src" dist/api/inbox-routes.js
dist/services/relationships-graph.js dist/config/zod-schema.agent-runtime.js`
→ no matches.

## Guard test output

```
✓ src/__tests__/no-cross-package-src-imports.test.ts (1 test) 46ms
Test Files  1 passed (1)
     Tests  1 passed (1)
EXIT:0
```

(Guard passes = zero offenders across ALL agent production sources, so the
other two known imports are confirmed gone and no additional ones exist.)

## Checks

- `bunx @biomejs/biome check --write` on the four touched files: clean.
- `tsgo --noEmit -p tsconfig.json` (packages/agent): zero diagnostics in any
  touched file; remaining 12 lines are pre-existing optional-plugin and
  out-of-package noise (`@elizaos/plugin-streaming`, `@elizaos/plugin-vision`,
  generated `validation-keyword-data.js`, `@elizaos/plugin-meetings`),
  identical on base.
- `bunx tsc --noCheck -p tsconfig.build.json` (the dist build the issue is
  about): EXIT:0, zero litter (above).

## N/A rows

- UI screenshots: N/A — build-graph/import hygiene only, no UI change.
- Model trajectories: N/A.
- Audio: N/A.
- Runtime logs: N/A — behavior of the running agent is unchanged; the same
  symbols come from the same modules via their sanctioned barrels.

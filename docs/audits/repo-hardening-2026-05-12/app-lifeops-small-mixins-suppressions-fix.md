# app-lifeops small mixins suppressions fix

## Scope

Owned slice:

- `plugins/app-lifeops/src/lifeops/service-mixin-definitions.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-status.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-runtime-delegation.test.ts`

No `ScheduledTask` contracts, runner behavior, default packs, or health-plugin
registry boundaries were changed.

## Suppressions removed

- Removed whole-file `@ts-nocheck` from `service-mixin-status.ts`.
  - Added the public `LifeOpsStatusService` return surface.
  - Kept the existing explicit `StatusMixinDependencies` shape.
  - Fixed the hidden stale `xCloud` reference in the degraded X status branch.
- Removed whole-file `@ts-nocheck` from `service-mixin-definitions.ts`.
  - Added a local `DefinitionMixinDependencies` interface for the sibling
    methods this mixin actually calls.
  - Preserved the public mixin return as `MixinClass<TBase,
    LifeOpsDefinitionService>` so the larger service composition continues to
    expose the same API.
- Removed whole-file `@ts-nocheck` from
  `service-mixin-runtime-delegation.test.ts`.
  - Typed the lightweight runtime stub as an intentional test double.
  - Typed the X posting policy shim and X runtime delegation mocks.
  - Kept the account-id post request test as an explicit intersection type
    because the implementation intentionally reads `accountId` structurally
    while the shared `CreateLifeOpsXPostRequest` contract does not yet expose
    that field.

## Suppressions kept

None in this owned slice.

The broader app-lifeops mixin family still contains unrelated whole-file
suppression comments in files outside this write set. Those were not touched.

## Validation

- `bunx tsc --noEmit -p tsconfig.build.json` from `plugins/app-lifeops`:
  pass.
- `bunx tsc --ignoreConfig --noEmit --target ES2022 --module ES2022
  --moduleResolution bundler --strict false --skipLibCheck --types
  node,vitest/globals
  plugins/app-lifeops/src/lifeops/service-mixin-runtime-delegation.test.ts`:
  pass.
- `bunx vitest run --config vitest.config.ts
  src/lifeops/service-mixin-runtime-delegation.test.ts` from
  `plugins/app-lifeops`: pass, 16 tests.
- `node scripts/lint-default-packs.mjs` from `plugins/app-lifeops`: pass.

One initial Vitest attempt from the repo root used the wrong path shape for
this config and reported "No test files found"; the package-local rerun above
is the valid focused test result.

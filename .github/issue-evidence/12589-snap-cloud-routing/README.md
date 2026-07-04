# Snap cloud-routing declaration evidence

## Scope

Fixes the Snap `Build Snap (arm64)` failure observed on PR #12589 while building `@elizaos/core` declarations:

- `packages/core/src/cloud-routing.ts(8,8): error TS2307: Cannot find module '@elizaos/cloud-routing' or its corresponding type declarations.`
- `packages/core/src/cloud-routing.ts(15,8): error TS2307: Cannot find module '@elizaos/cloud-routing' or its corresponding type declarations.`

The iOS plist PR did not touch core or Snap packaging. The failure comes from the Snap recipe's reduced workspace build reaching `@elizaos/core` declaration generation before `@elizaos/cloud-routing` has generated `dist` types, even though `packages/core/src/cloud-routing.ts` now imports it.

## Verification

- `bun run --cwd packages/cloud/routing build` before the filtered Turbo build - PASS.
- `bunx turbo run build --filter=@elizaos/cloud-routing --filter=@elizaos/core` - PASS.
- `bunx tsc --project packages/core/tsconfig.declarations.json --pretty false` - PASS after building `@elizaos/cloud-routing`.
- `ruby -e 'require "yaml"; YAML.load_file("packages/app-core/packaging/snap/snapcraft.yaml")'` - PASS.
- `git diff --check` against `origin/develop` - PASS.

## Evidence matrix

- Live model trajectories: N/A - no model, prompt, provider, action, or evaluator behavior changed.
- Screenshots/video: N/A - no user-facing UI changed.
- Backend logs: N/A - build configuration only.
- Native/iOS capture: N/A - this is a Linux Snap declaration-build fix, not an app runtime change.

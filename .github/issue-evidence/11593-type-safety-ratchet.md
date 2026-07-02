# Issue #11593 - Restore Verify Type-Safety Ratchet Baseline

Date: 2026-07-02
Branch: fix/11593-type-safety-ratchet

## Change Summary

- Reduced ratchet counts for `as unknown as`, non-null assertions, `?? {}`, and `?? 0` without raising any baselines.
- Replaced a few fallback object/zero expressions with typed constants or explicit undefined checks.
- Split unsafe stream casts through named `unknown` intermediates in `safe-fetch`.
- Fixed formatter/type drift surfaced by full `verify`.
- Updated `test-realness-audit` to skip nested git checkouts/submodules so vendored repositories are not enforced as elizaOS-owned tests.

## Verification

- `bun run audit:type-safety-ratchet` passed:
  - `as unknown as`: 75 / 76
  - `as any`: 0 / 0
  - explicit `: any`: 124 / 124
  - `@ts-expect-error` / `@ts-ignore`: 0 / 0
  - non-null assertion: 515 / 518
  - `?? ""`: 615 / 615
  - `?? []`: 581 / 581
  - `?? {}`: 370 / 377
  - `?? 0`: 373 / 375
- `bun run audit:test-realness` passed:
  - files=5656, findings=1351, `todoTest=0`
- `bun run verify` passed end to end:
  - Turbo typecheck/lint: 483 successful, 483 total
  - `audit-build-typecheck`: pass
  - `audit-turbo-build-deps`: pass
  - `audit-tee-secret-leak`: pass
  - `audit-scripts`: pass
  - `audit:test-realness`: pass
  - `typecheck:dist`: checked 28 dist-path consumer configs

## Additional Checks

- `bun run --cwd packages/core typecheck`
- `bun run --cwd packages/app-core typecheck`
- `bun run --cwd packages/cloud/shared typecheck`
- `bun run --cwd packages/cloud/api typecheck`
- `bun run --cwd packages/agent typecheck`
- `bunx @biomejs/biome check packages/scripts/test-realness-audit.mjs`
- `bunx @biomejs/biome check packages/cloud/shared/src/lib/security/safe-fetch.ts packages/core/src/runtime/planner-loop.ts packages/app-core/src/services/account-pool.ts`

## UI / Model Evidence

- Live LLM trajectories: N/A - static type-safety/audit cleanup, no agent prompt/model behavior changed.
- Screenshots/video: N/A - no user-facing UI behavior changed. App audit was run because formatter touched app/ui files; it failed only on unrelated pre-existing minimalism ratchets:
  - `plugin-inbox-gui @ mobile-landscape`: whitespace ratio 0.53 below baseline tolerance.
  - `plugin-screenshare-gui @ mobile-portrait`: whitespace ratio 0.45 below baseline tolerance.
- Domain artifacts: N/A - no runtime data, DB rows, memories, scheduled tasks, wallet, or generated domain artifacts changed.

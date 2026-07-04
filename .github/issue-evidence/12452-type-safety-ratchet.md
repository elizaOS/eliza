# Issue 12452: type-safety ratchet drift

Date: 2026-07-04

## What changed

- Removed one production `as unknown as` cast from the app-core auth SQL table
  loader by projecting the dynamic `@elizaos/plugin-sql` import into the exact
  auth table export subset.
- Replaced the owner-app OAuth adapter's double cast with a structural
  dispatch-payload guard and added a focused rejection test for malformed
  payloads.
- Replaced `?? []` fallback literals in the core context registry with a shared
  empty readonly context list.

## Verification

- `bun run audit:type-safety-ratchet`
  - Passed.
  - `as unknown as`: `75 / 75`
  - `?? []` in core/agent/app-core scope: `579 / 581`
- `bun run --cwd packages/app-core test:auth`
  - Passed: 10 files, 73 tests.
- `bun run --cwd packages/app-core test -- src/services/sensitive-requests/owner-app-oauth-adapter.test.ts`
  - Passed: 1 file, 11 tests.
- `bun run --cwd packages/core test -- src/runtime/__tests__/context-registry.test.ts`
  - Passed: 1 file, 6 tests.
- `bun run --cwd packages/core typecheck`
  - Passed.
- `bun run verify`
  - Passed the original failing `audit:type-safety-ratchet` gate.
  - Passed `audit:error-policy-ratchet`.
  - Failed later in the turbo typecheck/lint phase on unrelated current-tree typecheck errors in `@elizaos/cloud-shared` / `@elizaos/cloud-api`, including missing `@elizaos/auth/*` subpath declarations and missing market exports from `@elizaos/shared`.

## Evidence N/A

- Live-LLM trajectory: N/A, this is a static type-safety ratchet cleanup and does not change agent prompt/model/action behavior.
- Screenshots/video/native capture: N/A, no UI, device, or visual surface changed.
- Backend/frontend logs: N/A, no service execution path changed beyond rejecting structurally invalid owner-app OAuth dispatch payloads before delivery.

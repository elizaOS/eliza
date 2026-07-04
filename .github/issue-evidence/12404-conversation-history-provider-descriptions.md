# Issue 12404 Evidence

## Scope

Reconciled conversation-history-adjacent provider descriptions without changing
provider names, contexts, gates, data shape, or runtime behavior.

## Verification

- `bun run --cwd packages/core test -- src/features/basic-capabilities/providers/provider-descriptions.test.ts src/features/basic-capabilities/providers/platformContext.test.ts src/features/basic-capabilities/providers/recentMessages.test.ts`
  - Result: 3 files passed, 19 tests passed.
- `bun run --cwd packages/shared build:i18n`
  - Result: generated core/shared validation keyword data needed by typecheck.
- `bun run --cwd packages/cloud/routing build`
  - Result: built linked workspace types needed by core typecheck.
- `bun run --cwd packages/core typecheck`
  - Result: passed.

## Artifact Notes

- Live-LLM trajectory: N/A. Metadata-only provider description cleanup; no model
  routing behavior or prompt assembly logic changed.
- Screenshots/video/native capture: N/A. No UI, device, or runtime view changed.
- Backend logs: N/A. No service execution path changed.

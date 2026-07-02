# Issue #11395 — orphaned onboarding tours cleanup

## Result

Removed the orphaned guided-tour overlay module that was left behind after the
old cloud-frontend onboarding overlay was deleted. The cleanup path was chosen
over re-wiring because current `packages/app` has no consumer for these
cloud-frontend-era tour definitions.

## Human-reviewed evidence

- Removed:
  - `packages/cloud/shared/src/lib/onboarding/tours.ts`
  - `packages/cloud/shared/src/lib/onboarding/types.ts`
- Reference audit:
  - `rg -n "onboarding/tours|ALL_TOURS|getTourById|getTourForPath|OnboardingTour|TourStep|guided.?tour|onboarding-overlay|useTour|APPS_TOUR|AGENTS_TOUR|BILLING_TOUR|API_KEYS_TOUR|MCPS_TOUR" packages plugins -S`
  - After deletion, only unrelated descriptive/comment hits remain:
    - `packages/agent/src/api/builtin-views.ts` view description.
    - `packages/ui/src/components/ui/tooltip-extended.tsx` comment noting old guided-tour helpers were deleted.
- `bun run --cwd packages/cloud/shared typecheck`
  - Passed.

## Validation gaps / non-applicable artifacts

- No screenshots or video: this is dead-code removal for an already-unrendered
  overlay module; no UI surface changed.
- No live model trajectory: no prompt, model, action, provider, or agent
  behavior changed.
- `bun run --cwd packages/cloud/shared lint` is blocked by unrelated existing
  package-wide Biome findings in:
  - `src/db/repositories/__tests__/app-frontend-deployments.test.ts`
  - `src/db/schemas/apps.ts`
  - `src/lib/services/app-charge-requests.ts`
  - `src/lib/services/app-review.ts`
  - `src/lib/services/managed-domains.ts`
  - `src/lib/services/payment-adapters/oxapay.test.ts`
  - `src/lib/services/token-redemption-secure.ts`
- `bun run verify` is blocked before typecheck/lint by unrelated repo-wide
  type-safety ratchet drift:
  - `as unknown as`: `80 current > 77 baseline`.
  - ``?? {}`` in core/agent/app-core: `379 current > 377 baseline`.

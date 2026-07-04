# #11818 PR Domain Model Evidence

Date: 2026-07-03
Branch: `fix/11818-pr-domain-model`

## Scope

Implemented the Cloud-owned PR / press distribution foundation:

- Drizzle schema + migration for `press_releases`, `press_release_distributions`, `press_media_contacts`, and `press_coverage`.
- Repository for release/distribution/contact/coverage persistence.
- Service state machine for `draft -> ready -> submitted -> distributed|failed|cancelled`.
- Validation for required title/body, future embargoes, HTTP(S) assets, idempotent create/submit keys, and organization scoping.

## Verification

- `bun x @biomejs/biome check packages/cloud/shared/src/db/schemas/press-releases.ts packages/cloud/shared/src/db/repositories/press-releases.ts packages/cloud/shared/src/lib/services/press-releases.ts packages/cloud/shared/src/lib/services/__tests__/press-releases.test.ts packages/cloud/shared/src/db/schemas/index.ts packages/cloud/shared/src/db/repositories/index.ts`
  - Result: passed.
- `bun run --cwd packages/cloud/shared typecheck`
  - Result: passed.
- `bun test packages/cloud/shared/src/lib/services/__tests__/press-releases.test.ts`
  - Result: passed, 9 tests.

## DB Artifacts Reviewed

The PGlite test pushes the real Drizzle schemas and inspects rows from:

- `press_releases`
- `press_release_distributions`
- `press_media_contacts`
- `press_coverage`

The final test, `real DB rows are available for reviewer-verifiable evidence`, reads the inserted `press_releases` row and asserts the organization id, status, and body content. Other tests verify distribution rows, coverage upsert idempotency, and tenant-scoped contact listing.

## N/A

- Live provider logs: N/A - #11818 intentionally does not call an external newswire provider. Provider selection and live distribution are split to #11820/#11821.
- Screenshots/video: N/A - backend domain-model slice with no UI surface.
- Real-LLM trajectories: N/A - no model/action/prompt behavior changed in this slice.

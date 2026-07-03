# Issue 11819 Evidence: PR Routes and Actions

## Route group

Implemented the `/api/v1/marketing/pr/*` route group on top of the real
`pressReleaseService` / repository from #11818:

- `GET /api/v1/marketing/pr`
- `POST /api/v1/marketing/pr`
- `GET /api/v1/marketing/pr/:releaseId`
- `PATCH /api/v1/marketing/pr/:releaseId`
- `POST /api/v1/marketing/pr/:releaseId/ready`
- `POST /api/v1/marketing/pr/:releaseId/submit`
- `POST /api/v1/marketing/pr/:releaseId/cancel`
- `GET /api/v1/marketing/pr/:releaseId/coverage`

All routes use `requireUserOrApiKeyWithOrg`, scope reads/writes by
`organization_id`, and reject malformed release IDs before the repository call.

## DTO examples

Create draft:

```json
POST /api/v1/marketing/pr
{
  "title": "Eliza Cloud launches press distribution",
  "body": "Eliza Cloud now supports a press release workflow.",
  "summary": "Launch summary",
  "targetRegions": ["US", "US", "EU"]
}

201
{
  "success": true,
  "release": {
    "id": "<uuid>",
    "title": "Eliza Cloud launches press distribution",
    "status": "draft",
    "target_regions": ["US", "EU"]
  }
}
```

Submit guard without confirmation:

```json
POST /api/v1/marketing/pr/<uuid>/submit
{}

409
{
  "success": false,
  "code": "confirmation_required",
  "confirmationRequired": true
}
```

Confirmed submit with no configured provider:

```json
POST /api/v1/marketing/pr/<uuid>/submit
{ "confirmPaidDistribution": true }

503
{
  "success": false,
  "code": "no_provider_configured",
  "error": "No PR distribution provider is configured. No distribution was submitted and no charge was attempted."
}
```

The no-provider path does not create a `press_release_distributions` row.

## SDK and action surface

SDK:

- Added press release DTO/input/response types in `packages/cloud/sdk/src/types.ts`.
- Added ergonomic `ElizaCloudClient` helpers for create/list/get/update/ready/submit/cancel/coverage.
- Regenerated `packages/cloud/api/src/_router.generated.ts`.
- Regenerated `packages/cloud/sdk/src/public-routes.ts`; the generator now includes the PR route entries and also caught existing stale generated public endpoints.

Plugin actions:

- `CREATE_PRESS_RELEASE_DRAFT`
- `LIST_PRESS_RELEASES`
- `SUBMIT_PRESS_RELEASE`

`SUBMIT_PRESS_RELEASE` resolves by id/title, marks drafts ready before submit,
and never calls the submit API until `confirm: true` is present. No-provider and
provider-not-implemented API failures are surfaced as no-charge failures.

## Verification

```bash
bun run --cwd packages/cloud/api codegen
node packages/cloud/sdk/scripts/generate-public-routes.mjs
bunx @biomejs/biome check packages/cloud/api/v1/marketing/pr packages/cloud/api/__tests__/press-release-routes.integration.test.ts packages/cloud/sdk/src/client.ts packages/cloud/sdk/src/types.ts packages/cloud/sdk/src/public-routes.ts plugins/plugin-cloud-apps/src/actions/press-releases.ts plugins/plugin-cloud-apps/src/index.ts plugins/plugin-cloud-apps/__tests__/helpers.ts plugins/plugin-cloud-apps/__tests__/press-releases.test.ts
bun run --cwd packages/cloud/api typecheck
bun run --cwd packages/cloud/sdk typecheck
(cd /tmp && bun --conditions=eliza-source test /tmp/eliza-develop-bFnZAR/packages/cloud/api/__tests__/press-release-routes.integration.test.ts)
(cd /tmp && bun --conditions=eliza-source test /tmp/eliza-develop-bFnZAR/plugins/plugin-cloud-apps/__tests__/press-releases.test.ts)
```

Route test result: 6 pass, 0 fail, 28 assertions.

Plugin action test result: 6 pass, 0 fail, 17 assertions.

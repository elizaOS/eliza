# Issue #11819 evidence: marketing PR routes + plugin actions

Date: 2026-07-03

## Scope proven

- Added `/api/v1/marketing/pr` route group for create/list/get/update/submit/cancel and coverage list.
- Routes call the #11818 `pressReleaseService` lifecycle and scope every read/write by `organization_id` from `requireUserOrApiKeyWithOrg`.
- Submit fails closed with `503` and `code: "PR_PROVIDER_NOT_CONFIGURED"` before any distribution row is recorded.
- Added typed SDK methods for the route group.
- Added `DRAFT_PRESS_RELEASE`, `LIST_PRESS_RELEASES`, and `SUBMIT_PRESS_RELEASE` actions in `@elizaos/plugin-cloud-apps`.
- `SUBMIT_PRESS_RELEASE` is two-phase: first turn persists a confirmation; only explicit `confirm: true` calls the submit endpoint.

## Route DTO examples

Create draft request:

```json
{
  "title": "Launch draft",
  "body": "Eliza Cloud now exposes press release draft routes.",
  "targetRegions": ["US", "EU"],
  "assets": [
    {
      "url": "https://example.test/press-kit.png",
      "mimeType": "image/png"
    }
  ],
  "idempotencyKey": "release-key_1"
}
```

Create draft response:

```json
{
  "success": true,
  "release": {
    "id": "release_2",
    "organization_id": "org_owner",
    "title": "Launch draft",
    "status": "draft",
    "target_regions": ["US", "EU"]
  }
}
```

Submit guard response:

```json
{
  "success": false,
  "error": "Press distribution provider is not configured",
  "code": "PR_PROVIDER_NOT_CONFIGURED"
}
```

Route log observed in the focused API test:

```text
[Press Release API] submit blocked: provider not configured {
  releaseId: "release_8",
  organizationId: "org_submit",
}
```

## Client/action proof

`DRAFT_PRESS_RELEASE` test proof:

- Validates false with no `ELIZAOS_CLOUD_API_KEY`.
- Calls `client.createPressRelease` with structured `title`, `body`, `summary`, and `targetRegions`.

`LIST_PRESS_RELEASES` test proof:

- Calls `client.listPressReleases`.
- Renders title and status from returned DTOs.

`SUBMIT_PRESS_RELEASE` test proof:

- First ask returns `confirmationRequired: true` and does not call `client.submitPressRelease`.
- Explicit confirm calls submit exactly once with an idempotency key prefixed `press-release-submit-`.
- A `PR_PROVIDER_NOT_CONFIGURED` Cloud error returns `reason: "provider_not_configured"` and `submitted: false`.
- Confirming a different release title returns `reason: "confirm_target_mismatch"` and does not call submit.

## Verification commands

```bash
bun run --cwd packages/cloud/api codegen
bun test --coverage-reporter=lcov packages/cloud/api/v1/marketing/pr/route.test.ts
bun test --coverage-reporter=lcov plugins/plugin-cloud-apps/__tests__/press-releases.test.ts
bun run --cwd packages/cloud/sdk typecheck
bun run --cwd packages/cloud/sdk build
bun run --cwd plugins/plugin-cloud-apps typecheck
bun run --cwd packages/cloud/sdk lint
bun run --cwd plugins/plugin-cloud-apps lint:check
bun run --cwd packages/cloud/api lint
```

`packages/cloud/api typecheck` was also run. It no longer reports errors from the new PR routes, but the package currently fails on an unrelated pre-existing shared provider error:

```text
../shared/src/lib/providers/video/atlascloud-video-generation.ts(163,14): error TS2741:
Property 'getJobStatus' is missing ... but required in type 'VideoProvider'.
```

## N/A rows

- Live newswire/provider distribution: N/A - #11819 is the fail-closed route/action slice. A real provider account/API remains out of scope per #11362.
- Dashboard UI screenshots/video: N/A - this slice uses the existing agent/plugin client surface instead of adding `packages/app` UI.
- Real paid distribution artifact: N/A - submit is intentionally blocked before provider-backed distribution exists.

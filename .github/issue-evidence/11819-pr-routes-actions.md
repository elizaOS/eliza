# #11819 — Cloud marketing PR: `/api/v1/marketing/pr/*` routes

Exposes the press-release workflow (domain model + service from #11818 / #11825)
through real HTTP entry points. This slice ships the **API route group**; the
agent action + dashboard trigger and the provider-backed submit are the
remaining sub-deliverables (the provider itself is the #11362 human dependency).

## Route inventory (all mounted via codegen)

| Method | Path | Handler behavior |
|---|---|---|
| `POST` | `/api/v1/marketing/pr` | Create a draft release (Zod-validated; idempotency-keyed) → `201` |
| `GET` | `/api/v1/marketing/pr` | List the caller-org's releases |
| `GET` | `/api/v1/marketing/pr/:id` | Get one release (org-scoped) → `404` if not owned |
| `PATCH` | `/api/v1/marketing/pr/:id` | Update a **draft** (`404` missing / `409` not-editable) |
| `POST` | `/api/v1/marketing/pr/:id/ready` | `draft → ready` |
| `POST` | `/api/v1/marketing/pr/:id/submit` | **Fail-closed `503`** until a newswire provider is configured |
| `POST` | `/api/v1/marketing/pr/:id/cancel` | Cancel a `draft`/`ready` release |
| `GET` | `/api/v1/marketing/pr/:id/coverage` | List earned coverage (org-scoped) |

Every handler resolves the caller via `requireUserOrApiKeyWithOrg` and passes
`user.organization_id` into `pressReleaseService`; no business logic lives in the
routes. `codegen` mounts all six leaves (639 total, 0 unconverted); `_shared.ts`
carries only the Zod schemas + error→status mapper + the fail-closed provider
gate (no `hono` import, so codegen skips it).

## Fail-closed submit (no fake success)

`resolveNewswireProvider(env)` reads `NEWSWIRE_PROVIDER` defensively — no
provider binding is declared yet, so `submit` verifies ownership + readiness and
then returns `503 { status: "provider_unavailable" }`. It never fabricates a
distribution. `pressReleaseService.recordSubmission` (already in the domain
service) is where a real provider attaches in the follow-up slice.

## Test evidence — real service + real PGlite (only auth stubbed)

`packages/cloud/api/__tests__/marketing-pr-routes.integration.test.ts` builds the
real global middleware chain (`corsMiddleware` + `secureHeaders` + the real
`authMiddleware`) around the real route handlers, driving the real
`pressReleaseService` → repository → **PGlite** (schema applied via `pushSchema`).
Only `requireUserOrApiKeyWithOrg` is mocked (maps a `Bearer eliza_*` token to a
seeded org/user); nothing under test is stubbed.

```
$ bun test packages/cloud/api/__tests__/marketing-pr-routes.integration.test.ts
 17 pass
 0 fail
Ran 17 tests across 1 file.
```

Covered:
- **auth**: no bearer → `401`.
- **create/list**: create → `draft`, appears in the owning org's list; empty
  title/body → `400`; past embargo → `400` (service validation); idempotency key
  returns the same release, never duplicates.
- **state machine**: `PATCH` a draft → `200`; `POST /ready` → `ready`; `PATCH`
  a ready release → `409`; `submit` on `ready` → `503 provider_unavailable`;
  `submit` on a draft → `409`; `cancel` a draft → `cancelled`; coverage list `[]`.
- **multi-tenant isolation** (the security bar): org B gets `404` on org A's
  release for GET/PATCH/ready/cancel/submit/coverage, org A's release is never
  mutated by org B, and org A's release never appears in org B's list.

## Verification

```
bun run --cwd packages/cloud/api typecheck   # no errors in the new files
bunx @biomejs/biome check <new files>        # clean
bun run --cwd packages/cloud/api codegen     # 639 mounted, 0 unconverted
```

## Scope / N/A

- **Agent action (`plugins/plugin-cloud-apps`) + dashboard trigger**: separate
  sub-deliverables of #11819 — not in this PR. The routes are the real entry
  points those will call; the agent is the "client trigger" that follows.
- **Live provider distribution evidence**: N/A — no newswire provider is selected
  (#11362 human dependency); submit is intentionally fail-closed here.
- **Live-LLM trajectory**: N/A — these are deterministic CRUD/state routes with no
  model call; proven end-to-end against real PGlite instead.

# LEG W3 — cloud dashboard UI: managed frontend hosting tab (#10690 + #10725)

Branch: `feat/ui-mobile-gap-burndown` @ develop `5471346e7a6`. Date: 2026-07-02.

## Research inventory (verified against worktree tip before coding)

### The gap (#10690, architecture rule 10)

The managed frontend-hosting endpoints exist server-side with NO human UI trigger —
only the agent action + `@elizaos/cloud-sdk` (`packages/cloud/sdk/src/client.ts:815-852`)
call them:

| Endpoint | File | UI trigger before this leg |
| --- | --- | --- |
| `GET  /api/v1/apps/:id/frontend` (list + active id) | `packages/cloud/api/v1/apps/[id]/frontend/route.ts` | none |
| `POST /api/v1/apps/:id/frontend` (publish bundle) | same | none |
| `POST /api/v1/apps/:id/frontend/:deploymentId/activate` (activate = rollback primitive) | `.../[deploymentId]/activate/route.ts` | none |
| `GET/DELETE /api/v1/apps/:id/frontend/:deploymentId` | `.../[deploymentId]/route.ts` | none |
| `GET /api/v1/apps/:id/frontend/preview[/*]?deployment=` (owner preview) | `.../preview/[[...path]]/route.ts` | none |

Verified: `grep -rn "frontend" packages/ui/src/cloud --include='*.ts*'` returns zero hits
under `applications/` before this change — the Applications detail page
(`packages/ui/src/cloud/applications/components/app-details-tabs.tsx`) had 8 tabs
(overview/monetize/earnings/domains/analytics/promote/users/settings), none touching
managed hosting. `gh`-level re-verify: no open PR titled for #10690 frontend-hosting UI
on this surface at leg start.

### Server contract facts (read from source, not docs)

- Deployment DTO = drizzle row of `app_frontend_deployments`
  (`packages/cloud/shared/src/db/schemas/app-frontend-deployments.ts`): snake_case
  fields `id, app_id, version, status, r2_prefix, manifest, content_hash, file_count,
  total_bytes, build_meta, error, created_at, updated_at, finalized_at, activated_at`.
  Status lifecycle: `pending|uploading|ready|active|superseded|failed`; exactly one
  `active` per app; activating an older one IS the rollback.
- List response: `{ success, active_deployment_id, deployments }`, ordered
  `version DESC`, limit 50 (`app-frontend-deployments.ts` repo `listByApp`).
- Publish body: `{ files: [{path, content, encoding?: "utf8"|"base64", contentType?}],
  entrypoint?, spaFallback?, activate?, buildMeta? }` — 1..2000 files; limits
  25 MiB total / 10 MiB per file (`frontendHostingLimits`, service line 89). Server
  infers contentType from extension when omitted.
- Delete of the ACTIVE deployment → 409 `"Cannot delete the active deployment;
  activate another first"`.
- Auth: `requireUserOrApiKeyWithOrg` — accepts `Bearer eliza_*` API key or steward
  session; cross-org → 403.
- Mock stack (`bun run cloud:mock` → `scripts/cloud/mock-stack-up.mjs`): cloud-api dev
  server is `packages/scripts/cloud/admin/dev/cloud-api-hono-dev.ts` with an in-memory
  R2 `BLOB` binding (line 62) — so publish/serve work locally with zero Cloudflare.
  SIWE (`/api/auth/siwe/nonce` + `/verify`) issues a real `eliza_*` API key against
  PGlite → headless auth works on the mock stack.

### UI conventions followed (from siblings in the same directory)

- API access through the typed `api<T>` client (`packages/ui/src/cloud/lib/api-client.ts`);
  never bare fetch (BuyDomainCard/app-domains precedent).
- i18n via `useCloudT()(key, { defaultValue })`; new literal keys must exist in all 8
  locale files (`packages/scripts/check-i18n.mjs` is strict both directions).
- Primitives from `components/ui/*` only; `default` Button variant is the orange
  accent (`bg-accent … hover:bg-accent-hover`) — no blue, no orange→black hover.
- Component tests: jsdom + `vi.mock` of ONLY the `api-client` seam
  (BuyDomainCard.test.tsx pattern) run in the default vitest lane
  (`packages/ui/vitest.config.ts` includes `src/**/*.test.tsx`).
- Heavy/real-stack flows live under `src/**/__e2e__/**` and run via
  `bun run --cwd packages/ui test:slow` (`vitest.e2e.config.ts`, 15 min cap).

### #10725 tail scope

The only cloud page touched is the Applications detail page (new Hosting tab +
tab-bar wiring). Slop pass + verdicts + cloud-active/cloud-inactive captures recorded
in `manual-review/` here (the legacy `audit:cloud` runner died with
`packages/cloud-frontend` (#9093); the equivalent for app-hosted cloud pages is a
manual capture against the dev UI + mock stack, which is what this leg does).

## Implemented

1. `packages/ui/src/cloud/applications/lib/frontend-hosting.ts` — typed lib:
   `listFrontendDeployments`, `publishFrontendBundle`, `activateFrontendDeployment`,
   `deleteFrontendDeployment`, `frontendPreviewPath`, `FRONTEND_BUNDLE_LIMITS`,
   `stripCommonRootDir`, and `filesToBundle` (browser File[] → base64 bundle
   entries, common-root stripping for folder uploads, client-side limit checks
   mirroring the server's authoritative ones).
2. `packages/ui/src/cloud/applications/components/app-frontend-hosting.tsx` — the
   Hosting tab: folder/file upload → publish(+optional activate), deployments list
   with status/version/files/bytes/date, per-row Activate/Roll back with confirm
   dialog, Delete (hidden on the active row; server 409 surfaced when a race makes
   it active anyway), owner Preview links, loading/error(retry)/empty states.
   Minimal-eliza aesthetic: flat sections + divide-y rows, zero card chrome,
   accent orange only.
3. `packages/ui/src/cloud/applications/components/app-details-tabs.tsx` — 9th tab
   `hosting` wired into the tab router (`?tab=hosting` deep-linkable); grid steps
   to `sm:grid-cols-3 xl:grid-cols-9`.
4. Locale keys (`cloud.appHosting.*` ×35 + `cloud.apps.tab.hosting`) in all 8
   locales; `packages/scripts/check-i18n.mjs` reports zero issues for these keys
   (its remaining failures are pre-existing keys owned elsewhere).
5. Tests (all green, see `logs/`):
   - `components/app-frontend-hosting.test.tsx` — 17 tests in the DEFAULT CI
     vitest lane (`packages/ui` `test`): list/live-badge/delete-guard rendering,
     empty state, load error + Retry recovery, publish payload shape
     (base64 + activate flag + buildMeta), activate-off publish, server publish
     failure keeps selection, rollback labeling + confirm flow, delete + 409
     message surfacing, failed-row error display, plus `filesToBundle` /
     `stripCommonRootDir` unit coverage incl. all four limit violations.
   - `__e2e__/frontend-hosting.mockstack.test.tsx` — 6 tests in the `test:e2e`
     (`test:slow`) lane against the REAL mock cloud stack: boots the actual
     cloud-api Hono graph (PGlite + MOCK_REDIS + in-memory R2 + local KMS) on
     port 36312, real headless SIWE (viem-signed) → real `eliza_*` key row,
     real app row, then drives the REAL component tree (real CloudI18nProvider +
     real cloud api-client; only a relative-URL→live-server fetch shim) through
     empty → publish v1 → publish v2 → rollback via dialog → out-of-band
     activation race → real 409 delete refusal → real delete → owner preview
     serving the actual stored bytes. Server state cross-asserted over raw HTTP
     at each step.
6. `__e2e__/frontend-hosting-fixture.tsx` + `__e2e__/run-frontend-hosting-e2e.mjs`
   — real-browser visual e2e (headless Chromium + real Tailwind v4 CSS compiled
   from the actual sources + the same real mock cloud stack on ports 36313/36314):
   drives the full lifecycle with real pixels and enforces the #10725 rules as
   executable assertions — zero blue computed colors page-wide, Publish button
   rest `rgb(255,138,36)` (accent orange) → hover `rgb(229,79,0)` (darker orange,
   never orange→black). Produces the screenshots + walkthrough video below.
   Run: `bun src/cloud/applications/__e2e__/run-frontend-hosting-e2e.mjs`
   (from `packages/ui`).

## Verification (2026-07-02)

- `packages/ui` typecheck: clean for every file in this leg (the only workspace
  errors are in `src/components/composites/__e2e__/resize-handles.e2e.test.ts`,
  owned by the W2 leg).
- Biome `check` clean on all touched/added files.
- Component lane: 17/17 pass. Mock-stack e2e lane: 6/6 pass. Visual e2e: ALL
  GREEN (13 screenshots + video + RESULT.json).

## Defect found (server-side, outside this leg's ownership — do not fix in UI)

On the local mock stack, DB-defaulted timestamps come back TZ-skewed:
`created_at` (schema `defaultNow()`) arrived as `2026-07-02T03:05:07.591Z`
while `activated_at` (set in JS) was correctly `2026-07-02T08:05:07.618Z` in
the same row at the same instant (see `logs/mockstack-smoke.log`). That is why
screenshots show "about 5 hours ago" on a just-published deployment. Root
cause is in the `packages/cloud/shared` schema/PGlite harness timestamp
handling; the UI renders the wire value faithfully (clients display, never
compute). Production Workers run UTC, so the skew is a local-harness artifact,
but any local-dev cloud page showing relative times inherits it.

## Evidence files

- `manual-review/` — per-page verdict markdowns (#10725); both pages `good`.
- `screenshots/01…13-*.png` — desktop + mobile; rest/hover/dialog states;
  cloud-active AND cloud-inactive (API unreachable → error + Retry → recovery).
- `walkthrough.webm` — full-flow video from the visual e2e run.
- `logs/mockstack-smoke.mjs` + `.log` — standalone endpoint-lifecycle
  reproduction against the mock stack (SIWE → publish ×2 → rollback → 409 →
  delete → preview), including the raw JSON behind the timestamp defect.
- `logs/mockstack-e2e-run.log` — jsdom mock-stack e2e transcript (6/6).
- `logs/visual-e2e-run.log` — visual e2e transcript (all assertions green).

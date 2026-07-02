# Issue #11340 Evidence - Agent-First Cloud Experience Plan

Date: 2026-07-02
Branch: `docs/11340-agent-first-cloud-experience`

## What Changed

- Added `packages/cloud/AGENT_FIRST_EXPERIENCE.md`, a screen-by-screen
  agent-first Cloud plan covering setup, hosted/local ownership, entry points,
  and surface consolidation targets.
- Updated `packages/skills/skills/eliza-cloud/references/app-platform-lifecycle.md`
  so agents use the current managed frontend hosting contract instead of the
  obsolete "not yet first-class" guidance.
- Updated `packages/cloud/APP_PLATFORM_REVIEW.md` where it still described
  managed frontend hosting as future work.

## Sources Reviewed

- `packages/ui/src/cloud/shell/CloudRouterShell.tsx`
- `packages/ui/src/cloud/register-all.ts`
- `packages/ui/src/cloud/applications/index.ts`
- `packages/ui/src/components/pages/launcher-curation.ts`
- `packages/app/src/cloud-apps-view.ts`
- `packages/app/src/main.tsx`
- `packages/app/vite.config.ts`
- `packages/app/functions/_proxy.ts`
- `packages/app/wrangler.toml`
- `packages/cloud/api/v1/apps/[id]/frontend/route.ts`
- `packages/cloud/api/v1/apps/[id]/frontend/[deploymentId]/route.ts`
- `packages/cloud/api/v1/apps/[id]/frontend/[deploymentId]/activate/route.ts`
- `packages/cloud/api/v1/apps/[id]/frontend/preview/[[...path]]/route.ts`
- `packages/cloud/api/v1/hosted-frontend/serve/[[...path]]/route.ts`
- `packages/cloud/shared/src/lib/services/app-frontend-hosting.ts`
- `packages/skills/skills/eliza-cloud/SKILL.md`

## Manual Review

- Confirmed `cloud-apps` is hidden when `cloudActive` is false.
- Confirmed native/desktop uses `cloud-apps-view` and web uses
  `CloudRouterShell`.
- Confirmed `packages/cloud-frontend` is deleted and `packages/app` is the
  single hosted web build/proxy.
- Confirmed managed frontend publish, list, preview, detail, delete, activate,
  public serve, SEO injection, page-view beacon, server-side page-view record,
  and synthesized `robots.txt`/`sitemap.xml` paths exist.

## Verification

- `ELIZA_SKIP_ARTIFACT_SYNC=1 bun run install:light` - pass.
- `git diff --check` - pass.
- Stale-phrase scan - pass:
  `rg -n "does not yet have first-class managed frontend hosting|Until managed frontend hosting lands|Do not claim Cloud can upload|largest missing seam|missing managed-frontend host" ...`
  returned no matches in the touched docs.
- Required-reference scan - pass: verified the new docs mention `cloud-apps`,
  `CloudRouterShell`, `/dashboard/apps`, `/app-auth/authorize`,
  `POST /api/v1/apps/:id/frontend`, hosted frontend serve paths,
  `settings#billing`, and `packages/cloud-frontend`.
- `bun run verify` - fails at the existing repo-wide type-safety ratchet before
  lint/typecheck:
  - `as unknown as: 80 / 77`
  - core/agent/app-core `?? {}`: `379 / 377`

## Not Applicable

- Screenshots/video: N/A - documentation-only change; no UI behavior changed.
- Backend/frontend logs: N/A - documentation-only change; no runtime path
  changed.
- Real-LLM trajectory: N/A - no model/action/provider behavior changed.
- DB/domain/money artifacts: N/A - no database, domain, billing, payout, or
  payment behavior changed.

# Legacy / Deprecated Cleanup Audit

Branch: `chore/quality-legacy`
Date: 2026-04-17

## What I changed

### 1. Removed dead deprecated alias
- Deleted `_resolveTenantForUser` from `packages/api/src/routes/auth.ts`
- It was marked `@deprecated` and had no remaining callers

### 2. Consolidated dashboard approvals onto the current tenant-level API
- Updated `web/src/app/dashboard/approvals/page.tsx`
- Removed the old per-agent fanout over:
  - `GET /vault/:agentId/pending`
  - `POST /vault/:agentId/approve/:txId`
  - `POST /vault/:agentId/reject/:txId`
- Switched the dashboard to the current tenant-level approval flow:
  - `GET /approvals`
  - `POST /approvals/:txId/approve`
  - `POST /approvals/:txId/deny`
- This removes one duplicated approvals path in the dashboard and lines up the UI with the newer SDK/backend shape

### 3. Removed obsolete approval helpers from the dashboard inline client
- Replaced the old `getPending/approve/reject` helpers in `web/src/lib/steward-client.ts`
- Added `listApprovals/approveTransaction/denyTransaction` instead
- Result: the web client now has one approvals path instead of carrying both styles for the dashboard

## Counts
- Deprecated aliases removed: 1
- Legacy dashboard approval flow removed: 1
- Obsolete inline client methods removed: 3
- New current-path inline client methods added: 3

## High-confidence reasons
- `_resolveTenantForUser` had zero callers
- The dashboard was already flagged in `REVIEW-FRONTEND.md` as using the old pending/approve/reject path
- The tenant-level approvals API and SDK support already exist in-repo
- Changes were limited to internal web UI plumbing, not published SDK/React package compat surfaces

## Deferred / risky items not removed

### Kept old vault approval endpoints
I did **not** remove backend routes under `/vault/:agentId/pending|approve|reject`.
Reasons:
- Docs still reference them
- `packages/examples/waifu-integration` still calls them directly
- Tests still cover them
- Removing them would be a behavior change beyond a high-confidence internal cleanup

### Kept legacy wallet/key fallbacks in vault
I did **not** touch legacy key resolution in `packages/vault/src/vault.ts`.
Reasons:
- Comments and code indicate these are live migration/backward-compat paths for old agent data shapes
- Task explicitly said not to remove migration code for live data shapes

### Kept auth-provider compatibility shim
I did **not** remove the broader `web/src/components/auth-provider.tsx` shim.
Reasons:
- It still feeds `address`, `tenant`, and `signOut` to active dashboard UI
- The no-op compatibility members look suspicious, but removing them without a full call-site sweep felt lower confidence than this pass

## Validation
- `git diff --check` passed
- TypeScript project-wide checks could not be completed in this worktree because local type/dependency setup is incomplete in this environment, including missing Node/web typings and some frontend package type declarations

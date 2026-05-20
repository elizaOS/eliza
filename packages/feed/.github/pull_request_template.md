<!--
Feed PR template

Goal: make PRs easy to review + easy to ship.
- Prefer small, focused PRs (one theme). Avoid catch‑all PRs.
- Keep app-layer thin and portable (validate → service → map errors).
- Put domain logic in packages (framework-agnostic), not in Next handlers/components.
- Match the active release branch. Recent fixes/hotfixes usually target `production`; use `staging` when intentionally batching work ahead of release.
- Before requesting review, run the relevant checks (see "Test plan").
-->

## Summary
<!-- 1–3 bullets: what changed + why (user impact / business goal). -->

- …

## Type
<!-- Helps triage + release notes. -->

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor / cleanup (no behavior change)
- [ ] Performance
- [ ] Infra / ops
- [ ] Docs
- [ ] Contracts / on-chain
- [ ] Other: …

## Context / Links
<!-- Link Linear, Sentry, docs, prior PRs, and anything reviewers need for context. -->

- …

## Scope (keep it focused)
<!-- If you had to touch multiple areas, explain why and what you intentionally left out. -->

- [ ] This PR is focused on a single change/theme (not a catch‑all)
- [ ] Drive‑by refactors are excluded or split into a separate PR
- [ ] Non‑goals / follow‑ups are listed below (with links)

**Areas touched**
- [ ] Web UI (`apps/web`)
- [ ] Web API routes / SSE / A2A (`apps/web`)
- [ ] CLI (`apps/cli`)
- [ ] Vendor docs (`docs/vendors/*`)
- [ ] Domain / game engine (`packages/engine`, `packages/core/*`)
- [ ] Agents / runtime / A2A / MCP (`packages/agents`, `packages/a2a`, `packages/mcp`)
- [ ] API infra (`packages/api`)
- [ ] DB (`packages/db`)
- [ ] Contracts / on-chain (`packages/contracts`)
- [ ] Shared types/utils (`packages/shared`)
- [ ] Tests (`packages/testing`)
- [ ] Other: …

## Non-goals / follow-ups
<!-- Optional but encouraged when you're intentionally leaving adjacent work out. -->

- None.

## Changes
<!-- List the notable changes (what is new/removed/modified). Link key files if it helps. -->

- …

## Review guide
<!-- Help reviewers go fast: where to start, what to ignore, tricky bits, key decisions. -->

**Start here**
- `…`

**Risk**
- [ ] Low
- [ ] Medium
- [ ] High

**Notes for reviewers**
- …

## Test plan
<!-- Tick broad repo checks you actually ran. If you only ran focused checks, leave these unchecked and list the exact commands below. -->

**Commands run**
- [ ] `bun run check` (Biome `check --write .`)
- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] `bun run test` (unit + integration)
- [ ] `bun run test:e2e` (if critical flows changed)
- [ ] `bun run contracts:test` (if contracts changed)
- [ ] `bun run db:check` (if DB schema/queries changed)

**Focused verification / manual verification**
1. Exact commands actually run (targeted tests, focused biome checks, scoped typechecks, etc.).
2. Any attempted checks that currently fail for unrelated pre-existing reasons.
3. Browser/demo steps for user-facing changes.

## Ops / Migration / Deployment
<!-- Anything that impacts deploys, data, cron, config, or rollouts. -->

- [ ] No deploy impact
- [ ] Requires env var updates (listed below + `.env.example` updated)
- [ ] Requires DB migration (`bun run db:migrate`) / backfill / seed
- [ ] Changes cron schedule or endpoints (`vercel.json`, `CRON_SECRET`, etc.)
- [ ] Rollout behind a flag / gradual rollout

**Env vars (added/changed/removed)**
- Added: `None`
- Changed: `None`
- Removed: `None`

**DB / data migration**
- Migration(s): `None`
- Backfill/seed: `None`

**Rollout / rollback plan**
- Rollout: …
- Rollback: …

## Breaking changes

- [ ] None
- [ ] Yes (describe + migration guide below)

**Migration guide**
- None.

## Security / privacy
<!-- Authn/authz, secrets handling, PII, prompt injection surfaces, etc. -->

- [ ] No security impact
- [ ] Needs extra review (describe)

<details>
<summary>Area-specific notes (expand if relevant)</summary>

### API / contracts between services
<!-- New/changed endpoints, SSE event payloads, shared types. -->
- None.

### Database
<!-- Tables/columns/indexes, perf implications, how to verify. -->
- None.

### Contracts / on-chain
<!-- Network(s), addresses, upgrade/migration notes, how to verify. -->
- None.

### Docs
<!-- If you touched generated vendor docs, regenerate via `bun run docs:generate`. -->
- None.

</details>

## Screenshots / recordings (UI)
<!--
⚠️ REQUIRED SECTION - Do not leave empty.

Choose ONE of the following:

1. **If visual changes exist**: Add screenshots (before/after) or a short recording.
   - For recordings: describe the "demo script" (what to show, user flow, expected behavior).
   - For screenshots: describe what the screenshot demonstrates.

2. **If no visual changes**: Explain WHY a screenshot/recording is not relevant.
   Examples:
   - "Backend-only change, no UI impact"
   - "Refactor with no behavior change"
   - "API route change, not user-facing"
-->

<!-- Delete the option that doesn't apply: -->

### Option A: Visual demo

| Feature | Before | After |
|---------|--------|-------|
| … | … | … |

*Demo script (for recording):*
1. …

### Option B: No visual changes

- Reason: …

## Checklist (author)
- [ ] Self-review done (diff + critical paths)
- [ ] Base branch is correct for the release path (`production` for most live fixes, `staging` when batching)
- [ ] Handlers remain thin and portable (validate → service → map errors)
- [ ] Domain logic stays in packages (no Next/React/Elysia coupling in core)
- [ ] `.env.example` updated (if env changed) and variables documented above
- [ ] Docs updated (and `bun run docs:generate` if needed)
- [ ] Tests added/updated for behavior changes (or rationale provided)
- [ ] Dependency changes are intentional (`bun.lock` updated)
- [ ] Code owners requested (auto via CODEOWNERS or manual)
- [ ] **Screenshots/recordings section filled** (visual demo OR explanation why N/A)

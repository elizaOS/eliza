# ERC-8004 + Feature Sprint Plan

**Date:** 2026-04-11
**Goal:** Integrate ERC-8004 agent identity, build standalone APIs, tenant self-service

---

## Worker Q — Research: ERC-8004 Integration Architecture
**Type:** Research + design doc (no code)
**Branch:** `docs/erc8004-architecture`

**Tasks:**
1. Read the full ERC-8004 spec (eips.ethereum.org/EIPS/eip-8004)
2. Read Chitin Protocol SDK docs (chitin.id, @chitin-id/sdk)
3. Analyze the 3 registries: Identity, Reputation, Validation
4. Map how each integrates with steward:
   - Identity: mint ERC-8004 NFT when agent is created in steward
   - Reputation: read reputation scores, use in policy decisions
   - Validation: record steward policy evaluations as validation evidence
5. Design the integration:
   - Which chain? (Base L2, matching steward's existing chain)
   - How does registration work? (on agent creation? manual? both?)
   - How do reputation scores affect policies? (dynamic policy thresholds?)
   - What's the agentURI schema for steward agents?
   - How does cross-platform trust work? (agent on steward can be verified by other platforms)
6. Identify contracts to interact with (deployed addresses on Base)
7. Write `docs/erc8004-integration.md` with:
   - Architecture diagram
   - API design (new endpoints)
   - Contract interaction plan
   - Migration plan (existing agents → ERC-8004 registration)
   - Competitive analysis (how other platforms use ERC-8004)

---

## Worker R — Standalone Policies API
**Branch:** `feat/policies-api`
**Package:** `packages/api/`

**Tasks:**
1. Create `packages/api/src/routes/policies-standalone.ts`:
   - `GET /policies` — list all policies for the authenticated user's tenant
   - `POST /policies` — create a policy (name, description, rules, scope)
   - `GET /policies/:id` — get single policy
   - `PUT /policies/:id` — update policy
   - `DELETE /policies/:id` — delete policy
   - `POST /policies/:id/assign` — assign policy to agent(s)
   - `POST /policies/simulate` — simulate a policy against a mock transaction

2. Schema: add `standalone_policies` table (or reuse existing policies with tenant-level scope):
   - id, tenantId, name, description, rules (JSON), scope (global/per-agent), createdAt, updatedAt

3. Mount at `/policies` in index.ts with tenant auth middleware

4. Wire dashboard steward-client.ts to use real endpoints (remove stubs)

---

## Worker S — Audit API
**Branch:** `feat/audit-api`
**Package:** `packages/api/`

**Tasks:**
1. Create `packages/api/src/routes/audit.ts`:
   - `GET /audit/log` — paginated audit log (query: agentId, action, dateRange, page, limit)
   - `GET /audit/summary` — aggregate stats (tx count by status, top agents, policy violations)

2. Build from existing data:
   - Transactions table already has all signing events
   - Policy evaluation results are in transaction records
   - Proxy audit_log table has API proxy events

3. Mount at `/audit` with tenant auth

4. Wire dashboard steward-client.ts audit methods (remove stubs)

---

## Worker T — Tenant Self-Service Dashboard
**Branch:** `feat/tenant-self-service`
**Package:** `web/`

**Tasks:**
1. Add "Create Tenant" flow to dashboard:
   - New page: `/dashboard/tenants` — list user's tenants
   - "Create Tenant" button → form: name, description
   - Calls `POST /platform/tenants` (or new user-facing endpoint)
   - Shows tenant ID + API key after creation

2. Tenant settings page:
   - CORS origins configuration
   - Default policy templates
   - API key display (masked) + rotation
   - Webhook configuration per tenant

3. Member management:
   - Invite by email
   - List members + roles
   - Remove / change roles
   - Uses `/platform/tenants/:id/members` APIs (already built)

4. Tenant switcher:
   - Uses `<StewardTenantPicker />` from @stwd/react
   - Switch between tenants in the dashboard

---

## Worker U — GHCR Docker Fix + Release Pipeline
**Branch:** `fix/ghcr-release`

**Tasks:**
1. Fix Docker workflow GHCR permissions
2. Test image push to ghcr.io/steward-fi/steward
3. Add NPM_TOKEN secret setup instructions
4. Test release workflow with a dry run
5. Document the release process in CONTRIBUTING.md

---

## Dependency Graph

```
Wave 1 (all parallel):
  Worker Q (ERC-8004 research)    — no deps, pure research
  Worker R (Policies API)         — no deps, pure API
  Worker S (Audit API)            — no deps, pure API  
  Worker T (Tenant self-service)  — no deps, pure frontend
  Worker U (GHCR fix)             — no deps, pure CI

Wave 2 (after Q completes):
  Worker V — ERC-8004 SDK integration (@stwd/sdk)
  Worker W — ERC-8004 API endpoints (register, reputation, validate)
  Worker X — Smart contract interaction layer
```

All Wave 1 workers are independent and can run in parallel.

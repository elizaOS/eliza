# Types Consolidation Audit

## Summary
- Duplicate type sets found: 4
- Consolidated: 2
- Deferred: 2

## Findings

### 1. SDK auth exchange payload repeated inline
- Locations: `packages/sdk/src/auth.ts`
- Pattern: the passkey login verify, passkey register verify, email verify, and OAuth token exchange flows each declare near-identical inline response payloads.
- Recommendation: extract a shared auth exchange response type into `packages/sdk/src/auth-types.ts` and reuse it in `auth.ts`.
- Confidence: high

### 2. React auth metadata duplicates SDK auth metadata
- Locations: `packages/react/src/types.ts`, `packages/sdk/src/auth-types.ts`
- Pattern: `StewardTenantMembership` and `StewardProvidersState` in React match `StewardTenantMembership` and `StewardProviders` in the SDK.
- Recommendation: re-export / alias the SDK types from React instead of maintaining duplicate local declarations.
- Confidence: high

### 3. Shared core domain types duplicated in SDK
- Locations: `packages/shared/src/index.ts`, `packages/sdk/src/types.ts`
- Pattern: `AgentIdentity`, `PolicyRule`, `TxRecord`, chain metadata/constants, webhook types, and several control-plane types overlap heavily.
- Recommendation: eventually decide whether SDK should depend on `@stwd/shared` or intentionally remain self-contained. Consolidation is valuable but package-boundary changes need broader review.
- Confidence: medium

### 4. React control-plane types drift from shared control-plane types
- Locations: `packages/react/src/types.ts`, `packages/shared/src/index.ts`
- Pattern: `PolicyTemplate`, `CustomizableField`, `SecretRoutePreset`, `ApprovalConfig`, `TenantTheme`, `TenantFeatureFlags`, and `AgentDashboardResponse` are parallel but not identical.
- Recommendation: normalize naming and optionality first, then consolidate through a shared contract package or SDK export surface.
- Confidence: medium

## Consolidations applied

### 1. StewardAuthExchangeResponse
- Was: inline auth exchange payloads repeated in `packages/sdk/src/auth.ts`
- Now: exported from `packages/sdk/src/auth-types.ts` and re-exported by `packages/sdk/src/index.ts`
- Callers updated: 4
- Reasoning: the passkey, email, and OAuth session-exchange flows all shared the same payload contract, so extracting one named type removes duplicated inline declarations without changing behavior.

### 2. StewardTenantMembership / StewardProvidersState
- Was: duplicated in `packages/react/src/types.ts` and `packages/sdk/src/auth-types.ts`
- Now: React re-exports `StewardTenantMembership` directly from `@stwd/sdk`, and aliases SDK `StewardProviders` as `StewardProvidersState`
- Callers updated: type-only consumers in `packages/react/src/types.ts`
- Reasoning: these were exact duplicates already present in the SDK surface, so aliasing them is low-risk and prevents drift.

## Deferred
- `packages/shared` ↔ `packages/sdk` full type unification, deferred because `@stwd/sdk` currently publishes standalone types and does not depend on `@stwd/shared`.
- `packages/shared` ↔ `packages/react` control-plane unification, deferred because the shapes currently differ in field names and optionality.

## Files changed
- `QUALITY_AUDIT.md`
- `packages/sdk/src/auth-types.ts`
- `packages/sdk/src/auth.ts`
- `packages/sdk/src/index.ts`
- `packages/react/src/types.ts`

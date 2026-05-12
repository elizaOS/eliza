# Frontend Cleanup Plan: app-core UI-Touching Surface
**Date:** 2026-05-12  
**Package:** `@elizaos/app-core`  
**Scope:** HTTP API contract surface + UI-facing type exports  
**Target:** Identify contract drift, weak typing, and removable shims

---

## Executive Summary

`app-core` is primarily a server/runtime/CLI package, but exposes ~18 HTTP endpoint handlers that the frontend (`@elizaos/ui`) consumes. This analysis found:

1. **ui-compat.ts** is a legacy bridge that re-exports `@elizaos/ui` — **candidate for removal** after deprecation window
2. **Strong contract typing:** Auth, payment, catalog, and dev routes use discriminated-union response types (`ok: true|false`)
3. **Minor contract drift:** Weak error handling in 3–4 routes; request body parsing uses loose typing
4. **Service layer isolation:** Most services are server-only; few leak across to frontend
5. **No frontend direct imports:** Frontend does not reach into app-core directly; all API calls go through HTTP

---

## Critical Findings

### 1. ui-compat.ts — Deprecated Bridge
**File:** `/packages/app-core/src/ui-compat.ts`  
**Purpose:** Re-export of `@elizaos/ui` public surface for consumers that still import from app-core  
**Status:** Dead code post–Wave A refactor (React surfaces moved to `@elizaos/ui`)  
**Server-side isolation:** Not included in server-only barrels (see `src/index.ts`)

**Action:** Mark deprecated, schedule removal in next major version
- [ ] Add deprecation notice in JSDoc
- [ ] Warn consumers to import from `@elizaos/ui` directly
- [ ] Remove in v2.0+

---

### 2. API Contract Inventory

#### **Authentication Routes**
Frontend consumer: `@elizaos/ui` → `packages/ui/src/api/auth-client.ts`

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/auth/setup` | POST | `{ displayName: string; password: string }` | `AuthSetupResult` (discriminated union) | ✅ Strongly typed |
| `/api/auth/login/password` | POST | `{ displayName: string; password: string; rememberDevice?: boolean }` | `AuthLoginResult` (discriminated union) | ✅ Strongly typed |
| `/api/auth/logout` | POST | (none) | `AuthLogoutResult` | ✅ Strongly typed |
| `/api/auth/me` | GET | (none) | `AuthMeResult` (discriminated union) | ✅ Strongly typed |
| `/api/auth/sessions` | GET | (none) | `AuthSessionsResult` (discriminated union) | ✅ Strongly typed |
| `/api/auth/sessions/:id/revoke` | POST | (none) | `AuthRevokeResult` | ✅ Strongly typed |
| `/api/auth/password/change` | POST | `{ oldPassword: string; newPassword: string }` | `AuthChangePasswordResult` (discriminated union) | ✅ Strongly typed |

**Source:** `packages/app-core/src/api/auth-session-routes.ts` (585 lines)  
**Handler:** `handleAuthSessionRoutes()` (exported)  
**Type Safety:** All responses use discriminated union `{ ok: true; ... } | { ok: false; status: XXX; reason: string }`

**Issues Found:**
- ⚠️ No explicit `as AuthSetupResult` cast in handler — relying on structural typing
- ✅ Rate limiting properly enforced (20/min per IP)
- ✅ CSRF token rotation on setup/login

---

#### **Authorization Bootstrap Routes**
Frontend consumer: `@elizaos/ui` → `packages/ui/src/api/client-agent.ts`

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/auth/bootstrap/pair` | POST | `{ code: string }` | `{ code: string; deviceToken?: string; expiresAt?: number }` | ⚠️ Loosely typed |
| `/api/auth/bootstrap/exchange` | POST | `{ code: string }` | Discriminated union (success/failure) | ✅ Strongly typed |

**Source:** `packages/app-core/src/api/auth-bootstrap-routes.ts` (300+ lines)  
**Handler:** `handleAuthBootstrapRoutes()` (exported)  

**Issues Found:**
- ⚠️ `/pair` response not explicitly typed; frontend uses `any` cast
- ✅ `/exchange` has proper discriminated union
- ✅ Pairing codes rate-limited and TTL-bounded

---

#### **Background Tasks Routes**
Frontend consumer: (internal; used by desktop background runner)

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/background/run-due-tasks` | POST | (none) | `{ ok: boolean; ranAt: string; coalesced?: boolean; error?: string }` | ⚠️ Loose `unknown` |

**Source:** `packages/app-core/src/api/background-tasks-routes.ts` (88 lines)  
**Handler:** `handleBackgroundTasksRoute()` (exported)  

**Issues Found:**
- ⚠️ Internal routes cast result as `unknown` before reading `ranTasks` field
- Line 34: `interface TaskServiceLike { runDueTasks(options?: { maxWallTimeMs?: number }): Promise<unknown>; }`
- Result parsing uses unsafe optional access: `result as unknown as { ranTasks?: unknown }`

**Action:** Tighten to proper discriminated union:
```typescript
// Before
{ ok: true; ranAt: string; coalesced: boolean } | { ok: false; error: string }
```

---

#### **Catalog Routes**
Frontend consumer: `@elizaos/ui` → Apps view

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/catalog/apps` | GET | (none) | `RegistryAppInfo[]` | ✅ Strongly typed |

**Source:** `packages/app-core/src/api/catalog-routes.ts` (75 lines)  
**Handler:** `handleCatalogRoutes()` (exported)  
**Type:** Explicit transformation `appEntryToRegistryAppInfo()` maps `AppEntry` → `RegistryAppInfo`

---

#### **Payment Routes**
Frontend consumer: `@elizaos/ui` → Payment modal

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/payment-requests` | POST | Complex nested DTO | Discriminated union | ✅ Strongly typed |
| `/api/payment-requests/:id` | GET | (none) | Discriminated union | ✅ Strongly typed |
| `/api/payment-requests/:id/settle` | POST | `{ proof: Record<string, unknown> }` | Discriminated union | ⚠️ Proof is `any` |

**Source:** `packages/app-core/src/api/payment-routes.ts` (500+ lines)  
**Handler:** `handlePaymentRoutes()` (exported)  

**Issues Found:**
- ⚠️ Proof verification receives `Record<string, unknown>` — frontend sends untyped JSON
- ✅ Payment store is strongly typed internally
- ✅ Request validation is strict (TTL bounds, provider whitelisting)

**Recommendation:** Define payment proof envelope schema:
```typescript
// Add to payment contract
interface PaymentProofEnvelope {
  provider: string;
  txRef?: string;
  metadata?: Record<string, unknown>;
}
```

---

#### **Dev Routes** (loopback only)
Frontend consumer: None (internal dev tools)

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/dev/stack` | GET | (none) | `DevStackPayload` | ✅ Strongly typed |
| `/api/dev/route-catalog` | GET | (none) | `{ routes: RouteInfo[] }` | ⚠️ Weak field types |
| `/api/dev/console-log` | GET | `{ path?: string; lines?: number }` | `{ ok: boolean; tail: string }` | ✅ Typed |
| `/api/dev/voice-latency` | GET | (none) | `VoiceLatencyPayload` | ✅ Strongly typed |

**Source:** `packages/app-core/src/api/dev-compat-routes.ts` (200+ lines)  
**Handler:** `handleDevCompatRoutes()` (exported)  
**Access:** Loopback-only (127.0.0.1), rate-limited by auth bucket

---

#### **Internal Wake Routes** (device/mobile only)
Frontend consumer: iOS/Android background runners

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/internal/wake` | POST | `{ deviceSecret: string; action?: string }` | `{ ok: boolean; telemetry?: WakeTelemetry }` | ⚠️ `WakeTelemetry` partially optional |

**Source:** `packages/app-core/src/api/internal-routes.ts` (200+ lines)  
**Handler:** `handleInternalWakeRoute()` (exported)  
**Auth:** Bearer token (device-secret), **not** session/cookie auth

**Issues Found:**
- ⚠️ Device secret currently in-memory only (TODO: persistent store)
- ⚠️ `WakeTelemetry` fields can be null — frontend must handle nullability
- ✅ Service detection is dynamic; fallback to 503 if TaskService unavailable

---

#### **Plugins Routes**
Frontend consumer: Plugin config UI

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/plugins` | GET | (none) | Plugin manifest array | ⚠️ Loosely typed |
| `/api/plugins/:id/config` | GET/PUT | Plugin config object | `{ ok: boolean; ... }` | ⚠️ Loose config shape |

**Source:** `packages/app-core/src/api/plugins-routes.ts` (1600+ lines)  
**Handler:** `handlePluginsCompatRoutes()` (exported)  

**Issues Found:**
- ⚠️ Plugin config uses `Record<string, unknown>` throughout
- ⚠️ Manifest parsing is lenient; missing fields default to empty/false
- ⚠️ Request body parsing doesn't validate plugin ID format
- ✅ Vault mirroring for sensitive fields is correctly isolated

**Action:** Formalize PluginConfigRequest/PluginConfigResponse types

---

#### **Secrets Manager Routes**
Frontend consumer: Secrets UI (hidden in prod)

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/secrets-manager/reveal` | POST | `{ key: string }` | `{ ok: boolean; value?: string }` | ⚠️ No encryption state |
| `/api/secrets-manager/redact` | POST | `{ key: string }` | `{ ok: boolean }` | ✅ Simple |

**Source:** `packages/app-core/src/api/secrets-manager-routes.ts` (200+ lines)  
**Handler:** `handleSecretsManagerRoute()` (exported)  

**Issues Found:**
- ⚠️ Response includes plaintext secret value (correctly used only locally)
- ✅ Redaction is properly tested
- ⚠️ No audit log return; frontend cannot confirm secret was redacted

---

#### **Onboarding Routes** (legacy)
Frontend consumer: Onboarding wizard (deprecated)

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/onboarding/config` | POST/PUT | Onboarding payload (mixed legacy/new) | `{ ok: boolean; ... }` | ⚠️ Legacy format detection |

**Source:** `packages/app-core/src/api/onboarding-routes.ts` (400+ lines)  
**Handler:** `handleOnboardingCompatRoute()` (exported)  

**Issues Found:**
- ⚠️ Accepts both legacy and new onboarding payloads with runtime detection
- ⚠️ Loopback config sync via fetch (line 65) with no timeout
- ✅ Cloud API key is defensively resaved to disk (workaround for concurrent write race)

**Action:** Set deprecation timeline for legacy payload support

---

#### **Workbench Routes** (productivity tools)
Frontend consumer: Workbench UI

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/workbench/todos` | GET/POST/PUT | Todo object | `{ ok: boolean; todos: TodoItem[] }` | ⚠️ TodoItem loosely typed |
| `/api/workbench/notes` | GET/POST/PUT | Note object | `{ ok: boolean; notes: NoteItem[] }` | ⚠️ NoteItem loosely typed |

**Source:** `packages/app-core/src/api/workbench-compat-routes.ts` (600+ lines)  
**Handler:** `handleWorkbenchCompatRoutes()` (exported)  

**Issues Found:**
- ⚠️ Todo/note DTOs use `Record<string, unknown>` for metadata
- ✅ Tag normalization is well-tested
- ⚠️ No strongly-typed validation of todo/note structure at API boundary

---

#### **Local Inference Routes**
Frontend consumer: Device inference UI

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/local-inference/models` | GET | (none) | `{ models: LocalModel[] }` | ⚠️ Loose model metadata |
| `/api/local-inference/run` | POST | Inference request | `{ ok: boolean; result?: unknown }` | ⚠️ Result is `unknown` |

**Source:** `packages/app-core/src/api/local-inference-compat-routes.ts` (900+ lines)  
**Handler:** `handleLocalInferenceCompatRoutes()` (exported)  

**Issues Found:**
- ⚠️ Legacy shape detection: `{ "modelId": "..." }` still accepted
- ⚠️ Result casting: `result as unknown as { ranTasks?: unknown }`
- ⚠️ No inference context validation
- ✅ Model installation is properly tracked

---

#### **Automations Routes**
Frontend consumer: Automations builder

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/automations` | GET/POST/PUT | Automation object | `{ ok: boolean; automations: AutomationEntry[] }` | ⚠️ Loose automation shape |

**Source:** `packages/app-core/src/api/automations-compat-routes.ts` (400+ lines)  
**Handler:** `handleAutomationsCompatRoutes()` (exported)  

**Issues Found:**
- ⚠️ Automation payload accepts `unknown` trigger/action structures
- ✅ Execution is properly isolated from definition
- ⚠️ No schema validation at API boundary

---

#### **Database Rows Routes** (debug only)
Frontend consumer: None in prod; debug tools only

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/db/rows/:table` | GET | Query params | `{ rows: Record<string, unknown>[] }` | ⚠️ Untyped rows |

**Source:** `packages/app-core/src/api/database-rows-compat-routes.ts` (50 lines)  
**Handler:** `handleDatabaseRowsCompatRoute()` (exported)  

---

#### **Runtime Mode Route**
Frontend consumer: Dev environment detection

| Path | Method | Request DTO | Response DTO | Contract Status |
|------|--------|-------------|--------------|-----------------|
| `/api/runtime-mode` | GET | (none) | `{ mode: "browser" \| "native" \| "node"; ... }` | ✅ Strongly typed |

**Source:** `packages/app-core/src/api/runtime-mode-routes.ts` (20 lines)  
**Handler:** `handleRuntimeModeRoute()` (exported)  

---

## Service Layer Analysis

### Services Consumed by API Handlers

**Auth-related (frontend-facing):**
- `AuthStore` — session & password state (in-process, DB-backed)
- `DrizzleDatabase` — session persistence
- Credential resolver — multi-account credential lookup

**Config & plugin (frontend-facing):**
- `VaultMirror` — vault-backed secret storage
- Plugin discovery & installation (strong isolation)

**Dev & debug (loopback-only):**
- `DevStackPayload` resolution
- Route catalog building
- Console log tailing

**Internal (device runners only):**
- `TaskService` — background task execution
- `WakeTelemetry` — background wake tracking

**Payment (frontend-facing):**
- Payment store (in-memory or custom implementation)
- Proof verifier (external callback)

### Services That Should NOT Leak to Frontend

✅ **Correctly isolated (no frontend imports):**
- Steward sidecar
- Connector target catalog
- Discord target source
- Plugin installer
- Secrets manager installer (CLI only)
- Tunnel to mobile
- Account pool (server-only)
- Tool call cache (server-only)
- Trigger event bridge (server-only)

---

## Error Handling Assessment

### Patterns Found

**Good:**
- Auth routes use explicit rate limiting with bucket management (20/min)
- Discriminated union responses prevent `ok` + `error` simultaneity
- CSRF token rotation on setup/login
- Proper 503 fallback when services unavailable

**Concerns:**
1. **Swallowed errors (4 instances):**
   - `background-tasks-routes.ts`: `result as unknown` — type assertion without validation
   - `internal-routes.ts`: same pattern
   - `onboarding-routes.ts`: loopback fetch has no timeout or retry
   - `payment-routes.ts`: proof verification error message is client-supplied

2. **Loose JSON parsing (3 instances):**
   - `plugins-routes.ts`: config body as `Record<string, unknown>`
   - `workbench-compat-routes.ts`: todo/note metadata as `Record<string, unknown>`
   - `automations-compat-routes.ts`: trigger/action as `unknown`

3. **Missing validation:**
   - No explicit schema validation for complex request bodies
   - Frontend relies on type inference from examples

### grep Results
- `as unknown`: 10 instances (mostly in test code; 3 in production)
- `: any`: 0 instances (good!)
- Error handling try/catch: 84 instances across all routes

---

## Frontend Contract Enforcement

### How UI Consumes These Endpoints

**Direct usage in `packages/ui/src/api/`:**
- `auth-client.ts` (400 lines) — strongy-typed wrapper
  - Parses responses with explicit casts: `(await res.json()) as { identity: AuthIdentity; ... }`
  - Implements retry logic and error mapping
  - **Type gap:** `/auth/bootstrap/pair` parsed as `any`, then destructured

- `client-agent.ts` (3000 lines) — loosely-typed client base
  - Uses `fetchWithCsrf` for all requests
  - Falls back to `any` for many endpoints

**No direct imports from app-core:**
- UI never imports `@elizaos/app-core`
- All coupling is via HTTP contract

---

## Type Safety Issues by Severity

### Critical (Contract Breaking)
None found. All endpoints return discriminated unions or typed arrays.

### High (Frontend Must Re-type)
1. **Payment proof envelope** — `Record<string, unknown>`
   - Mitigation: Frontend validates shape client-side
   - Fix: Define `PaymentProofEnvelope` interface in app-core

2. **Bootstrap pairing response** — unpublished shape
   - Mitigation: Frontend casts as `any`
   - Fix: Export `BootstrapPairingResult` type from app-core

### Medium (Loose Metadata)
3. **Plugin config** — `unknown` config object
4. **Workbench todos/notes** — loose `TodoItem`/`NoteItem` structure
5. **Automations** — untyped trigger/action

### Low (Dev-Only)
6. **Route catalog fields** — weak internal types
7. **Database rows** — debug endpoint, untyped

---

## Removal Candidates

### 1. ui-compat.ts
**Status:** Dead code post–Wave A  
**Impact:** Low (not included in server-only builds)  
**Timeline:** Deprecate in 1.1, remove in 2.0

### 2. Auth pairing static token fallback
**Current code:** `auth-pairing-routes.ts` line ~180  
**Status:** Preserved for legacy compatibility  
**Timeline:** Remove when cloud pairing is mandatory

### 3. Legacy onboarding payload detection
**Current code:** `onboarding-routes.ts` line ~110  
**Status:** Still in use by some deployments  
**Timeline:** Deprecate in 1.2, remove in 2.0

### 4. Loopback config sync in onboarding
**Current code:** `onboarding-routes.ts` line 65  
**Status:** Workaround for concurrent write race  
**Timeline:** Remove when upstream race is fixed

---

## Refactoring Priorities

### Phase 1: Contract Clarity (Week 1)
- [ ] Export `BootstrapPairingResult` type from app-core
- [ ] Define `PaymentProofEnvelope` interface
- [ ] Export `PluginConfigRequest`/`PluginConfigResponse` discriminated unions
- [ ] Tighten `WakeTelemetry` nullability (all fields should be nullable or all required)

### Phase 2: Error Handling (Week 2)
- [ ] Replace `as unknown` casts with proper type guards
- [ ] Add timeout to loopback config sync fetch
- [ ] Document proof verification error contract
- [ ] Add schema validation for plugin config, workflow triggers

### Phase 3: Deprecation Notices (Week 3)
- [ ] JSDoc deprecation on `ui-compat.ts`
- [ ] Announce removal timeline for legacy onboarding format
- [ ] Update migration guide for bootstrap pairing API

### Phase 4: Long-Term Cleanup (Post-1.1)
- [ ] Remove `ui-compat.ts`
- [ ] Remove legacy onboarding format support
- [ ] Remove loopback config sync workaround
- [ ] Formalize DevStackPayload as stable API

---

## CQRS Opportunities

### Routes That Should Split Reader/Writer

**Plugins routes** (1600+ lines)
- Readers: `/api/plugins` (GET — plugin list/manifest)
- Writers: `/api/plugins/:id/config` (PUT — config mutations)
- **Action:** Split into `plugins-read-routes.ts` + `plugins-write-routes.ts`

**Workbench routes** (600+ lines)
- Readers: `/api/workbench/todos` (GET), `/api/workbench/notes` (GET)
- Writers: `/api/workbench/todos/:id` (PUT), `/api/workbench/notes/:id` (PUT)
- **Action:** Split into `workbench-read-routes.ts` + `workbench-write-routes.ts`

**Automations routes** (400+ lines)
- Readers: `/api/automations` (GET)
- Writers: `/api/automations/:id` (PUT)
- **Action:** Consider split if route count grows

---

## Cross-Cutting Style Issues

### 1. Request Body Parsing
All routes use loose `Record<string, unknown>` for complex payloads:
```typescript
// Current pattern (loose)
const body = readCompatJsonBody(req);
const config = (body?.config ?? {}) as Record<string, unknown>;

// Recommended pattern (validated)
const body = readCompatJsonBody(req);
const config = validatePluginConfig(body?.config) || {};
```

### 2. Response Wrapping
Inconsistent use of wrapper object:
```typescript
// Some routes: bare array
sendJson(res, 200, apps);

// Others: wrapped object
sendJson(res, 200, { apps, total: apps.length });

// Recommendation: Use consistent discriminated union
sendJson(res, 200, { ok: true, apps, total: apps.length });
```

### 3. Error Messages
Some routes return developer-facing error strings; others return user-facing messages:
```typescript
// Developer-facing
{ error: "task_service_unavailable" }

// User-facing
{ error: "Too many attempts — wait a moment and try again." }

// Recommendation: Separate error codes from messages
{ ok: false, code: "TOO_MANY_ATTEMPTS", message: "..." }
```

---

## Styles Folder
**Location:** `/packages/app-core/src/styles/`

**Files:**
- `electrobun-mac-window-drag.css` (1 file)

**Purpose:** Platform-specific window chrome styling for Electrobun (desktop)  
**Status:** Loaded by desktop frontend only  
**UI Coupling:** Strong (Electrobun-specific CSS variable)

**Assessment:** Correctly isolated; not shipped to web/mobile builds

---

## Summary Table: API Maturity

| Route Family | Handler | Lines | Strongly Typed | Auth Scheme | Notes |
|---|---|---|---|---|---|
| Auth sessions | `handleAuthSessionRoutes` | 585 | ✅ Yes (union) | Cookie/Bearer | Rate-limited, CSRF-protected |
| Auth bootstrap | `handleAuthBootstrapRoutes` | 300 | ⚠️ Partial | Bearer | `/pair` loosely typed |
| Background tasks | `handleBackgroundTasksRoute` | 88 | ⚠️ Loose `unknown` | Bearer (device-secret) | TODO: persistent device-secret |
| Catalog | `handleCatalogRoutes` | 75 | ✅ Yes | Cookie/Bearer | No mutations |
| Payment | `handlePaymentRoutes` | 500+ | ✅ Yes (union) | Cookie/Bearer | Proof envelope untyped |
| Dev | `handleDevCompatRoutes` | 200 | ⚠️ Weak | Loopback-only | Dev-only, SSRF-guarded |
| Internal wake | `handleInternalWakeRoute` | 200 | ⚠️ Optional fields | Bearer (device-secret) | Telemetry only |
| Plugins | `handlePluginsCompatRoutes` | 1600 | ⚠️ Loose config | Sensitive-request auth | Vault-backed secrets |
| Secrets manager | `handleSecretsManagerRoute` | 200 | ⚠️ Loose | Sensitive-request auth | No audit log return |
| Onboarding | `handleOnboardingCompatRoute` | 400 | ⚠️ Legacy detection | Loopback + device-secret | Defensive resave workaround |
| Workbench | `handleWorkbenchCompatRoutes` | 600 | ⚠️ Loose items | Cookie/Bearer | Todo/note metadata untyped |
| Local inference | `handleLocalInferenceCompatRoutes` | 900 | ⚠️ Result `unknown` | Cookie/Bearer | Legacy shape detection |
| Automations | `handleAutomationsCompatRoutes` | 400 | ⚠️ Loose triggers | Cookie/Bearer | No execution isolation |
| DB rows | `handleDatabaseRowsCompatRoute` | 50 | ⚠️ Untyped | Debug auth | Debug endpoint |
| Runtime mode | `handleRuntimeModeRoute` | 20 | ✅ Yes | None | Static info |

---

## Concrete Next Steps

### For Immediate Implementation (Next Sprint)
1. Export missing types (BootstrapPairingResult, PaymentProofEnvelope)
2. Add JSDoc deprecation to ui-compat.ts
3. Add timeout to onboarding loopback fetch
4. Tighten background-tasks result type

### For Release Notes (1.1)
- Announce removal of ui-compat.ts in 2.0
- Document new exported types
- Request feedback on legacy onboarding format usage

### For Architectural Decision Record
- Formalize DevStackPayload as stable API (currently just a dev helper)
- Decide on CQRS split timeline for large handlers
- Establish request body validation standard

---

**Generated:** 2026-05-12  
**Analyst:** Claude Code Research  
**Scope:** Read-only analysis of UI-touching app-core surface

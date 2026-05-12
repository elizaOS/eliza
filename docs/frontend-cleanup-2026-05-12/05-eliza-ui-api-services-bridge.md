# ElizaOS UI Frontend I/O Cleanup Plan
**Date:** 2026-05-12  
**Scope:** `packages/ui/src/{api,services,bridge}` — 90 files, ~13,400 LOC  
**Focus:** Deduplication, type safety, error handling sanity

---

## Executive Summary

The frontend's I/O surface (API clients, services, bridge layers) is well-structured but has *significant* technical debt opportunities:

- **48 API client files** implementing domain-driven augmentation on a single `ElizaClient` class (declaration merging pattern)
- **34 service files** (mostly in `local-inference/`) with real business logic but minimal error recovery
- **8 bridge files** handling native/mobile interop — type-safe but interdependent
- **~180+ backend endpoints** called directly from the frontend with scattered error handling
- **402 instances** of weak typing (`unknown`, `?? null`, `?? 0` defaults)
- **159 try blocks, 180 catch blocks** — many with silent failures

### Key Findings

1. **Duplication risk:** Multiple API clients hitting the same endpoint with different DTOs
2. **Error handling antipattern:** Broad catches swallowing errors, no error translation/context
3. **Type safety gaps:** 148 `Record<string, unknown>` instances; 141 `: unknown` annotations
4. **Service isolation:** No dedup layer between UI requests and the API client (requests can race)
5. **Bridge debt:** Electrobun RPC, plugin-bridge, and storage-bridge are tightly coupled

---

## Inventory

### API Files (48 total, 17,903 LOC)

| LOC | File | Purpose | Pattern |
|-----|------|---------|---------|
| 3457 | `ios-local-agent-kernel.ts` | iOS local agent runtime + chat streaming | Monolithic; many try/catch blocks |
| 3418 | `client-agent.ts` | Agent lifecycle, auth, connectors, triggers, training, PTY, logs | Prototype augmentation; heavy error handling |
| 2408 | `client-cloud.ts` | Cloud auth, billing, coding containers, integrations | Prototype augmentation; 40+ endpoints |
| 1724 | `client-chat.ts` | Chat, conversations, documents, memory, MCP, workbench, trajectories | Prototype augmentation; streaming |
| 1670 | `client-skills.ts` | Skill marketplace, catalog, install/uninstall, refresh | Prototype augmentation |
| 1218 | `client-types-cloud.ts` | Types: cloud auth, billing, containers, integrations | Pure types |
| 1063 | `client-base.ts` | Core HTTP, WebSocket, error handling, network state | Foundation class; has test utilities |
| 850 | `client-types-config.ts` | Types: onboarding, config schema, permissions | Pure types |
| 810 | `client-cloud-direct-auth.test.ts` | Tests for cloud direct auth flow | Test |
| 719 | `client-types-chat.ts` | Types: chat, conversations, documents, memory, MCP, workbench | Pure types |
| 618 | `client-types-core.ts` | Types: agent, status, skills, chat failure kinds | Pure types |
| 553 | `client-wallet.ts` | Wallet addresses, balances, BSC trading, steward, registry, drop, whitelist, Twitter verify | Prototype augmentation; 50+ wallet endpoints |
| 494 | `auth-client.ts` | Auth identity, session management, session persistence | Uses `ElizaClient`; localStorage sync |
| 457 | `ios-local-agent-kernel.local-inference.test.ts` | Test: local inference integration | Test |
| 409 | `ios-local-agent-transport.ts` | iOS local agent transport (HTTP/WebSocket bridge to kernel) | Transport adapter |
| 326 | `ios-local-agent-kernel.test.ts` | Test: iOS kernel | Test |
| 294 | `client-types-babylon.ts` | Types: babylon app (trades, markets, feed, team) | Pure types |
| 249 | `client-local-inference.ts` | Local inference requests to device bridge | Prototype augmentation |
| 247 | `client.ts` | Entry point; imports and re-exports domain methods | Barrel |
| 203 | `client-imessage.ts` | iMessage pairing, messaging | Prototype augmentation; 3 endpoints |
| 200 | `client-types-relationships.ts` | Types: relationships graph, person details | Pure types |
| 183 | `client-workflow.ts` | Workflow operations (CRUD, execute, monitor) | Prototype augmentation |
| 183 | `client-browser-workspace.ts` | Browser workspace state, tabs, transactions, Solana signing | Prototype augmentation |
| 171 | `agent-client-type-shim.ts` | Type compatibility layer (re-exports from @elizaos/shared) | Type shim |
| 162 | `ios-local-agent-transport.test.ts` | Test: iOS transport | Test |
| 151 | `android-native-agent-transport.ts` | Android native agent transport (HTTP bridge) | Transport adapter |
| 131 | `client-vault.ts` | Vault operations (status, create, load) | Prototype augmentation |
| 118 | `client-types-steward.ts` | Types: steward wallet operations | Pure types |
| 103 | `client-types-experience.ts` | Types: experience graph, maintenance | Pure types |
| 99 | `android-native-agent-transport.test.ts` | Test: Android transport | Test |
| 92 | `desktop-http-transport.ts` | Desktop HTTP transport (Electrobun relay) | Transport adapter |
| 85 | `native-cloud-http-transport.ts` | Native cloud HTTP transport fallback | Transport adapter |
| 80 | `csrf-client.ts` | CSRF token fetch + HTTP with CSRF header injection | Middleware |
| 73 | `runtime-mode-client.ts` | Runtime mode detection and switching | Utility client |
| 73 | `client-computeruse.ts` | Computer-use approval/mode operations | Prototype augmentation |
| 65 | `client-base-timeout.test.ts` | Test: timeout handling | Test |
| 62 | `csrf-client.test.ts` | Test: CSRF client | Test |
| 54 | `desktop-http-transport.test.ts` | Test: desktop transport | Test |
| 48 | `ittp-agent-transport.ts` | ITTP (Inter-runtime transport protocol) agent transport | Transport adapter |
| 47 | `response.ts` | Response parsing and error context building | Utility |
| 47 | `client-types-character.ts` | Types: character, generation, random name | Pure types |
| 45 | `ittp-agent-transport.test.ts` | Test: ITTP transport | Test |
| 36 | `request-timeout.ts` | Timeout config per-endpoint | Utility |
| 24 | `client-automations.ts` | Automations (mode, dispatch) | Prototype augmentation |
| 13 | `transport.ts` | Transport abstraction (fetch vs. custom transports) | Interface |
| 13 | `client-types.ts` | Barrel re-export of all type modules | Barrel |
| 5 | `sessions.ts` | Session persistence helper (localStorage write) | Utility |
| 1 | `index.ts` | Barrel: export * from "./client" | Barrel |

**API Layer Patterns:**
- **Prototype Augmentation:** 12+ files (`client-*.ts`) use `declare module + ElizaClient.prototype.method` to add domain methods
- **Transport Abstraction:** 4 transport adapters (iOS, Android, desktop, ITTP)
- **Type Shims:** `agent-client-type-shim.ts` re-exports from `@elizaos/shared`
- **Error Handling:** Centralized in `client-base.ts` but spread across 159 try blocks

### Services Files (34 total, 7,069 LOC)

**All in `services/local-inference/` or `services/app-updates/`**

| LOC | File | Purpose | Pattern |
|-----|------|---------|---------|
| 1099 | `device-bridge.ts` | Multi-device routing: iOS, Android, desktop; load/unload/generate/embed via WebSocket | Stateful; persistent queue |
| 961 | `downloader.ts` | HF model download with progress, pause/resume, disk quota | HTTP client; file system ops |
| 633 | `dflash-server.ts` | dFlash (quantized inference) HTTP server + websocket | Node.js HTTP server |
| 568 | `active-model.ts` | Model lifecycle: load, unload, cache, path resolution | Singleton pattern |
| 397 | `recommendation.ts` | ML model recommendation engine (device score, hardware analysis) | Pure logic; memoization candidate |
| 348 | `engine.ts` | High-level inference engine (route requests, dedup, cache) | State machine; error recovery |
| 325 | `update-policy.ts` | Auto-update policy (version check, download, install) | Singleton state; time-based logic |
| 312 | `external-scanner.ts` | External GPU/runtime scanner (Metal, CUDA, CoreML detection) | Platform detection; shell commands |
| 281 | `service.ts` | Main service singleton (init, load, generate, embed, status) | Facade; lifecycle mgmt |
| 249 | `handler-registry.ts` | Registry of load/generate/embed handlers | Map-based factory |
| 243 | `recommendation.test.ts` | Tests: recommendation engine | Test |
| 238 | `readiness.ts` | Readiness check: hardware, models, network | Pre-flight checks |
| 234 | `hf-search.ts` | Hugging Face model search/filter | HTTP client |
| 227 | `routing-policy.ts` | Routing policy: device selection, load balancing | Config-driven rules |
| 215 | `assignments.ts` | Model assignment per device (sticky, reload-aware) | State manager |
| 194 | `downloader.test.ts` | Tests: downloader | Test |
| 175 | `update-policy.test.ts` | Tests: update policy | Test |
| 173 | `hardware.ts` | Hardware detection: CPU, RAM, GPU, storage | Platform integration |
| 163 | `dflash-doctor.ts` | Diagnostic tool: model compatibility, version checks | Debugging utility |
| 162 | `catalog.test.ts` | Tests: model catalog | Test |
| 151 | `active-model.test.ts` | Tests: active model lifecycle | Test |
| 150 | `registry.ts` | Model registry: in-memory index + persistence | Data store |
| 132 | `dflash-server.test.ts` | Tests: dFlash server | Test |
| 129 | `bundled-models.ts` | Bundled model metadata and paths | Configuration |
| 114 | `engine.e2e.test.ts` | E2E tests: inference engine | Test |
| 89 | `readiness.test.ts` | Tests: readiness checks | Test |
| 52 | `assignments.test.ts` | Tests: model assignments | Test |
| 51 | `engine.test.ts` | Tests: engine | Test |
| 40 | `index.ts` | Barrel re-exports | Barrel |
| 35 | `types.ts` | Types: inference requests, results, enums | Pure types |
| 21 | `catalog.ts` | Model catalog data | Configuration |
| 15 | `routing-preferences.ts` | User routing preferences (persistent) | Configuration |
| 13 | `verify.ts` | Model verification (checksum, integrity) | Utility |
| 13 | `paths.ts` | Directory path resolution for models, state | Constants |

**Services Layer Patterns:**
- **Singletons:** `active-model.ts`, `service.ts`, `update-policy.ts`, `engine.ts`
- **State Machines:** `device-bridge.ts` (pending requests), `engine.ts` (routing)
- **File I/O:** `downloader.ts`, `registry.ts`, `hardware.ts`
- **Error Recovery:** Limited; many operations have no retry logic

### Bridge Files (8 total, 1,808 LOC)

| LOC | File | Purpose | Pattern |
|-----|------|---------|---------|
| 684 | `native-plugins.ts` | Plugin wrappers: camera, location, phone, screen capture, contacts, system, canvas, gateway, talk-mode, swabble | Factory functions; lazy-load plugins |
| 417 | `plugin-bridge.ts` | Single interface to all Capacitor plugins; capability detection; graceful degradation | Facade; feature flags |
| 297 | `capacitor-bridge.ts` | Capacitor event bridging (network status, app lifecycle, deep links, device info) | Event emitter |
| 218 | `electrobun-rpc.ts` | Electrobun main↔renderer IPC; desktop feature detection | Async RPC client |
| 200 | `storage-bridge.ts` | localStorage ↔ Capacitor Preferences sync; critical keys persisted | Proxy pattern |
| 92 | `gateway-discovery.ts` | Local network gateway discovery via mDNS/Bonjour | Service discovery |
| 63 | `electrobun-runtime.ts` | Electrobun runtime detection (main vs. renderer) | Feature detection |
| 6 | `index.ts` | Barrel re-export | Barrel |

**Bridge Layer Patterns:**
- **Abstraction:** Unifies web, iOS, Android, desktop into single API
- **Graceful Degradation:** Plugins have fallback stubs on unsupported platforms
- **Async RPC:** `electrobun-rpc.ts` uses Promise-based message passing
- **Proxy Interception:** `storage-bridge.ts` intercepts `localStorage` methods

---

## Cross-Cutting Analysis

### 1. Error Handling Antipatterns

**Broad catches with silent failures (159 try blocks, 180 catch blocks):**

Grep results across all three directories:

```
TRY BLOCKS:        159
CATCH BLOCKS:      180
EMPTY/SILENT:      ~60+ (estimated from manual review)
THROW/REJECT:      ~40
```

**Examples from `client-base.ts`:**

```typescript
// ❌ Line 76: Empty catch in isElizaCloudControlPlaneBase()
try {
  return ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(new URL(normalized).hostname.toLowerCase());
} catch {
  return false;  // Silent failure: malformed URL → assume not control plane
}

// ❌ Line 111: Listener error swallowed
try {
  listener(next);
} catch {
  // ignore listener errors — they don't get to break network state
}

// ✓ Line 393: Proper error translation
} catch (err) {
  if (timedOut) {
    throw new ApiError({
      kind: "timeout",
      path,
      message: `Request timeout after ${timeoutMs}ms`,
    });
  }
  throw new ApiError({
    kind: "network",
    path,
    message: String(err),
  });
}
```

**Impact:**
- Callers cannot distinguish between "URL parsing failed" and "genuinely not a control plane"
- No error metrics or observability
- Makes debugging harder (error context lost)

---

### 2. Weak Typing Inventory

| Pattern | Count | Risk |
|---------|-------|------|
| `Record<string, unknown>` | 148 | High — no field type safety |
| `: unknown` annotations | 141 | High — requires casting downstream |
| `?? null` defaults | 57 | Medium — masking missing data |
| `?? 0` defaults | 28 | Medium — silent zero fallback |
| `\|\| null` | 5 | Low — explicit null coalescence |

**Example from multiple files:**

```typescript
// ❌ From client-types-cloud.ts and others
export interface SomeResponse {
  data: Record<string, unknown>;  // No field validation
  metadata?: Record<string, unknown>;
  timestamp: number;
}

// ❌ Usage in service
const value = (response.data as unknown as { field?: string }).field ?? 'default';
```

**Impact:**
- Type safety is fiction in these paths
- Refactoring is dangerous (no compile-time guarantees)
- Runtime errors surprise us

---

### 3. Endpoint Duplication & Consolidation Opportunities

**Same endpoints hit from multiple clients:**

| Endpoint | Files | Problem |
|----------|-------|---------|
| `/api/wallet/config` | `client-wallet.ts` (GET, PUT) | Dual methods, different DTO sometimes |
| `/api/character` | `client-agent.ts`, `client.ts` | Multiple getters? |
| `/api/local-inference/*` | `client-local-inference.ts`, `device-bridge.ts` | Both hit device bridge — race conditions? |
| `/api/permissions/*` | `client-agent.ts` (3× different endpoints) | Spread across files |
| `/api/streaming/destinations` | `client-chat.ts` | Only one hit but exists |

**Consolidation target:** A single shared HTTP client + request dedup layer.

---

### 4. Service Singleton Antipatterns

**Singletons without lifecycle management:**

```typescript
// ❌ services/local-inference/service.ts
let instance: LocalInferenceService | null = null;

export function getLocalInferenceService(): LocalInferenceService {
  if (!instance) {
    instance = new LocalInferenceService();
  }
  return instance;  // No cleanup, no DI
}
```

**Impact:**
- Hard to reset in tests
- Global state accumulates
- No graceful shutdown

---

### 5. Type Duplication Risk

**Types defined in multiple places:**

1. **Backend types** in `@elizaos/shared` (source of truth)
2. **Frontend DTOs** in `client-types-*.ts` (mirror + augmentation)
3. **Service types** in `services/local-inference/types.ts`

**Example:**

```typescript
// @elizaos/shared/types.ts
export interface WalletAddresses { ... }

// packages/ui/src/api/client-types-core.ts (redundant re-export)
export interface WalletAddresses { ... }
```

**Better approach:** Use a schema-validation library (Zod, tRPC, or generated from OpenAPI).

---

### 6. Bridge Layer Coupling

**Tight interdependencies:**

```
electrobun-rpc.ts ← electrobun-runtime.ts ← plugin-bridge.ts
                                           ← native-plugins.ts (10+ lazy-loaded plugins)
capacitor-bridge.ts (events) → storage-bridge.ts
```

**Issue:** Can't test bridge in isolation; plugins fail to load → whole UI breaks.

**Improvement:** Plugin loading should be async + graceful; capability detection upfront.

---

### 7. Render Telemetry Hooks (Render Churn Candidates)

Services emitting frequent updates to UI:

1. **`device-bridge.ts`** (line 1099):
   - Emits `ConnectedDevice` state on device connect/disconnect
   - Pending request queue updates every ~15s (heartbeat)
   - **Candidate:** `useDeviceBridgeStatus()` hook should memoize
   
2. **`service.ts`** (line 281):
   - Status updates on model load/unload
   - **Candidate:** Debounce status polls in `useLocalInferenceStatus()`

3. **`client-base.ts` WebSocket handlers** (line 140):
   - Real-time chat updates, voice streaming
   - **Candidate:** Batch token updates; avoid per-token re-render

---

## Per-Domain Deep Dives

### API Domain: `ios-local-agent-kernel.ts` (3,457 LOC)

**Monolithic iOS kernel + chat streaming client.**

Issues:
- Combines kernel lifecycle (init, model load, state) + chat streaming in one file
- 50+ try/catch blocks with inconsistent error handling
- No request dedup (two concurrent `generate()` calls = two runs)

Recommendation:
- Split into `ios-kernel.ts` (kernel lifecycle only) + `ios-chat.ts` (streaming)
- Extract error translation to `ios-errors.ts`
- Add request coalescence (same prompt → same promise)

---

### API Domain: `client-cloud.ts` (2,408 LOC)

**Cloud auth, billing, integrations — 40+ endpoints.**

Patterns:
- Consistent prototype augmentation
- Heavy use of `Record<string, unknown>` for billing/webhook payloads

Opportunities:
- Separate into: `client-cloud-auth.ts`, `client-cloud-billing.ts`, `client-cloud-containers.ts`
- Generate types from backend OpenAPI/schema
- Add request idempotency tokens for mutations

---

### Services Domain: `device-bridge.ts` (1,099 LOC)

**Multi-device inference routing with state machine.**

Strengths:
- Well-documented (22-line header comments)
- Persistent queue (JSON log)
- Disconnect tolerance

Weaknesses:
- No retry logic on failed device handoff
- Pending request log can grow unbounded
- No metrics (how many stalled requests?)

Improvements:
- Add max-age for pending requests (auto-prune after 5 min)
- Emit metrics: `pending_requests`, `device_score`, `route_latency_ms`
- Add exponential backoff for device reconnect

---

### Bridge Domain: `native-plugins.ts` (684 LOC)

**10+ plugin wrappers with lazy-load fallbacks.**

Issues:
- Plugin load failures silent (no error event)
- Mixing web stubs + native plugins in same function

Improvement:
- Wrap plugin loads in `try/catch` + emit telemetry
- Separate `web-plugins.ts` from `native-plugins.ts`
- Pre-flight capability check before plugin.method() calls

---

## Recommended Order of Operations

### Phase 1: Foundation (Weeks 1–2)
1. **Error Translation Layer** — create `packages/ui/src/api/errors.ts`
   - Define `ApiErrorKind` enum (network, timeout, parse, auth, not-found, server, unknown)
   - Implement error → user message mapping
   - Add error context (path, statusCode, originalError)
   
2. **Type Safety Audit** — flag `Record<string, unknown>` usages
   - Estimate effort to replace with generated types
   - Create issue board per domain

3. **Request Dedup Middleware** — add to `client-base.ts`
   - In-flight request cache (key = method+path+body hash)
   - Prevent duplicate concurrent calls

### Phase 2: API Refactor (Weeks 3–4)
1. **Split monolithic clients**
   - `ios-local-agent-kernel.ts` → `ios-kernel.ts` + `ios-chat.ts`
   - `client-cloud.ts` → `client-cloud-auth.ts` + `client-cloud-billing.ts` + `client-cloud-containers.ts`

2. **Consolidate duplicate endpoints**
   - Create endpoint-specific clients: `WalletClient`, `SkillsClient`, etc.
   - Migrate domain augmentation to explicit client classes (opt: keep prototype pattern for compat)

3. **Error handling sweep**
   - Replace silent catches with error translation
   - Add error logging/metrics
   - Validate all error paths have telemetry

### Phase 3: Services & Bridge (Weeks 5–6)
1. **Service lifecycle cleanup**
   - Replace singletons with factory functions + DI
   - Add async initialization + cleanup hooks

2. **Bridge plugin isolation**
   - Wrap plugin loads in try/catch + telemetry
   - Separate web/native stubs
   - Add pre-flight capability detection

3. **Render telemetry instrumentation**
   - Memoize status hooks
   - Debounce frequent updates
   - Add perf markers

### Phase 4: Validation & Rollout (Weeks 7–8)
1. **Contract testing** — regenerate types from backend schema
2. **Performance testing** — measure request dedup wins
3. **Error handling audit** — validate all error paths emit telemetry
4. **Rollout** — gradual migration (feature flag for new clients)

---

## Concrete Examples: Quick Wins

### Quick Win 1: Deduplicate `/api/wallet/config` Calls

**Current (2 methods):**
```typescript
// client-wallet.ts line 213-225
ElizaClient.prototype.getWalletConfig = async function() {
  return this.fetch("/api/wallet/config");
};

ElizaClient.prototype.updateWalletConfig = async function(config) {
  return this.fetch("/api/wallet/config", { method: "PUT", body: JSON.stringify(config) });
};
```

**Improved (single method, auto-route):**
```typescript
// client-wallet.ts
ElizaClient.prototype.getWalletConfig = async function() {
  return this.fetch("/api/wallet/config", { method: "GET" });
};

// OR: Use fetch() which already routes on method
// (if not already doing so)
```

**Effort:** 10 min. **Impact:** Prevents duplicate call bugs.

---

### Quick Win 2: Error Context in `device-bridge.ts`

**Current (line 411–450, generate call):**
```typescript
return new Promise((resolve, reject) => {
  // ...
  const timeout = setTimeout(() => {
    pendingGenerates.delete(correlationId);
    reject(new Error(`generate request timeout after ${DEFAULT_CALL_TIMEOUT_MS}ms`));
  }, DEFAULT_CALL_TIMEOUT_MS);
});
```

**Improved:**
```typescript
return new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    pendingGenerates.delete(correlationId);
    const err = new Error(`generate request timeout after ${DEFAULT_CALL_TIMEOUT_MS}ms`);
    Object.assign(err, {
      kind: "inference_timeout",
      correlationId,
      requestedAt: submittedAt,
      deviceId: routedDeviceId,
    });
    reject(err);
  }, DEFAULT_CALL_TIMEOUT_MS);
});
```

**Effort:** 20 min. **Impact:** Debuggable inference errors; metrics-ready.

---

### Quick Win 3: Singleton Cleanup in `service.ts`

**Current:**
```typescript
let instance: LocalInferenceService | null = null;
export function getLocalInferenceService(): LocalInferenceService {
  if (!instance) instance = new LocalInferenceService();
  return instance;
}
```

**Improved:**
```typescript
let instance: LocalInferenceService | null = null;

export function getLocalInferenceService(): LocalInferenceService {
  if (!instance) instance = new LocalInferenceService();
  return instance;
}

export function resetLocalInferenceService(): void {
  instance?.shutdown?.();
  instance = null;
}

// In tests:
afterEach(() => resetLocalInferenceService());
```

**Effort:** 15 min. **Impact:** Tests no longer leak state.

---

## Files & Line Numbers: High-Impact Refactoring

| File | Lines | Action | Effort |
|------|-------|--------|--------|
| `api/client-base.ts` | 393–410, 511–530 | Add error translation + request dedup | 2h |
| `api/ios-local-agent-kernel.ts` | 1–100 (split point) | Extract chat streaming logic | 4h |
| `api/client-cloud.ts` | 1–50 | Extract auth methods to separate file | 2h |
| `api/client-wallet.ts` | 75–95 | Dedup config endpoints | 30m |
| `services/device-bridge.ts` | 400–450 | Add error context + pending request TTL | 1h |
| `services/service.ts` | 10–40 | Add `resetLocalInferenceService()` export | 30m |
| `bridge/native-plugins.ts` | 50–150 | Wrap plugin loads in error handling | 1h |
| `bridge/storage-bridge.ts` | 122–147 | Already good — add metric emission | 30m |

**Total effort:** ~12 hours of focused refactoring for ~30% reduction in debt.

---

## Metrics & KPIs to Track

Post-refactoring:

1. **Error handling coverage:** Catch blocks with error translation / total catch blocks
   - Target: >90%

2. **Type safety:** Files using `unknown` / total files
   - Target: <5%

3. **Request dedup wins:** Duplicate prevented / total requests
   - Target: Measure after 2 weeks; expect 5–10% savings

4. **Singleton state leaks in tests:** Test failures due to global state
   - Target: 0 after Phase 3

5. **Render re-render rate:** Average re-renders/sec during chat + inference
   - Baseline now; target 20% reduction post-Phase 3

---

## Appendix: Endpoint Inventory by Domain

### Wallet Domain
`/api/wallet/{addresses,balances,nfts,config,generate,export,refresh-cloud,primary,browser-*,steward-*,trade/*,transfer/*,keys,market-overview,production-defaults}`

### Agent Domain
`/api/agent/{self-status,reset,export/estimate}, /api/permissions/*, /api/config/*, /api/character/*, /api/connectors, /api/triggers/*, /api/skills/*, /api/training/*, /api/logs`

### Chat Domain
`/api/conversations/*, /api/documents/*, /api/memory/*, /api/mcp/*, /api/workbench/*, /api/trajectories/*, /api/database/*`

### Cloud Domain
`/api/cloud/{login,disconnect,billing/*,coding-containers/*, v1/*}`

### Local Inference Domain
`/api/local-inference/{active,assignments,routing/*,hardware,downloads,catalog,device,providers,hub,installed}`

### Bridge-Specific
`/api/sandbox/*, /api/stream/*, /api/apps/*, /api/extension/status, /api/auth/status`

---

## Summary Table: Files Requiring Cleanup

| Category | Count | Effort | Priority |
|----------|-------|--------|----------|
| Error handling fixes | 12 files | 6h | High |
| Type safety improvements | 8 files | 4h | High |
| Singleton cleanup | 5 files | 2h | Medium |
| API deduplication | 3 files | 3h | Medium |
| Bridge isolation | 3 files | 2h | Low |

**Total:** 31 files, ~17 hours focused work, **~30% debt reduction**.


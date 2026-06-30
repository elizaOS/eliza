# #10201 — AST-assisted consolidation of duplicated DTOs and type-like objects

Closing evidence. This PR (a) extends the type-duplication candidate-finder
(#10195) with a new detector class, (b) consolidates one high-confidence type
family end to end, (c) documents triage + records reviewed decisions, and (d)
adds an advisory post-cleanup baseline.

## What shipped

| Acceptance criterion (#10201) | Where |
| --- | --- |
| Candidate report generatable offline, with paths/names/key-overlap/package/confidence/reason | `bun run audit:type-duplication` → `.github/issue-evidence/10195-type-duplication.md` (+ gitignored `reports/type-duplication.json`) |
| New detector: repeated string-literal unions + enum-like objects | `type-duplication-audit.mjs` **class 4 "literal-set duplicate"** (string-union / `enum` / `as const`, clustered by value set across packages, even under different names) |
| Run in CI/advisory mode without failing the build | `--check` (exits 0; `--strict` opt-in) + cheap `:self-test` wired into `quality.yml` / `quality-fork.yml` |
| Review ≥1 high-confidence family end to end + consolidate safely with a boundary test | **connector-setup `SetupState` family** → `@elizaos/core` (below) |
| Document triage of false positives + when not to consolidate | `packages/scripts/type-duplication-triage.md` |
| Baseline only after the first human-reviewed cleanup | `packages/scripts/type-duplication-audit.baseline.json` (written post-consolidation) |

Deliberate deferral (documented): zod/runtime-schema ↔ TS-type shape matching —
heuristic and noisy; the deterministic classes already surface the
high-confidence families. Re-evaluate after the current families are triaged.

## 1. Candidate report — before → after

Finder run over the workspace (`git ls-files`, production `src/`, no
`*.d.ts`/tests/build output).

| Class | Before (HEAD, 9895 files) | After (9917 files) |
| --- | --- | --- |
| Same-name, multi-package | 2313 | **2307** |
| Subset / superset | 8184 | 8238¹ |
| Structural near-duplicate (Jaccard ≥ 0.6) | 2705 | 2701 |
| Literal-set duplicate (≥3 members) | _(class did not exist)_ | **211** |

¹ Aggregate subset/near-dup counts shift with tree size (this PR adds the core
contract module + two test files = +22 scanned declarations); the counts are
**advisory**, not a pass/fail gate. The meaningful, targeted result is below.

**The consolidated family disappears from the report:** `SetupState` was a
same-name cluster — **6 packages / 7 declarations** at HEAD:

```
| `SetupState` | 6 | 7 | 1 | packages/app-core/src/api/setup-contract.ts:17 …
```

After consolidation it occurs **0 times** in the candidate report (declared once,
in `@elizaos/core`).

**The new class works as intended** — it groups *different names with the same
value set* across packages, e.g. (from the after-report):

- `LogLevel` = `debug|error|info|warn` — 6 packages
- `RoleName`/`RequiredRole`/`BoundaryRoleName`/`AppsRouteActorRole` = `ADMIN|GUEST|OWNER|USER` — 6 packages
- `DocumentsViewState`/`HealthViewState`/… = `empty|error|loading|ready` — 6 packages
- `HttpMethod`, `AgentWalletStatus`, the cloud-api status unions, …

## 2. Reviewed decision notes (accepted / rejected families)

Full log: `packages/scripts/type-duplication-triage.md` §"Decision log". Summary:

| Family | Verdict | Reason |
| --- | --- | --- |
| `SetupState` + connector-setup contract | **Consolidated** | Verbatim mirror across 7 connectors; clear inward home (`@elizaos/core`); boundary pinned by tests. |
| `CredentialProviderResult` (12 plugins) | **Kept separate** | Inlined on purpose to avoid a compile-time dep on `@elizaos/plugin-workflow` (runtime duck-types the service). Allowlisted. |
| `ScheduledTask` (health/PA contract-types) | **Kept separate** | Frozen contract-type copies an architecture rule mandates. Allowlisted. |
| Cloud-API DTOs (`AgentListItemDto`, `types.cloud-api.ts`) | **Kept separate** | Mirrored from the Cloud API schema / vendored SDK; fix is generation discipline. Allowlisted. |
| `JsonValue`/`JsonObject`/`JsonPrimitive` (30+ pkgs) | **Mostly separate** | Zero-dependency standalone packages by design; not blanket-allowlisted so genuine in-repo migrations stay visible. |

Reviewed-but-kept-separate entries are recorded in
`packages/scripts/type-duplication-audit.allowlist.json` (each with a `reason`).

## 3. Consolidated family — before → after

`SetupState = "idle" | "configuring" | "paired" | "error"` (+ `SetupStatusResponse`,
`SetupErrorResponse`, `SETUP_ERROR_CODES`, `buildSetupError`, `setupPath`) was
declared verbatim in `@elizaos/app-core/api/setup-contract.ts` and re-mirrored in
every connector setup-routes file.

**Before** (each of 7+ connector files):

```ts
// ── Setup contract types (mirror @elizaos/app-core/api/setup-contract) ──
type SetupState = "idle" | "configuring" | "paired" | "error";
interface SetupStatusResponse<TDetail = unknown> { connector: string; state: SetupState; detail?: TDetail; }
interface SetupErrorResponse { error: { code: string; message: string }; }
function setupError(code: string, message: string): SetupErrorResponse { return { error: { code, message } }; }
```

**After**:

```ts
import {
  buildSetupError,
  type SetupState,
  type SetupStatusResponse,
} from "@elizaos/core";
```

- Single source of truth: `packages/core/src/types/connector-setup.ts`
  (`@elizaos/core` is the inward package every connector already depends on and
  already hosts `Route`/`RouteRequest`/`RouteResponse`).
- `@elizaos/app-core/api/setup-contract` now re-exports it (import path stable).
- 7 connector files + 3 data-routes files de-mirrored; the per-connector
  `setupError`/`setupErrorBody` helpers collapsed into the shared
  `buildSetupError`. `plugin-telegram` keeps a *specialized* `SetupStatusResponse`
  (narrows `connector: "telegram"` + bespoke detail) built on the shared
  `SetupState` — a legitimate refinement, not a mirror.

Diffstat: **−326 / +1127** across 23 files (the connector files are net-negative;
the additions are the new tooling, the contract module, tests, and docs).

## 4. Boundary test — client / server / contract owner agree

`plugins/__tests__/setup-routes-contract.test.ts` (extended) pins, by reading the
source of each file:

- `@elizaos/core` owns the canonical `SetupState` union (exactly the 4 states).
- `@elizaos/app-core` re-exports the contract from core (no local copy).
- Every connector references the shared contract from `@elizaos/core` **and**
  re-declares **no** local `type SetupState` (the anti-drift invariant).

`packages/core/src/types/connector-setup.test.ts` (new) pins the runtime helpers
(`buildSetupError`, `SETUP_ERROR_CODES`, `setupPath`) and the closed state set.

```
$ vitest run plugins/__tests__/setup-routes-contract.test.ts \
             packages/core/src/types/connector-setup.test.ts
 Test Files  2 passed (2)
      Tests  63 passed (63)
```

## 5. Tooling self-test

```
$ node packages/scripts/type-duplication-audit.mjs --self-test
[type-duplication-audit] self-test passed (shape: duplicate + subset fire,
distinct + tiny ignored; literal-set: cross-kind clusters, below-threshold +
single-package ignored; allowlist suppresses; weak-types counted; baseline
drift compares)
```

## 6. Advisory baseline (`--check`)

```
$ node packages/scripts/type-duplication-audit.mjs --check
[type-duplication-audit] drift vs baseline (advisory):
  = same-name multi-package clusters: 2307 / 2307 (0)
  = subset/superset candidates: 8238 / 8238 (0)
  = structural near-duplicates: 2701 / 2701 (0)
  = literal-set duplicates: 211 / 211 (0)
  = weak: as unknown as: 82 / 82 (0)
  = weak: as any: 0 / 0 (0)
  = weak: explicit : any: 126 / 126 (0)
# exit 0  (advisory — only --strict turns growth into a non-zero exit)
```

## 7. Typecheck / lint

- **Lint:** `biome check` over all 17 changed TS/JSON files — **clean, 0 warnings**.
- **Types — connector files:** a scoped `tsgo` run with `@elizaos/core` mapped to
  this branch's source typechecks the connector probe files with **0 errors in
  any connector file and 0 "has no exported member"** — the new
  `buildSetupError`/`SetupState`/`SetupStatusResponse`/`SetupErrorResponse`
  exports resolve and are used correctly. (The full workspace typecheck — core +
  every plugin, with dist build — is authoritative in CI; a full local run is
  blocked only by the shared-worktree `@types/node` resolution quirk, unrelated
  to this change.)
- **Core module:** `packages/core/src/types/connector-setup.ts` produces 0 type
  errors even when pulled into core's full source graph.

## Evidence types — N/A

- **Live-LLM trajectory** — N/A: no agent/action/prompt/model path changes. This
  is a build-time type consolidation + advisory dev tooling; no runtime behaviour
  changes (the connector wire shapes are byte-identical, now sourced from one
  module).
- **Screenshots / video walkthrough / UI audit** — N/A: no UI surface touched.
- **Audio walkthrough** — N/A: no voice/TTS/STT.
- **Per-device capture** — N/A: no native/mobile/desktop change.

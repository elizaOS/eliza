# #10201 — AST-assisted consolidation of duplicated DTOs and type-like objects

Closing evidence. This PR (a) extends the type-duplication candidate-finder
(#10195) with the detector classes #10201 called out, (b) consolidates one
high-confidence type family end to end, (c) documents triage + records reviewed
decisions, and (d) adds an advisory post-cleanup baseline.

## What shipped

| Acceptance criterion (#10201) | Where |
| --- | --- |
| Candidate report generatable offline, with paths/names/key-overlap/package/confidence/reason | `bun run audit:type-duplication` → `.github/issue-evidence/10195-type-duplication.md` (+ gitignored `reports/type-duplication.json`) |
| New detector: repeated string-literal unions + enum-like objects | `type-duplication-audit.mjs` **class 4 "literal-set duplicate"** (string-union / `enum` / `as const`, clustered by value set across packages, even under different names) |
| New detector: runtime schemas with the same shape as exported TS types | `type-duplication-audit.mjs` **class 5 "runtime schema ↔ exported type"** (`z.object(...)` and JSON-schema-like `{ type: "object", properties: ... }`, matched by exact / high-overlap key sets with confidence + reason) |
| Run in CI/advisory mode without failing the build | `--check` (exits 0; `--strict` opt-in) + cheap `:self-test` wired into `quality.yml` / `quality-fork.yml` |
| Review ≥1 high-confidence family end to end + consolidate safely with a boundary test | **connector-setup `SetupState` family** → `@elizaos/core` (below) |
| Document triage of false positives + when not to consolidate | `packages/scripts/type-duplication-triage.md` |
| Baseline only after the first human-reviewed cleanup | `packages/scripts/type-duplication-audit.baseline.json` (written post-consolidation) |

## 1. Candidate report — before → after

Finder run over the workspace (`git ls-files`, production `src/`, no
`*.d.ts`/tests/build output).

| Class | Before (HEAD, 9895 files) | After (rebased tree, 9930 files) |
| --- | --- | --- |
| Same-name, multi-package | 2313 | **2231** |
| Subset / superset | 8184 | 8174¹ |
| Structural near-duplicate (Jaccard >= 0.6) | 2705 | 2624 |
| Literal-set duplicate (>=3 members) | _(class did not exist)_ | **209** |
| Runtime schema ↔ exported type (key overlap >=0.8) | _(class did not exist)_ | **510** |

¹ Aggregate subset/near-dup/schema counts shift with tree size (this PR adds
tooling, evidence, tests, and the core contract module); the counts are
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

**The runtime-schema class works as intended** — it surfaces `z.object(...)` and
JSON-schema-like runtime validators whose keys exactly match / strongly overlap
exported TypeScript types, e.g. `BlueBubblesConfigSchema` ↔
`BlueBubblesConfig`, `characterSchema` ↔ `Character`, `AppRunSummarySchema` ↔
`AppRunSummary`, and `TokenPerformance` schema/type pairs. These are candidates
for pairing shared DTOs with runtime validation; they still require ownership
review before consolidation.

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
single-package ignored; runtime-schema/type matches fire; allowlist suppresses;
weak-types counted; baseline drift compares)
```

## 6. Advisory baseline (`--check`)

```
$ node packages/scripts/type-duplication-audit.mjs --check
[type-duplication-audit] drift vs baseline (advisory):
  = same-name multi-package clusters: 2231 / 2231 (0)
  = subset/superset candidates: 8174 / 8174 (0)
  = structural near-duplicates: 2624 / 2624 (0)
  = literal-set duplicates: 209 / 209 (0)
  = runtime schema ↔ exported type matches: 510 / 510 (0)
  = weak: as unknown as: 81 / 81 (0)
  = weak: as any: 0 / 0 (0)
  = weak: explicit : any: 126 / 126 (0)
# exit 0  (advisory — only --strict turns growth into a non-zero exit)
```

## 7. Type-safety ratchet

```
$ node packages/scripts/type-safety-ratchet.mjs
[type-safety-ratchet] scanned 9930 tracked production source files
[type-safety-ratchet] as unknown as: 81 / 81
[type-safety-ratchet] as any: 0 / 0
[type-safety-ratchet] explicit `: any` annotation: 126 / 126
[type-safety-ratchet] @ts-expect-error / @ts-ignore: 0 / 0
[type-safety-ratchet] non-null assertion (!): 565 / 565
[type-safety-ratchet] `?? ""` (core/agent/app-core): 627 / 627
[type-safety-ratchet] `?? []` (core/agent/app-core): 588 / 588
[type-safety-ratchet] `?? {}` (core/agent/app-core): 377 / 377
[type-safety-ratchet] `?? 0` (core/agent/app-core): 386 / 386
```

The iMessage cleanup removes production `as unknown as` double-casts from the
files this PR touched, and the CLI cleanup removed six non-null assertions; the
checked-in ratchet baseline was then synchronized after rebasing onto the latest
`origin/develop`, whose tracked source set moved.

## 8. Typecheck / lint

- **Root verify:** `bun run verify` — full workspace typecheck + lint + audit
  matrix, **495 successful / 495 total**.
- **Boundary tests:** `bunx vitest run plugins/__tests__/setup-routes-contract.test.ts packages/core/src/types/connector-setup.test.ts` —
  **2 test files / 63 tests passed**.
- **Duplication audit:** `bun run audit:type-duplication:self-test` and
  `bun run audit:type-duplication:check` — **passed**.
- **Type-safety ratchet:** `node packages/scripts/type-safety-ratchet.mjs` —
  **passed**.

## Evidence types — N/A

- **Live-LLM trajectory** — N/A: no agent/action/prompt/model path changes. This
  is a build-time type consolidation + advisory dev tooling; no runtime behaviour
  changes (the connector wire shapes are byte-identical, now sourced from one
  module).
- **Screenshots / video walkthrough / UI audit** — N/A: no UI surface touched.
- **Audio walkthrough** — N/A: no voice/TTS/STT.
- **Per-device capture** — N/A: no native/mobile/desktop change.

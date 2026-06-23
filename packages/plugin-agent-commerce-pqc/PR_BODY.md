# Relates to

New plugin — no existing issue. Opens discussion on ERC-8183 as a standard lifecycle for agent-to-agent commerce within elizaOS.

# Sync with develop

- [x] Rebased onto the latest `origin/develop`; zero conflicts
- [x] `bun run verify` passes post-sync

```
$ bun run verify
$ bun run type-check
$ tsc --noEmit -p tsconfig.json
(exit 0 — zero type errors)
```

> `bun run verify` in this package is defined as `tsc --noEmit` (see `package.json` scripts).
> A Vitest-based test suite is not included in this initial PR — see Testing section.

# Risks

**Medium.** This is a new, opt-in plugin. No existing elizaOS files are modified — all code is additive under `packages/plugin-agent-commerce-pqc/`. Registering the plugin adds one new `Service`, four `Actions`, and one `Provider` to an agent. Removing the plugin from the character's plugin list completely removes all behavior.

The only shared resource is the `memories` table (via `runtime.createMemory()`), which this plugin writes to under an `erc8183:job:` prefix. Collision with other plugins is prefix-guarded. Rate-limit state is process-local (`Map`), not database-backed — no risk of cross-agent contamination.

# Background

## What does this PR do?

Adds `packages/plugin-agent-commerce-pqc` — an elizaOS plugin implementing the [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) agentic commerce lifecycle. It allows one agent (client) to commission work from another agent (provider), record an escrowed amount, deliver a SHA-256-attested task specification, receive and verify a deliverable, evaluate it, and settle — using the elizaOS `Service` / `Action` / `Provider` extension points, with `runtime.createMemory()` for job persistence.

**State machine:**

```
OPEN → FUNDED → SUBMITTED → COMPLETE
                           ↘ REFUND
              ↘ EXPIRED
         ↘ ABORTED  (security abort at any stage)
```

**elizaOS extension points registered:**

| Extension point | Name | Role |
|---|---|---|
| `Service` | `AgentCommerceService` (`agent_commerce`) | Owns `ElizaJobStore`, `ReputationProvider`, `SecurityGuard` — one instance per runtime |
| `Action` | `CREATE_SECURE_JOB` | Create an ERC-8183 job |
| `Action` | `FUND_SECURE_JOB` | Fund escrow and deliver SHA-256-attested task spec to provider |
| `Action` | `SUBMIT_DELIVERABLE` | Provider submits work with hash attestation |
| `Action` | `JOB_STATUS` | Query current job state |
| `Provider` | `COMMERCE_CONTEXT` | Injects up to 5 most recent jobs into the LLM context window |

**State storage** — jobs are persisted via `ElizaJobStore`, which wraps `runtime.createMemory()` under the `memories` table with an `erc8183:job:<id>` prefix. Write: every state transition appends a new memory record (no destructive updates, `unique: false`). Read: in-memory `Map` cache with lazy hydration on first access.

**Recovery after restart** — hydration is lazy and race-safe via a Promise-mutex:

```ts
private hydrate(): Promise<void> {
  if (!this.hydratePromise) {
    this.hydratePromise = this._doHydrate();
  }
  return this.hydratePromise;
}
```

All concurrent callers await the same `Promise`. On hydration, the record with the highest `updatedAt` wins (latest state). Hydration failure is non-fatal.

## What kind of change is this?

Feature — non-breaking, additive. No existing files modified.

# Documentation changes needed?

My changes do not require a change to the project documentation. A `README.md` is included in the package.

# Testing

## Where should a reviewer start?

1. `src/elizaos/index.ts` — plugin registration shape
2. `src/service.ts` — `AgentCommerceService` wiring store + reputation + security
3. `src/state-machine.ts` — ERC-8183 transitions
4. `src/store/elizaos.ts` — `ElizaJobStore` with hydration race fix
5. `demo-lifecycle.ts` — runnable lifecycle demo (see Evidence below)

## Detailed testing steps

Run the included lifecycle demo against the real plugin code (no framework boot required):

```bash
cd packages/plugin-agent-commerce-pqc
LOG_LEVEL=info bun run demo-lifecycle.ts
```

This exercises: plugin registration → service startup → `createJob` → `fundJob` → `submitJob` → `evaluateJob` (COMPLETE) → provider output → abort path (ABORTED).

A Vitest integration test suite adapting the upstream test coverage to the elizaOS monorepo harness is tracked as follow-up work.

# Evidence (prove the real thing happened — see PR_EVIDENCE.md)

## Real LLM-call trajectory

N/A — no scenario-runner scenarios exist for this plugin yet. Action `validate()` is keyword-based (no LLM call). Handler logic is a pure state machine with deterministic transitions. A scenario-runner integration is planned as follow-up once the plugin is merged and can be wired into the harness.

## Backend + frontend logs

**Real plugin execution log** (`LOG_LEVEL=info bun run demo-lifecycle.ts`, 2026-06-24):

```
═══════════════════════════════════════════════════════
 plugin-agent-commerce-pqc  |  ERC-8183 lifecycle demo 
═══════════════════════════════════════════════════════

── [1] Plugin registration ──────────────────────────────
  name:     agent-commerce
  services: agent_commerce
  actions:  CREATE_SECURE_JOB, FUND_SECURE_JOB, SUBMIT_DELIVERABLE, JOB_STATUS
  providers:COMMERCE_CONTEXT

── [2] AgentCommerceService.start(runtime) ─────────────
  service type:  agent_commerce
  job store:     ElizaJobStore
  reputation:    StaticReputationProvider
  security guard initialized

── [3] ERC8183StateMachine.createJob ───────────────────
 Info       #agent-commerce  [ERC-8183] Created job job-3bff7055 (OPEN)
  jobId:    job-3bff7055
  state:    OPEN
  client:   agent-alice
  provider: agent-bob
  amount:   1000000

── [4] ERC8183StateMachine.fundJob ─────────────────────
 Info       #agent-commerce  [ERC-8183] Funded job job-3bff7055 with 1000000 (state: FUNDED)
  state:      FUNDED
  task hash:  696d3d6b3f50b27c…
  funded at:  2026-06-23T20:18:26.629Z

── [5] ERC8183StateMachine.submitJob ───────────────────
 Info       #agent-commerce  [ERC-8183] Submitted deliverable for job job-3bff7055
            (hash: e1303c864e708f8c8e7cd1f134b7a2fe4dc09ef8786a15136b873c94932068cb)
  state:           SUBMITTED
  deliverable hash: e1303c864e708f8c…
  hash verified:   true

── [6] ERC8183StateMachine.evaluateJob (ACCEPT) ────────
 Info       #agent-commerce  [ERC-8183] Evaluated job job-3bff7055: ACCEPT → COMPLETE
  state:    COMPLETE
  reason:   API meets all requirements
  settled:  2026-06-23T20:18:26.630Z

── [7] commerceProvider context injection ───────────────
  provider output:
  [Commerce] No active jobs. You can create one with
  "Create a job for <provider> to <task>, budget <amount>"

── [8] ElizaOS memory persistence ──────────────────────
  Total createMemory() calls: 4
  (one per state transition → append-only, no destructive updates)

── [9] Abort path (hash mismatch simulation) ───────────
 Info       #agent-commerce  [ERC-8183] Created job job-a21046eb (OPEN)
 Info       #agent-commerce  [ERC-8183] Funded job job-a21046eb with 500000 (state: FUNDED)
 Error      #agent-commerce  [SECURITY-ALERT] Aborted job job-a21046eb:
            [SECURITY-ALERT] HASH_MISMATCH_ALERT task payload
  state:  ABORTED
  reason: [SECURITY-ALERT] HASH_MISMATCH_ALERT task payload

═══════════════════════════════════════════════════════
 RESULT: All 7 lifecycle transitions executed correctly 
═══════════════════════════════════════════════════════
```

The elizaOS `#agent-commerce` logger lines (`Info`, `Error`) are emitted by the real `createLogger({ namespace: 'agent-commerce' })` from `@elizaos/core`, not mocked. The mock runtime provides `createMemory` / `getMemories` backed by an in-memory array to avoid framework bootstrap.

## Screenshots (before / after) + video walkthrough

N/A — this is a backend service plugin with no UI surface.

## Audio / voice walkthrough

N/A — no voice/TTS/STT changes.

---

## Known limitations

- **No Vitest test suite in this PR.** Tests for the plugin logic were developed in the upstream project against a local mock runtime. Adapting them to the elizaOS monorepo Vitest harness (using `@elizaos/core/testing`) is tracked as follow-up.
- **Hydration ceiling:** `ElizaJobStore._doHydrate()` fetches at most 1000 memory records. Not configurable in this release.
- **Rate limiting is process-local:** `SecurityGuard.rateLimitStore` is in-memory; not shared across processes.
- **Evaluators pending schema adaption:** security evaluation and job tracking run inside `AgentCommerceService`. Adapting to elizaOS's schema-based `Evaluator` interface is tracked as a follow-up PR.

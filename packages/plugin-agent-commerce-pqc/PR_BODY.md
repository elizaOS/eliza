# Relates to

New plugin — no existing issue. Opens discussion on ERC-8183 as a standard lifecycle for agent-to-agent commerce within elizaOS.

# Sync with develop

- [x] Rebased onto the latest `origin/develop`; zero conflicts
- [x] `bun run verify` passes post-sync

Within `packages/plugin-agent-commerce-pqc`:

```
$ bun run verify
$ tsc --noEmit -p tsconfig.json && bunx vitest run --config vitest.config.ts

 RUN  v4.1.5

 Test Files  1 passed (1)
      Tests  35 passed (35)
   Duration  18.72s

EXIT: 0
```

# Risks

**Medium.** New, opt-in plugin — no existing elizaOS runtime behavior is modified. All code is additive under `packages/plugin-agent-commerce-pqc/`. Registering the plugin adds one `Service`, four `Actions`, and one `Provider` to an agent. Removing the plugin from the character's plugin list completely removes all behavior.

The only shared resource is the `memories` table (via `runtime.createMemory()`), which this plugin writes under an `erc8183:job:` prefix. Collision with other plugins is prefix-guarded. Rate-limit state is process-local (`Map`), not database-backed — no cross-agent contamination.

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

Feature — non-breaking, additive. No existing elizaOS runtime behavior is modified.

# Documentation changes needed?

My changes do not require a change to the project documentation. A `README.md` is included in the package.

# Testing

## Where should a reviewer start?

1. `src/elizaos/index.ts` — plugin registration shape
2. `src/service.ts` — `AgentCommerceService` wiring store + reputation + security
3. `src/state-machine.ts` — ERC-8183 state transitions
4. `src/store/elizaos.ts` — `ElizaJobStore` with hydration race fix
5. `__tests__/plugin.shape.test.ts` — 35 Vitest tests covering all extension points

## Detailed testing steps

```bash
cd packages/plugin-agent-commerce-pqc
bun run verify          # type-check + vitest (35 tests)
LOG_LEVEL=info bun run demo-lifecycle.ts   # full lifecycle demo with real logs
```

`demo-lifecycle.ts` exercises the full path without framework bootstrap: plugin registration → service startup → `createJob` → `fundJob` → `submitJob` → `evaluateJob` (COMPLETE) → provider output → abort path (ABORTED).

# Evidence (prove the real thing happened — see PR_EVIDENCE.md)

## Real LLM-call trajectory

N/A — no scenario-runner scenarios exist for this plugin yet. Action `validate()` is keyword-based (no LLM call in the hot path). Handler logic is a pure state machine with deterministic transitions. Scenario-runner integration is planned as follow-up once the plugin is merged.

## Backend + frontend logs

**`bun run verify` output** (2026-06-24, `packages/plugin-agent-commerce-pqc`):

```
$ tsc --noEmit -p tsconfig.json && bunx vitest run --config vitest.config.ts

 RUN  v4.1.5 /packages/plugin-agent-commerce-pqc

 ❯ __tests__/plugin.shape.test.ts (35 tests)

   Plugin shape
     ✓ exports plugin with correct name
     ✓ registers exactly one service: agent_commerce
     ✓ registers 4 actions
     ✓ registers 1 provider: COMMERCE_CONTEXT
     ✓ does not register evaluators (schema-based adaption pending)

   AgentCommerceService
     ✓ starts with ElizaJobStore when runtime is provided
     ✓ starts with MemoryJobStore when no runtime is provided
     ✓ accepts config overrides for jobStore and reputationProvider
     ✓ reads COMMERCE_MIN_REPUTATION from runtime settings

   ERC8183StateMachine
     ✓ createJob → OPEN
     ✓ fundJob → FUNDED
     ✓ submitJob → SUBMITTED
     ✓ evaluateJob ACCEPT → COMPLETE
     ✓ evaluateJob REJECT → REFUND
     ✓ abortJob → ABORTED (idempotent on second call)
     ✓ rejects fundJob from non-client agent
     ✓ rejects invalid state transition (fund already-funded job)

   PayloadHasher
     ✓ produces a stable hex hash for the same payload
     ✓ hash is deterministic regardless of key insertion order
     ✓ verifyHash returns true for matching payload
     ✓ verifyHash returns false for tampered payload

   StaticReputationProvider
     ✓ allows funding when reputation meets minScore
     ✓ denies funding when minScore threshold cannot be met

   MemoryReputationProvider
     ✓ returns 100 for unknown agents (default)
     ✓ seeds score for specific agents via initialScores config
     ✓ increments score after successful outcome (from non-max seed)
     ✓ decrements score after failed outcome (-5 per failure)

   CompositeReputationProvider
     ✓ requires all providers to approve (AND semantics)
     ✓ approves when all providers approve

   ElizaJobStore hydration
     ✓ concurrent get() calls trigger only one getMemories() call
     ✓ clear() resets hydratePromise so next get() re-hydrates

   Action validate() contracts
     ✓ CREATE_SECURE_JOB matches "create job/task" variants
     ✓ FUND_SECURE_JOB matches "fund job" variants
     ✓ SUBMIT_DELIVERABLE matches "submit work" variants
     ✓ JOB_STATUS matches "check status" variants

 Test Files  1 passed (1)
      Tests  35 passed (35)
   Duration  18.72s
```

**Real plugin execution log** (`LOG_LEVEL=info bun run demo-lifecycle.ts`, 2026-06-24):

```
── [2] AgentCommerceService.start(runtime) ─────────────
  service type:  agent_commerce
  job store:     ElizaJobStore
  reputation:    StaticReputationProvider
  security guard initialized

── [3] ERC8183StateMachine.createJob ───────────────────
 Info  #agent-commerce  [ERC-8183] Created job job-3bff7055 (OPEN)

── [4] ERC8183StateMachine.fundJob ─────────────────────
 Info  #agent-commerce  [ERC-8183] Funded job job-3bff7055 with 1000000 (state: FUNDED)

── [5] ERC8183StateMachine.submitJob ───────────────────
 Info  #agent-commerce  [ERC-8183] Submitted deliverable for job job-3bff7055
       (hash: e1303c864e708f8c8e7cd1f134b7a2fe4dc09ef8786a15136b873c94932068cb)

── [6] ERC8183StateMachine.evaluateJob (ACCEPT) ────────
 Info  #agent-commerce  [ERC-8183] Evaluated job job-3bff7055: ACCEPT → COMPLETE

── [8] ElizaOS memory persistence ──────────────────────
  Total createMemory() calls: 4
  (one per state transition → append-only, no destructive updates)

── [9] Abort path (hash mismatch simulation) ───────────
 Info   #agent-commerce  [ERC-8183] Created job job-a21046eb (OPEN)
 Info   #agent-commerce  [ERC-8183] Funded job job-a21046eb with 500000 (state: FUNDED)
 Error  #agent-commerce  [SECURITY-ALERT] Aborted job job-a21046eb:
        [SECURITY-ALERT] HASH_MISMATCH_ALERT task payload

═══════════════════════════════════════════════════════
 RESULT: All 7 lifecycle transitions executed correctly 
═══════════════════════════════════════════════════════
```

The `#agent-commerce` logger lines are emitted by the real `createLogger({ namespace: 'agent-commerce' })` from `@elizaos/core`. The mock runtime wires `createMemory` / `getMemories` to an in-memory array to avoid full framework bootstrap.

## Screenshots (before / after) + video walkthrough

N/A — backend service plugin with no UI surface.

## Audio / voice walkthrough

N/A — no voice/TTS/STT changes.

---

## Known limitations

- **Hydration ceiling:** `ElizaJobStore._doHydrate()` fetches at most 1000 memory records per agent. Not configurable in this release.
- **Rate limiting is process-local:** `SecurityGuard.rateLimitStore` is in-memory; not shared across processes in a horizontally scaled deployment.
- **Evaluators pending schema adaption:** security evaluation and job tracking run inside `AgentCommerceService`. Adapting to elizaOS's schema-based `Evaluator` interface is tracked as a follow-up PR.

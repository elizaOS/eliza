# Economics `/goal` runbook — autonomous monetized-app loop

How to drive (and what currently blocks) a `/goal` sub-agent that autonomously
runs the monetized-app loop: create app → deploy container → enable monetization
→ buy a domain → stay alive on earnings, with paid Cloud commands auto-authorized
within a spend cap.

## What already works (verified)

- **Capped self-spend allowance.** `decideSpendAuthorization`
  (`src/services/spend-allowance.ts`) gates each Cloud command by risk/cap, and
  `runCloudCommand` (`src/services/parent-agent-broker.ts:1067`) emits the
  structured `event: "spend_auto_authorized"` log when a self-spend command
  auto-authorizes within `ELIZA_AGENT_SPEND_CAP_USD`. Confirmed by
  `src/__tests__/parent-agent-broker.test.ts` › _capped self-spend allowance_
  (4 cases pass: within-cap auto-authorizes, over-cap confirms, non-self-spend
  mutating auto-authorizes).
- **Economics capability profile.** `/economics` (or `/monetize`,
  `/monetized-app`) in the composer sets `metadata.capabilityProfile = "economics"`
  (`plugin-task-coordinator` composer directives → `createOrchestratorTask`), and
  `spawnAgentForTask` reads `coerceGoalCapabilityProfile(task.metadata.capabilityProfile)`
  and widens the goal fence via `ECONOMICS_GOAL_CAPABILITIES` (`goal-prompt.ts`).
- **The Cloud loop itself.** `apps.create → monetization.update → domains.buy
  (real credit debit) → earnings → survival economics` is exercised end-to-end
  against the mock stack by
  `packages/test/cloud-e2e/tests/monetized-app-loop.spec.ts`.

## Runbook

1. Boot a stubbed-but-real Cloud so paid commands succeed without real money:

   ```bash
   CLOUD_E2E=1 NODE_ENV=test bun run cloud:mock --reset
   # note the printed "Ready on http://127.0.0.1:<apiPort>"
   ```

   `cloud:mock` opens its PGlite store as a single-writer file, so you cannot
   seed an org/API key from a second process while it runs. To seed live (and to
   give the broker a key the granular per-route permission gate accepts), boot
   through the cloud-e2e stack fixture instead — it stands up a PGlite **TCP
   bridge** + the same wrangler launcher, then `seedTestUser()` mints an org with
   credits + an API key. Mint the key with `permissions: ["*"]` if you want the
   actual `containers.create` / `domains.buy` cloud calls to succeed (the default
   `read/write/admin` seed key still proves `spend_auto_authorized`, because that
   log fires from the cap decision *before* the HTTP call — but the call itself
   401s on routes that require granular scopes like `containers:write`).

2. Point the broker at the mock and arm the spend cap (these resolve through
   `config-env.ts`, so the eliza config `env` section or process env both work):

   ```bash
   ELIZA_CLOUD_BASE_URL=http://127.0.0.1:<apiPort>
   ELIZAOS_CLOUD_API_KEY=<a seeded org API key>      # see cloud-e2e seedTestUser
   ELIZA_AGENT_SPEND_CAP_USD=20
   ELIZA_ACP_DEFAULT_AGENT=opencode                   # Cerebras auto-detected; or codex/claude with their keys
   OPENCODE_DISABLE_AUTOUPDATE=1                       # opencode's network update check can blow the spawn timeout
   ACPX_DEFAULT_TIMEOUT_MS=600000                      # first opencode init (compile + provider fetch) ~3-5min
   ```

3. Create an economics task — `/economics build and monetize a tiny app` in the
   composer, or `POST /api/orchestrator` with
   `metadata: { capabilityProfile: "economics" }`.

4. The sub-agent loads the `build-monetized-app` skill and SKILLS.md and drives
   the loop through the parent-agent broker. Watch the logs for
   `event: "spend_auto_authorized"` on `containers.create` / `domains.buy` —
   that line is the proof the agent spent within its cap without a human prompt.

   - **Domains gotcha:** `domains.buy` (and `media.*`/`promote.*`) resolve to
     unknown cost and stall on confirmation unless the agent first calls
     `domains.check` and threads the quote into `params.spendEstimateUsd`.
     `containers.create` has a built-in `$0.67/day` estimate, so it
     auto-authorizes without a hint.
   - **`containers.create` needs a `name`** in addition to `appId`/`image`, or
     the cloud call 422s (the spend log still fires; the deploy record is not
     created). A capable agent self-corrects via `list-cloud-commands`.

## Sub-agent → broker dispatcher (now wired)

`runCloudCommand` (the only emitter of `spend_auto_authorized`) is now reachable
by a live agent. The three gaps the earlier draft of this runbook called out are
closed:

1. **Dispatch.** `SubAgentRouter.handleEvent` accumulates the child's streamed
   `message` text and, when a complete `USE_SKILL parent-agent <json>` directive
   appears, bridges it to `runParentAgentBroker({ runtime, sessionId, session,
   args })` and streams `result.text` back via `acp.sendToSession`
   (`src/services/parent-agent-dispatch.ts`). Detection is marker-guarded (it
   only acts on text containing `USE_SKILL parent-agent`, which ordinary coding
   tasks never emit) and capped by `ACPX_SUB_AGENT_ROUND_TRIP_CAP`.
2. **Advertise.** `spawnAgentForTask` writes a `SKILLS.md` into the workdir for
   `capabilityProfile === "economics"` tasks via `buildSkillsManifest(runtime, {
   recommendedSlugs: ["build-monetized-app", "eliza-cloud"], virtualSkills:
   [PARENT_AGENT_BROKER_MANIFEST_ENTRY] })`, so the child learns the `parent-agent`
   slug and its arg contract.
3. **Estimate.** The broker's unknown-cost stall now returns an *actionable*
   instruction ("fetch a quote with `domains.check` and retry with
   `params.spendEstimateUsd`") instead of a human-only yes/no, and the manifest
   guidance advertises the same pattern — so an autonomous agent self-authorizes
   `domains.buy` within the cap without a human turn.

The directive parser and the broker→`sendToSession` bridge are unit-tested in
`src/__tests__/parent-agent-dispatch.test.ts`; `spend_auto_authorized` itself
stays covered by `parent-agent-broker.test.ts`.

## Live verification (2026-06-06)

The full loop was run end-to-end against `cloud:mock` with a real
`opencode` ACP child on a Cerebras key (`gpt-oss-120b`) — no human in the loop:

- The child read `SKILLS.md`, then drove `cloud.health → apps.create →
  containers.create` entirely through `USE_SKILL parent-agent {…}` directives.
  `apps.create` created a real app; `containers.create` self-authorized within
  the cap and emitted, verbatim:
  `event:"spend_auto_authorized" command:"containers.create" risk:"paid"
  estimatedCostUsd:0.67 runningTotalUsd:0.67 capUsd:20 reason:"within-cap"`.
  When the first `containers.create` 422'd (missing `name`), the child called
  `list-cloud-commands`, corrected the params, and re-authorized — no human turn.
- The `domains.buy` self-resolve path was verified at the broker level against
  the same live mock: `domains.check` returned a `$14.95` quote, that price was
  threaded into `params.spendEstimateUsd`, `domains.buy` emitted
  `spend_auto_authorized` ($14.95 of the $20 cap), and the org credit balance
  dropped **1000.00 → 985.05** — a real debit.

Two defects the live run surfaced (both fixed):

1. **Windows env forwarding (`acp-service.ts`).** `shouldForwardEnv` matched
   `PATH` case-sensitively, but the repo runtime is Bun and Bun-on-Windows
   reports the key as `Path` — so ACP sub-agents spawned with NO `PATH` and the
   opencode shim died with `'bun' is not recognized`. Now matched
   case-insensitively (+ Windows system vars), with the path key canonicalized
   to `PATH` in `buildEnv`.
2. **Mid-turn reply delivery (`parent-agent-dispatch.ts`).** A child emits its
   directive *mid-turn* and ends the turn awaiting the reply; delivering the
   reply is a new prompt, which the transport rejects ("session is already
   busy") until the turn finishes. The old code dropped the reply, stalling the
   loop on the first directive. Delivery now retries until the session goes idle.

See `default-eliza-skills-and-agent-bridge-plan.md` for the broader bridge design;
this runbook is the economics-specific slice.

# Orchestrator (`/orchestrator`) build-out — status & follow-ups

Date: 2026-05-29. Companion to [`research/orchestrator-view-research-report.md`](./research/orchestrator-view-research-report.md).

This records what was finished in the `nubs/orchestrator-view-feature` branch and the
exact, code-grounded plan for the remaining design-heavy work. The earlier research
report is largely **out of date**: the durable task model, SQL store, `/api/orchestrator/*`
routes, central goal-wrapper, validation-gated completion, token aggregation, the
`OrchestratorWorkbench` view, and the real (non-stub) client methods all already exist
(Shaw shipped most of it on 2026-05-29). Verify against current code, not the report's
line numbers.

## Done in this branch (verified)

1. **Mounted the sub-agent credential bridge** (`plugin-agent-orchestrator/src/api/routes.ts`).
   `handleBridgeRoutes` was built+tested but never dispatched. + dispatcher regression test.
2. **Unified the goal-wrapper** so the `TASKS` planner action uses the central
   `buildGoalPrompt`/`buildGoalFollowUp` (`goal-prompt.ts`, `actions/tasks.ts`) instead of a
   divergent inline envelope. Workspace-routing / URL-mapping / swarm-room content preserved
   via new optional `GoalPromptInput` fields. + equivalence test (action env == API env).
3. **Folded durable task threads into `getCodingAgentStatus`** (`packages/ui` client) — was
   hardcoded to `taskThreadCount:0`. Documented the two genuinely-vestigial ACP stubs
   (`/metrics`, `/workspace-files`) pointing at the real `/api/orchestrator/*` usage surface.
4. **Declared capability param schemas** for the 15 orchestrator view capabilities so
   voice/NL routing can pass `taskId`/`title`/`goal`/etc. **Mounted the sensitive-request
   REST routes** (`packages/app-core/src/api/server.ts`) — the secret create/submit/fulfill
   path that orchestrator provider setup will use.
5. **Locked capability manifest↔dispatch parity** with a regression test
   (`plugin-task-coordinator/__tests__/unit/orchestrator-capability-parity.test.ts`) + a
   `test` script so CI runs it. The declared capabilities (`ORCHESTRATOR_CAPABILITIES` in
   `index.ts`) must exactly match the ids `runOrchestratorCapability` dispatches; this drift
   previously reopened (`orchestrator-update-task`/`-validate-task`).

## App-shell hardening (this branch)

**Stale/unreachable saved server can no longer wedge first-run.** A persisted
`elizaos:active-server` pointing at a now-dead / CSP-blocked remote backend pinned the
client to that address; the startup poll (`packages/ui/src/state/startup-phase-poll.ts`)
retried it until `BACKEND_TIMEOUT` and onboarding hung forever (clearing cookies didn't
help — the pointer lives in localStorage). Fix: on a *connection-level* failure (the request
never received an HTTP response) against a non-loopback, non-same-origin base on an http(s)
page — never on native mobile, where the remote IS the agent — clear the saved server,
re-point the client at the local origin, and reach the backend (one-shot). The decision is a
pure exported `shouldFallBackToLocalOrigin` covered by a unit matrix, plus an end-to-end
recovery test.

**Onboarding boot issues we hit that are environmental, not code bugs (no regression test
applies):**
- *"No provider registered for TEXT_EMBEDDING" → agent won't boot* — caused by a local
  `ELIZA_DISABLE_LOCAL_EMBEDDINGS=1` in `.env.worktree` with no cloud route, i.e. *zero*
  embedding providers. With local embeddings enabled the agent boots degraded-but-non-fatal
  (the intended behavior). A graceful-degradation guard for the "no embedding provider at
  all" edge would live in agent/runtime bootstrap, not here; flagged for the runtime owner.
- *Dev service-worker / HTTPS-upgrade theories* — investigated and **disproven** by
  reproduction; the actual cause was the stale active-server above. The dev SW renders fine
  with caching active. An optional dev-only self-unregistering SW remains available as a
  hygiene improvement but guards no confirmed bug.

## Remaining work (specced, not yet built)

Ordered by leverage. `[BE]` backend, `[FE]` frontend, `[T]` tests.

### A. `orchestrator-open-task` should navigate the workbench `[FE]` — S/M
`runOrchestratorCapability` ("open-task") fetches detail but does not call `setSelectedId`,
so a voice "open task X" returns data without visually navigating. `interact()` is a
module-level function with no handle to the live component state. Fix: have the workbench
register a navigation callback (e.g. a module-scoped `setSelectedTaskHandler` the mounted
`OrchestratorWorkbench` sets in a `useEffect`, called by the open-task capability), or route
selection through the existing `?task=` deep-link that `readInitialTaskId` already reads.

### B. Bridge-backed provider setup `[BE][FE]` — M (design-touching)
Today `LlmProviderSection`/`CodingAgentSettingsSection` write `ANTHROPIC_API_KEY` etc.
straight into agent env via `client.updateConfig({ env })` — not the vault. Now that the
sensitive-request REST routes are mounted, wire missing-key flows to fire `SECRETS
action=request` (or POST `/api/sensitive-requests`) so secrets land in `sharedVault`. Reuse
the existing `ProviderCard`/`ProviderPanels`/`useProviderSelection` components rather than the
bespoke password inputs. Needs a decision on which providers/scopes/validation; do not change
secret-storage policy without the design owner. Secure-cloud / secure-local / insecure-local
fallbacks + redaction tests per the report's "Secret And OAuth Flow" section.

### C. Workbench UX gaps `[FE]` — small each, need visual iteration
From the fidelity review of `OrchestratorWorkbench.tsx` (largely complete; these are the gaps):
- **Jump-to-latest / autoscroll** in the timeline — no scroll ref/affordance today (net-new).
- **Change-provider control** — no UI and no `orchestrator-change-provider` capability/backend; provider policy is read-only. Needs a backend capability first.
- **Branch display** in the sub-agent roster (only repo/workdir shown).
- **System-event collapse**: only a global show/hide toggle, not expandable clusters.
- **Verification checklist**: only per-artifact status pills, no dedicated pass/fail surface.
- **Per-task USD spend** in the left rail (rail shows tokens; cost only in header + inspector).
- **Provider "state"**: shows policy/identity, not live health/availability.

### D. Remote / mobile for the orchestrator `[BE][FE]` — L (separate design)
Pairing primitives exist (`auth-pairing-routes`, `tunnel-to-mobile-client`) but **no `tunnel`
runtime service is registered** (so `runtime.getService("tunnel")` lookups and
`tunnel_authenticated_link` delivery are inert). The workbench is **polling-only**
(`POLL_INTERVAL_MS = 5000`); there is no SSE/WS for task updates. Needs: a registered tunnel
service (`getStatus/isActive/getUrl`), a relay decision (cloud gateway vs Headscale/ngrok per
the tunnel-to-mobile design), remote-API auth, and SSE/WS to replace the 5s poll so remote/
mobile clients aren't hammering. Do not attempt blind — design + visual iteration required.

### E. Test depth `[T]`
Add the report's e2e workflow matrix with mocked providers (create/fork/pause-all/archive/
search/secret-flows/validation-failure-reopen), keeping live Claude/Codex tests env-gated.
Also add an integration-level test that drives a `/credentials/*` request through the runtime
route matcher (`matchPluginRoutePath`), not just the in-process dispatcher, so the
registry-registration gap (fixed in this branch) can't silently reopen.

### F. Deferred from adversarial review (low priority, not regressions)
- **Bridge loopback hardening** `[BE]` — `bridge-routes.ts:isLoopback` trusts only
  `req.socket.remoteAddress` (same model as the existing parent-context bridge). If the
  runtime is ever fronted by a loopback-bound reverse proxy, mirror the extra checks from
  `isTrustedLocalRequest` (reject forwarded/proxy-client headers and cross-site
  `sec-fetch-site`). The single-use scopedToken remains the per-request defense regardless.
- **Re-anchor follow-ups to the durable goal** `[BE]` — `buildGoalFollowUp` reads
  `metadata.goal`, but the planner spawn paths in `tasks.ts` never stamp a `goal` key, so
  follow-ups currently re-anchor to the latest message rather than the original objective.
  Stash `goal: task` (or the durable goal) onto session metadata at spawn time to realize
  the intended re-anchoring. Not a regression — the old code sent raw text.

## How to work this branch
Isolated worktree `/home/nubs/Git/iqlabs/eliza-labs/eliza-orchestrator-feat`, branch
`nubs/orchestrator-view-feature`. Fresh worktrees need `@elizaos/core` built first
(`cd packages/core && bun run build`) or vitest can't resolve `@elizaos/core`; building the
full plugin set is required to run app-core integration tests. Rebase onto the active branch
before merging (file sets don't overlap with the desktop/local-inference work in flight).

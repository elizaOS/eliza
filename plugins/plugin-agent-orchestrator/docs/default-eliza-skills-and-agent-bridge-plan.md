# Default Eliza Skills And Agent Bridge Plan

Date: 2026-05-10

## Goal

Make Eliza's default task workers self-sufficient:

- They should receive editable, repo-owned default skills for Eliza, elizaOS plugin/app development, Eliza Cloud APIs, and monetization.
- Claude, Codex, OpenCode, Gemini, Aider, and other orchestrated workers should receive those defaults through the agent orchestrator.
- Applications should be able to override defaults without forking the shipped skill package.
- Workers should be able to ask the running parent Eliza agent for context or actions that only the parent can perform.
- Paid, private, or destructive operations should remain mediated by the parent agent and its confirmation flow.

## Current Inventory

### Shipped skills

Repo-owned default skills live under:

```text
packages/skills/skills/<slug>/SKILL.md
```

The `@elizaos/skills` package publishes those files. Runtime startup wires bundled, workspace, and extra skill roots through `packages/agent/src/runtime/eliza.ts`. Managed/workspace copies override bundled defaults.

Relevant shipped skills now include:

- `eliza` for the running Eliza app, parent-agent callback protocol, capabilities, and lifecycle.
- `elizaos` for upstream runtime/plugin abstractions.
- `eliza-app-development` for this app repo's build and edit workflow.
- `eliza-cloud` for Cloud APIs, apps, credits, billing, containers, domains, auth, and earnings.
- `build-monetized-app` for the new-app deploy and monetization loop.
- `task-agent-eliza-bridge` for low-level task-agent bridge details.

### Agent orchestration

The task agent infrastructure is in `plugins/plugin-agent-orchestrator`.

Important surfaces:

- `src/services/pty-service.ts` spawns agents, writes adapter memory files, injects parent runtime loopback context, and manages session lifecycle.
- `src/actions/coding-task-handlers.ts` prepares `SKILLS.md`, recommends skills, spawns task sessions, and registers per-session skill allow-lists.
- `src/services/skill-manifest.ts` renders the task-local manifest and virtual broker skills.
- `src/services/skill-callback-bridge.ts` listens for child output lines matching `USE_SKILL <slug> <json_args>` and routes them back to the parent runtime.
- `src/services/skill-lifeops-context-broker.ts` already exposes task-scoped LifeOps context.

### Cloud and monetization

Current Cloud source-of-truth files:

- OpenAPI: `cloud/apps/api/openapi.json/route.ts`
- SDK: `cloud/packages/sdk/src/client.ts`
- billing/pricing: `cloud/packages/lib/services/ai-billing.ts`, `ai-pricing.ts`, `credits.ts`
- app chat: `cloud/apps/api/v1/apps/[id]/chat/route.ts`
- OpenAI-compatible chat: `cloud/apps/api/v1/chat/completions/route.ts`
- app monetization: `cloud/apps/api/v1/apps/[id]/monetization/route.ts`
- app credits: `cloud/packages/lib/services/app-credits.ts`
- container billing: `cloud/apps/api/cron/container-billing/route.ts`

Active app monetization is markup/share based. Inference in the current app-chat path debits the caller/user org credits and credits creator markup to redeemable earnings. App-credit purchase/share flows exist, but should not be assumed to fund inference unless the endpoint being edited explicitly does so.

## Implemented Architecture

### Default editable skills

Default skills remain bundled in `@elizaos/skills` and are seeded into the managed skills directory only when the user does not already have an editable copy.

Applications and workspaces can override defaults by placing a same-slug skill in a higher-priority skill root. This preserves:

- global defaults included with Eliza
- user/application customization
- stable slugs for orchestrator recommendation and invocation
- short `SKILL.md` bodies with longer references under `references/`

The root `scripts/ensure-skills.mjs` now resolves the shipped skill tree from `@elizaos/skills`, then falls back to `packages/skills/skills`, then legacy `skills/`.

### Parent-agent broker

A new virtual broker skill, `parent-agent`, lets a child ask the running parent Eliza agent to use its loaded capabilities:

```text
USE_SKILL parent-agent {"request":"Find the next open 30 minute slot on my calendar tomorrow afternoon"}
```

The broker builds a synthetic message memory and sends it through the parent's normal `messageService.handleMessage(...)` pipeline with `continueAfterActions: true`. This means the parent can use the same actions, providers, services, connectors, model handlers, confirmation policies, and user approval flow it already uses for normal chat.

It also supports action discovery:

```text
USE_SKILL parent-agent {"mode":"list-actions","query":"github","limit":25}
```

Sensitive broker access is session allow-listed. The orchestrator includes `parent-agent` in generated manifests for coding-task sessions and registers the manifest slugs as the session allow-list.

### Worker manifest

`SKILLS.md` now tells workers to emit a standalone `USE_SKILL <slug> <json_args>` line. The orchestrator writes this manifest into the workspace and sets `ELIZA_SKILLS_MANIFEST`, so Codex/Claude/Gemini/Aider-style workers can discover skill protocol without hardcoding.

The injected parent runtime memory also now explains:

- read-only loopback endpoints
- `ELIZA_SKILLS_MANIFEST` / `SKILLS.md`
- `USE_SKILL parent-agent`
- `USE_SKILL lifeops-context`
- when to ask the parent for connector/private/paid actions

### Git hygiene

The orchestrator-managed gitignore block now includes common generated agent files:

- `CLAUDE.md`
- `.claude/`
- `AGENTS.md`
- `.codex/`
- `GEMINI.md`
- `.gemini/`
- `.aider*`
- `.opencode/`
- `SKILLS.md`

Tracked repo files with the same names still need care; ignore rules only prevent new untracked files from being committed.

## Security Model

The child worker never receives the parent API key, full memory dump, or raw connector credentials.

Allowed paths:

- read-only loopback endpoints for bounded parent context
- `USE_SKILL` directives for session allow-listed skill/broker slugs
- parent-agent requests mediated by the parent message pipeline
- parent confirmation flow for paid, destructive, private, or external operations

Denied or discouraged paths:

- ad hoc POSTs to loopback context endpoints
- bypassing Cloud/user confirmation for paid steps
- directly recreating parent credentials inside a child workspace
- treating task-agent output as a persistent authenticated identity

## Five-Pass Implementation Plan

### Pass 1: Prep

- Inventory shipped skills and confirm `@elizaos/skills` is the bundled default source.
- Inventory orchestrator spawn/memory/manifest/callback code.
- Inventory Cloud billing, monetization, app chat, SDK, and container deploy source-of-truth files.
- Decide stable slugs and default override model.
- Define task-scoped broker protocol and sensitive-broker allow-list behavior.

Status: implemented for the default skill and broker surfaces.

### Pass 2: Implementation

- Add `eliza` default skill and references.
- Expand app-development, Cloud, monetization, and task-agent bridge skills.
- Fix root shipped-skill seeding to resolve `@elizaos/skills`.
- Add `parent-agent` virtual broker.
- Include `parent-agent` in `SKILLS.md` and the session allow-list.
- Update worker memory injection and manifest protocol text.
- Add generated agent files to orchestrator gitignore.

Status: implemented.

### Pass 3: Cleanup

- Keep skill prose short and push details into references.
- Remove stale "read-only only / no action delegation" wording from task-agent bridge docs.
- Correct monetization docs where they implied app-specific inference balances in the active route.
- Align Cloud skill references to current implementation files.

Status: implemented.

### Pass 4: Review And Fixing

Review focus:

- Type correctness around synthetic `Memory` construction and `messageService.handleMessage`.
- Session allow-list behavior for virtual brokers.
- Whether all spawned adapter types can see `SKILLS.md` and parent memory text.
- Whether tracked `AGENTS.md` repos need a safer memory-file strategy than writing in the workspace root.
- Whether OpenCode should become a first-class adapter type instead of shell-compatible spawn.

Status: partially implemented. The first three are covered by code/tests; the last two remain follow-up design items.

### Pass 5: Testing, Verification, Validation

Minimum local tests:

- unit test `parent-agent` broker list-actions, missing request, and message pipeline callback capture
- unit test `USE_SKILL` directive parsing and sensitive broker routing if practical
- typecheck `plugin-agent-orchestrator`
- test `packages/skills` loader/frontmatter paths
- run `scripts/ensure-skills.mjs` against a temporary `ELIZA_STATE_DIR`

Live validation:

- Start a parent Eliza runtime with agent skills and orchestrator loaded.
- Spawn Codex and Claude workers and verify they read `SKILLS.md`.
- Spawn OpenCode using Eliza Cloud with Cerebras OpenAI `gpt-oss-120b` and verify it can emit `USE_SKILL parent-agent ...`.
- Simulate:
  - action listing
  - parent memory search
  - calendar/GitHub/browser-style parent request
  - confirmation-required paid Cloud/domain request
  - denied broker when not allow-listed
  - task continuation after a returned parent result
- Run existing SWE/orchestrator benchmarks with and without the broker skill hint.

Status: local unit/type/skills tests are implemented and passing. Live OpenCode/Cerebras/SWE benchmarking requires running services and credentials, so it remains follow-up unless the environment already has them active.

## Remaining Gaps

- OpenCode is currently treated through shell-compatible spawn paths in parts of the orchestrator. It should become a first-class memory/config adapter if the project wants equivalent behavior to Claude/Codex/Gemini.
- `PARALLAX_DEFAULT_AGENT_TYPE` fixed-default parsing still only accepts `claude`, `gemini`, `codex`, and `aider`. Routing can rank OpenCode, but fixed default should be extended after type/API review.
- Writing adapter memory files named `AGENTS.md` can collide with repos that already track `AGENTS.md`. A safer strategy is needed for Codex memory injection in tracked-repo workspaces.
- Live agent benchmarking against OpenCode + Eliza Cloud + Cerebras requires credentials and running infrastructure.
- The parent-agent broker currently asks through the normal parent message pipeline. Direct action invocation APIs could be added later, but the message path is more flexible and preserves confirmation behavior.

## AGI-Level Direction

The long-term target is not a hardcoded "agent helper" action. It is a capability broker:

- the parent runtime exposes a typed capability graph derived from loaded plugins, actions, providers, services, connectors, and policies
- workers receive task-scoped manifests and can request capabilities without knowing implementation details
- the parent decides whether to answer, execute, request confirmation, redact, or deny
- applications override skills and policies by configuration rather than editing orchestrator code
- benchmarks measure whether workers solve more repo tasks with fewer human interventions and fewer credential leaks

The current implementation establishes the default skill surface and the child-to-parent request path needed for that architecture.

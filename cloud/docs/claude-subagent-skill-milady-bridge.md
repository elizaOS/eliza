# Claude / Codex sub-agent ↔ Milady runtime bridge — design doc

> **Audience:** the Claude Code / Codex CLI sub-agent that the Milady orchestrator
> spawns inside a coding task. NOT the Milady framework agent itself.
> See `agent-skill-build-monetized-app.md` for the framework-agent skill.
>
> **Status:** design only. The runtime surface this skill would document does
> not exist yet. This file is the spec; ship the bridge first, then the skill
> body, then bundle the skill into `eliza/packages/skills/skills/`.

## What this skill is for

When the Milady orchestrator spawns a Claude Code or Codex sub-agent to do
coding work, that sub-agent runs inside a `claude` / `codex` CLI process in a
separate worktree. It is disconnected from the parent Milady runtime by
default — it can only see files in its workdir, and the only outgoing channel
is the telemetry hook the orchestrator installed in `~/.claude/settings.json`
(which is fire-and-forget, intended for state events, not bidirectional
queries).

This means the sub-agent cannot:

- Read the parent agent's character file or persona
- Query the parent's memory (people, places, prior conversations)
- See which channel / room the original task came from
- Fetch the parent's view of currently-active workspaces
- Call other parent-side actions (`USE_SKILL`, `CREATE_TASK`, etc.)

For one-shot coding tasks ("build me X") this is fine — the orchestrator's
prompt fully describes the task. For coding tasks where context matters
("the user mentioned their dad, build them an app for that — but you should
already know who their dad is from memory"), the sub-agent is flying blind.

This bridge skill closes that gap.

## What's already in place (the orchestrator side)

The orchestrator currently injects three things into a sub-agent's workspace:

1. **`CLAUDE.md`** at the workspace root — written by `buildSwarmMemoryInstructions()`
   in `coding-task-handlers.ts`. Contains: agent label, agent's task, sibling
   tasks (when in a swarm), coordination rules. Does NOT currently include
   any pointers back to the parent Milady runtime.

2. **HTTP telemetry hooks** in `~/.claude/settings.json` — written by
   `pty-service.ts` around line 666. Points the sub-agent's lifecycle hooks
   (`PreToolUse`, `PostToolUse`, etc.) at
   `http://localhost:<SERVER_PORT>/api/coding-agents/hooks`. The parent
   orchestrator listens here for state events. **This channel is one-way:
   the sub-agent emits, the parent consumes.**

3. **A sealed env** — see `pty-spawn.ts` `ENV_ALLOWLIST`. Whitelisted vars
   (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `GITHUB_TOKEN`, etc.) propagate;
   everything else is stripped to prevent secret leakage. This is correct.

## What needs to be added (Milady side)

A small read-only HTTP surface on the parent Milady runtime that sub-agents
can curl to fetch parent-state. Endpoints, all behind loopback-only auth (so
non-bot processes can't fingerprint the parent):

| Endpoint | Purpose |
|---|---|
| `GET /api/coding-agents/<agentId>/parent-context` | Returns `{ character: { name, bio, knowledge[] }, currentRoom: { id, channel, platform }, workdir, model }` for the spawning task |
| `GET /api/coding-agents/<agentId>/memory?q=<query>&limit=N` | Searches the parent's memory layer for entities/relationships matching the query, returns at most N hits |
| `GET /api/coding-agents/<agentId>/active-workspaces` | Lists the parent's currently-known workspaces (the existing `active-workspace-context` provider's data, exposed read-only) |

Auth is the same `<agentId>` token already in the hook URL. The orchestrator
already mints this per-task; the bridge just adds a different verb (GET reads
instead of POST events).

The endpoints are READ-ONLY. The bridge does NOT expose `POST /memory/write`
or anything that mutates parent state from the sub-agent. If the sub-agent's
work has a mutation to record, it's the orchestrator's job to record it
post-completion — the sub-agent shouldn't write directly.

## What goes in the injected CLAUDE.md

After the bridge endpoints exist, extend the orchestrator's CLAUDE.md
template to include:

```markdown
## Parent Milady runtime — quick reference

You can read parent-runtime state via these loopback endpoints:

- `curl http://localhost:<SERVER_PORT>/api/coding-agents/<agentId>/parent-context`
  Returns the parent's character, current room, model, and your workdir.
- `curl http://localhost:<SERVER_PORT>/api/coding-agents/<agentId>/memory?q=<query>`
  Searches parent memory for entities matching the query.
- `curl http://localhost:<SERVER_PORT>/api/coding-agents/<agentId>/active-workspaces`
  Lists the parent's known workspaces.

These are READ-ONLY. Do not POST. The parent sees your work via the hook
channel already installed in ~/.claude/settings.json — that's where state
events flow.

Use these when the user's request references context the parent should
already know ("their dad", "the project we discussed yesterday", "the same
markup % as the last app") and the orchestrator's prompt didn't surface it
explicitly.
```

The orchestrator already has the agent ID + SERVER_PORT at task-spawn time
(both are in `pty-service.ts:650`); injecting them is one template
substitution.

## What the bundled SKILL.md becomes

After the bridge is live, this becomes a real bundled skill at
`eliza/packages/skills/skills/claude-subagent-milady-bridge/SKILL.md`. Per-skill
audience-targeting matters here:

- The Milady framework agent loads bundled skills via `AgentSkillsService`
  at runtime startup. It uses skills like `coding-agent`, `eliza-cloud`,
  `build-monetized-app` to decide what to do.
- The sub-agent (Claude Code, Codex) does NOT load `@elizaos/skills`. It
  reads `CLAUDE.md` from its workspace, full stop.

So the SKILL.md needs to live in two places:

1. **`eliza/packages/skills/skills/claude-subagent-milady-bridge/SKILL.md`** —
   tells the Milady framework agent: "when spawning a Claude Code sub-agent
   for a task that needs parent context, ensure the bridge endpoints are
   reachable and document them in the injected CLAUDE.md".
2. **The orchestrator's CLAUDE.md template** — already covered above. This
   is what the sub-agent actually reads. The bundled skill governs the
   parent's behavior when it spawns.

Same content, different audiences, different distribution.

## Failure modes the bridge must handle

| Failure | Behavior |
|---|---|
| Sub-agent calls bridge endpoint with stale agentId after parent restarted | Return `410 task_no_longer_active` with body explaining the parent restarted. Sub-agent should treat as "no parent context" and fall back to workspace-only mode. |
| Sub-agent calls bridge endpoint that doesn't exist | Standard `404` with a JSON error body, `code: "unknown_route"`. |
| Bridge endpoint times out (parent is busy) | Respond `503` after 5s. Sub-agent should NOT retry indefinitely — it's a CLI tool, not an agent runtime. Single fallback to "no parent context". |
| Sub-agent tries to mutate parent state via POST | All bridge endpoints are GET-only. Any other verb → `405 method_not_allowed`. |

## What's intentionally NOT in this skill

- **Bidirectional state sync** — sub-agent and parent don't share a memory
  store. Parent reads its own memory; sub-agent reads parent state via the
  bridge. No two-way replication.
- **Action delegation** — the sub-agent cannot invoke parent actions. If
  the user's task implies "after building this, also schedule X", the
  sub-agent's job is to flag that in its output; the orchestrator's
  swarm-decision-loop schedules the follow-up.
- **Persistent agent identity inside the sub-agent** — the sub-agent is
  ephemeral; it dies when the PTY exits. Don't bake assumptions about
  its identity surviving across spawns.

## Implementation sequence

If/when you want to build this:

1. **Wire the bridge endpoints** in `eliza/packages/app-core/src/api/coding-agents-routes.ts`
   alongside the existing `/hooks` POST handler. Read-only, agentId-authed,
   loopback-only.
2. **Extend the orchestrator's CLAUDE.md template** in `coding-task-handlers.ts`'s
   `buildSwarmMemoryInstructions()` (or its successor) to include the bridge
   reference block above.
3. **Add the bundled skill** at `eliza/packages/skills/skills/claude-subagent-milady-bridge/SKILL.md`
   following the same convention as `eliza-cloud` and `build-monetized-app`.
4. **Verify live** — spawn a coding sub-agent, have it curl the bridge,
   confirm the response shape matches the spec. Capture the trace in the PR
   description, the way `build-monetized-app`'s "Initialized with 32 skills"
   trace was captured.

Each step is shippable on its own; the order matters because the skill body
should reference real endpoints, not aspirational ones.

## Why this design (and not something simpler)

Two simpler designs that fail:

1. **"Just give the sub-agent the parent's full memory dump in CLAUDE.md."**
   Doesn't scale; CLAUDE.md is consumed every turn and a 100-entry memory
   dump blows the sub-agent's context budget.
2. **"Just give the sub-agent the parent's API key and let it call cloud APIs."**
   Conflates two concepts: the parent's *cloud* state (handled by the
   `eliza-cloud` skill) versus the parent's *local runtime* state (memories,
   characters, rooms — these don't live in cloud). The bridge handles the
   second; cloud handles the first.

This design is a small, read-only, loopback-only HTTP surface scoped per
task, which matches the security and lifecycle of the existing telemetry
hook.

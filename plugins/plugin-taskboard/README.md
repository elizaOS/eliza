# @elizaos/plugin-taskboard — design plan

> **Status: PLAN ONLY.** This directory is a design scaffold for the
> `plugin-taskboard` plugin proposed in
> [elizaOS/eliza#13469](https://github.com/elizaOS/eliza/issues/13469). No
> runtime code ships yet. `SCAFFOLD.md` is the contract a coding agent follows
> to turn this plan into a working plugin. Do **not** start building until the
> plan is reviewed and the Phase-0 rooms QA (below) has run.

A **Workboard** is one Eliza **room** + one GitHub **Project (v2) board** + one
GitHub **tracking issue**, bound together as a single durable object. A team of
Eliza agents (and a human owner) coordinate in the room at chat speed; work
state lives on the board; durable artifacts (decisions, evidence, findings) are
mirrored to the tracking issue so GitHub-native humans see the signal without
joining the room.

This plugin composes primitives elizaOS already ships — rooms/entities/worlds
(`packages/core/src/types/environment.ts`), the scheduled-task spine
(`@elizaos/plugin-scheduling`), and GitHub API access
(`@elizaos/plugin-github`) — into "a team of agents + a human working one
board." It is also the forcing function to hands-on-QA the rooms feature with a
real multi-agent, multi-day session.

---

## 1. Where this sits in the runtime (dependency direction)

`plugin-taskboard` is an **opt-in app plugin** (add `"@elizaos/plugin-taskboard"`
to the agent's plugin list). Dependencies point inward only:

```
plugin-taskboard  ──depends on──▶  @elizaos/plugin-github     (GitHub API: Projects v2 + Issues)
                  ──depends on──▶  @elizaos/plugin-scheduling  (goal-loop heartbeat, structural)
                  ──depends on──▶  @elizaos/plugin-sql         (board↔room binding tables)
                  ──uses──────────▶  @elizaos/core             (rooms, entities, worlds, tasks, provider/action contracts)
```

- It MUST NOT import `@elizaos/app-core` or `@elizaos/agent` (would break the
  mobile bundle — the boundary that `@elizaos/plugin-scheduling` enforces, see
  its `CLAUDE.md` "Boundary" section).
- It MUST NOT reach into `@elizaos/plugin-personal-assistant` internals. It
  contributes to the scheduling spine through the same public port PA uses
  (`registerScheduledTaskRunnerDeps` / default-pack seed registry — see
  `plugins/plugin-scheduling/CLAUDE.md`), never a second scheduler.

### Reused primitives (real, cited)

| Concept | Real primitive | Location |
| --- | --- | --- |
| The room agents talk in | `Room` (`type: ChannelType`, `worldId`, `metadata`) | `packages/core/src/types/environment.ts:84` |
| Channel kind for a multi-agent workboard room | `ChannelType.GROUP` | `packages/core/src/types/primitives.ts:38` |
| An agent or human as a participant | `Entity` (`names: string[]`, `metadata`) + `Participant` | `packages/core/src/types/environment.ts:27` / `:103` |
| Owner/member access control | `Role` (`OWNER`/`ADMIN`/`MEMBER`/`GUEST`) + `WorldMetadata.roles` | `packages/core/src/types/environment.ts:43` / `:57` |
| The world that owns the room + roles | `World` (`metadata.ownership`, `metadata.roles`) | `packages/core/src/types/environment.ts:76` |
| Binding board↔room without a new table (per-card links) | `Component` (`type: string`, `data: Metadata`, `roomId`, `worldId`, `entityId`) | `packages/core/src/types/environment.ts:12` |
| The goal-loop heartbeat | `ScheduledTask` structural fields (`kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline`) | `plugins/plugin-scheduling/src/scheduled-task/types.ts:209` |
| GitHub client (per-identity Octokit) | `GitHubService` / `IGitHubService.getOctokit` | `plugins/plugin-github/src/types.ts:143`, `plugins/plugin-github/src/services/github-service.ts` |
| Board-change → room message | `runtime.createMemory(memory, tableName)` + `emitEvent(EventType.MESSAGE_RECEIVED, …)` | `packages/core/src/types/runtime.ts:1355` / `:975`, `packages/core/src/types/events.ts:35` |
| Multi-agent chat routing (optional, later) | `ISwarmCoordinatorService` | `packages/core/src/types/swarm-coordinator.ts:312` |
| Surface failures to the agent/owner | `runtime.reportError(scope, error, context?)` | `packages/core/src/types/runtime.ts:993` |

---

## 2. Data model — rooms ↔ board mapping

The mapping is deliberately **thin**: the GitHub Project board is the single
source of truth for card state; the eliza world/room/component graph stores only
the *binding* (which room mirrors which board) plus a per-card back-reference so
a board webhook can find the room, and vice-versa. No card content is duplicated
into a second store of record.

### 2.1 The Workboard object

One workboard = one `World` + one `Room` + one GitHub Project + one tracking
issue. We store the binding as `WorldMetadata` (extends `Metadata`,
`packages/core/src/types/environment.ts:57`) so it lives with the world that
already owns roles/ownership — no new "workboards" table needed for the binding
itself:

```ts
// stored on World.metadata (WorldMetadata is open via [key: string]: unknown)
interface WorkboardBinding {
  taskboard: {
    repo: { owner: string; name: string };          // e.g. { owner: "elizaOS", name: "eliza" }
    projectNodeId: string;                            // GitHub Projects v2 node id (GraphQL global id)
    projectNumber: number;                            // human-facing project number
    trackingIssueNumber: number;                      // the #13406-shaped tracker
    roomId: UUID;                                      // the bound room
    // Projects v2 single-select field that models the column/status:
    statusFieldId: string;                             // ProjectV2SingleSelectField id
    statusOptionIds: Record<WorkboardColumn, string>;  // column → single-select option id
    mission: string;                                   // one-line mission statement
    createdAtIso: string;
  };
}
```

`World.metadata.ownership.ownerId` (`WorldOwnership`,
`packages/core/src/types/environment.ts:53`) and `World.metadata.roles`
(`Record<string, Role>`) already model "who is the owner" and "who can approve" —
we reuse them verbatim. Owner = the human who created the workboard; agents get
`Role.MEMBER`.

### 2.2 Columns (fixed v1 taxonomy)

A Projects v2 single-select field named **Status** with five options. Fixed in
v1 (Open Question #2 resolved to fixed — configurability is a v2 concern):

```
Todo → Claimed → In progress → Needs-human-verify → Done
```

```ts
type WorkboardColumn =
  | "todo"
  | "claimed"
  | "in_progress"
  | "needs_human_verify"
  | "done";
```

Per Clean-Architecture rule 5 (no polymorphism for runtime branching), each
column transition is a **separate action verb** (§4), not one `moveCard(to)`
with an `if (column === …)` ladder.

### 2.3 Per-card binding — `Component`, not a new table

Each board card that an agent is working maps to a `Component`
(`packages/core/src/types/environment.ts:12`) attached to the agent's `Entity`
in the workboard world:

```ts
// Component.type = "taskboard_card"; Component.data:
interface TaskboardCardComponentData {
  projectItemId: string;         // Projects v2 item node id
  contentIssueNumber?: number;   // if the card is backed by a repo issue
  title: string;
  column: WorkboardColumn;        // last-known column (board is truth; this is a cache for provider render)
  claimedByEntityId?: UUID;       // which agent owns it
  evidenceUrls: string[];         // accumulated evidence (gates DONE, §4)
  updatedAtIso: string;
}
```

`Component` carries `roomId` + `worldId` + `entityId` + `agentId` already, so a
board webhook that names a `projectItemId` resolves the room via
`getComponentsByType("taskboard_card", agentId)`
(`packages/core/src/types/runtime.ts:1338`) → filter by `projectItemId`. This is
the **cache** the `WORKBOARD_STATE` provider renders from; a periodic reconcile
(§5) repairs drift so "not loaded" never reads as "empty" (error-policy: no
`?? []` — a failed board read throws and `reportError`s, it does not return an
empty board).

> **Why `Component` and not a bespoke `taskboard_cards` DB table:** the binding
> is a small, per-entity, per-room fact that the runtime's component store
> already persists, scopes by agent, and exposes via typed convenience readers
> (`getComponentsByType`, `patchComponentField` at
> `packages/core/src/types/runtime.ts:1329`). Adding a table would mean owning
> migrations + a repository for data that is a projection of the board. The
> board is the source of truth; this is a reconcilable cache.

### 2.4 Membership + identity

- **Agents** join the room as `Participant`s via
  `runtime.addParticipant(entityId, roomId)`
  (`packages/core/src/types/runtime.ts:1255`). Their lane tag (`[qa-agent]`) is
  their `Entity.names[0]`. Name collisions get a numeric suffix at invite time.
- **Humans** are invited by GitHub handle (native board/issue access) plus a
  room join link. Owner role lives in `World.metadata.roles[entityId] =
  Role.OWNER`; only `Role.OWNER`/`Role.ADMIN` can move a card out of
  `needs_human_verify` (enforced by the action's `roleGate`, §4).

---

## 3. GitHub sync strategy

### 3.1 Auth — GitHub App installation, not PATs

The v1 auth model is a **GitHub App installation per org** with fine-grained
permissions: `Projects: read/write`, `Issues: read/write`, `Pull requests:
read`. This directly solves the `project` OAuth-scope refusal that made #13406's
board setup manual. It layers onto the existing GitHub connector-account model
(`plugins/plugin-github/src/connector-account-provider.ts`,
`plugins/plugin-github/src/accounts.ts`) — the app installation token is one more
account source resolved by `GitHubService.getOctokit(...)`
(`plugins/plugin-github/src/types.ts:143`). We do **not** invent a second GitHub
client; taskboard's `TaskboardGitHubService` (§4) composes `GitHubService`.

> Projects v2 write is **GraphQL only** (there is no REST mutation for moving a
> card). `plugin-github`'s current `GitHubOctokitClient`
> (`plugins/plugin-github/src/types.ts:96`) is a narrow REST surface and does
> **not** expose `octokit.graphql`. This plan therefore **extends
> `plugin-github`** with a typed `graphql<T>(query, vars)` method on the service
> (Open Question resolved: extend the existing service rather than fork a
> client), keeping the "one GitHub client" invariant. This is the one
> upstream-plugin change the build requires and is called out in `SCAFFOLD.md`.

### 3.2 The three sync directions

1. **Room/agent → board (writes).** Agent runs `CLAIM_TASK` / `START_TASK` /
   `NEEDS_VERIFY_TASK` / `DONE_TASK` (§4). Each is a Projects v2
   `updateProjectV2ItemFieldValue` GraphQL mutation setting the **Status**
   single-select to the target column's option id
   (`WorkboardBinding.statusOptionIds`). On success the action posts a one-line
   room message so the room never drifts from the board.

2. **Board → room (human-made changes flow back).** A human dragging a card in
   the GitHub UI must appear in the room. Two mechanisms, in preference order:
   - **Webhooks** (`projects_v2_item` events) when the org can register a
     webhook endpoint → the plugin exposes a `POST /api/taskboard/webhook`
     route (raw `http` handler, the `plugin-github` route pattern at
     `plugins/plugin-github/src/index.ts:65`) that verifies the signature,
     resolves the room via the card `Component`, and posts the transition to
     the room.
   - **Polling fallback** when no webhook is available (local/laptop agents): a
     `taskboard_board_reconcile` scheduled task (§5) diffs board state against
     the card-`Component` cache on a cadence and posts deltas to the room. This
     is the same primitive as the reconcile in §2.3 — one codepath, two
     triggers (webhook push OR poll), never two implementations.

3. **Board/room → tracking issue (mirror, batched).** Durable artifacts —
   `DONE_TASK` with evidence, new findings, owner approvals — are mirrored as
   **tracking-issue comments** via `issues.createComment`
   (`plugins/plugin-github/src/types.ts:113`, already on the REST surface).
   Chat lines are **not** mirrored — the issue gets the signal, not the noise.
   The tracking-issue **body** is regenerated from board state (Open Question #3
   resolved: board = source of truth) with a preserved free-form `## Notes`
   section (parsed out and re-inserted on each regenerate) so hand-written
   context survives.

### 3.3 Idempotency + failure surfacing

- Every board write carries an idempotency guard: the `projectItemId` + target
  column is checked against the card `Component` cache before the mutation, so a
  retried `DONE_TASK` is a no-op, not a double-comment.
- GitHub failures are **not** swallowed. Rate-limit responses reuse
  `inspectRateLimit` / `formatRateLimitMessage`
  (`plugins/plugin-github/src/rate-limit.ts`) and surface as a typed
  `{ success: false, error }` action result (the `plugin-github`
  `GitHubActionResult` contract, `plugins/plugin-github/src/types.ts:176`) — the
  agent sees the failure and can retry. Systemic failures (auth revoked, app
  uninstalled) call `runtime.reportError("taskboard", err, {...})`
  (`packages/core/src/types/runtime.ts:993`) which drives the `RECENT_ERRORS`
  provider + owner escalation. No `?? []`, no fabricated empty board.

---

## 4. Plugin surface — actions / providers / services

Follows the `min-plugin` SCAFFOLD contract
(`packages/elizaos/templates/min-plugin/SCAFFOLD.md`): actions/providers/services
in their own files under `src/actions|providers|services`; the barrel is wiring
only. Action/Provider/Service contracts:
`packages/core/src/types/components.ts:300` (Action, with `roleGate`
`:499`, `contextGate` `:490`), `:631` (Provider).

### 4.1 Actions

Per Clean-Architecture rule 5, each card transition is a **distinct verb** — no
`moveCard(to)` polymorphism.

| Action | What it does | `roleGate` | Gate/notes |
| --- | --- | --- | --- |
| `CREATE_WORKBOARD` | Given `repo` + `mission`: create-or-adopt the Projects v2 board, open the tracking issue (template = #13406 shape), create the `World`+`Room`, write the `WorkboardBinding`, post join instructions in room + issue. | `ADMIN` (owner-initiated) | `requireConfirmation` (creates external resources). |
| `CLAIM_TASK` | Move a `Todo` card → `Claimed`, set `claimedByEntityId`, post `[tag] claimed: <title>` to room. | `MEMBER` | Rejects if already claimed by another live participant. |
| `START_TASK` | `Claimed` → `In progress`. | `MEMBER` | Only the claiming agent. |
| `UPDATE_TASK` | Append progress note / evidence URL to the card `Component` + a room line. Does not change column. | `MEMBER` | — |
| `NEEDS_VERIFY_TASK` | `In progress` → `Needs-human-verify`. Requires ≥1 evidence URL. | `MEMBER` | No evidence ⇒ rejected with a typed error (not silently downgraded). |
| `DONE_TASK` | `Needs-human-verify` → `Done`. **Owner-only.** Mirrors the evidence block to the tracking issue. | `OWNER`/`ADMIN` | Evidence payload required; the approval is a room message AND a card move. |
| `READ_BOARD` | Read-only board snapshot (also the backing for the provider + MCP port). | `MEMBER` | GET-style; no confirmation. |

Evidence discipline (encodes `PR_EVIDENCE.md` culturally): a card can only reach
`Done` through `DONE_TASK`, which is owner-gated and requires the evidence the
agent accumulated via `UPDATE_TASK`/`NEEDS_VERIFY_TASK`. An agent can never
self-close.

### 4.2 Providers

| Provider | Injects | Position |
| --- | --- | --- |
| `WORKBOARD_STATE` | Current board for the active room: open cards, who owns what, blocked/`needs-human-verify` items — rendered from the card `Component` cache (§2.3), reconciled by §5. So every agent in the room always knows board state without asking. | early (like `enabled_skills` at `-10`) |

Three-state rule (root `AGENTS.md`): the provider renders `loading` /
designed-`empty` (a genuinely empty board) / `error` (board read failed) as
three distinguishable states. A failed board read is an **error** state, never
rendered as an empty board.

### 4.3 Services

| Service | `serviceType` | Purpose |
| --- | --- | --- |
| `TaskboardService` | `"taskboard"` | The board/room binding home: create/adopt board, resolve `WorkboardBinding` from a room, read/mutate cards, regenerate the tracking-issue body, run the reconcile. Composes `GitHubService` (never a second GitHub client) + `runtime` room/entity/component APIs. |

The MCP port (v2, §7) is this service run headless — write once here, both the
plugin and the CLI ports consume it.

---

## 5. The goal loop — structural scheduled task, no prompt-text matching

This replaces the per-agent goal-prompt duct tape. It is implemented as a
`ScheduledTask` on the **existing scheduling spine**
(`@elizaos/plugin-scheduling`), **not a second scheduler**.

**Binding constraint (root `CLAUDE.md` LifeOps doctrine +
`plugins/plugin-scheduling/CLAUDE.md`):** behavior is driven by **structural
fields** (`kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline` —
`plugins/plugin-scheduling/src/scheduled-task/types.ts:209`), **never** by
pattern-matching `promptInstructions` string content. The standing "keep working
the board" goal text lives in `promptInstructions` for the agent to read, but
the runner fires purely on structure.

Each agent joined to a workboard gets one standing task:

```ts
// registered via @elizaos/plugin-scheduling's default-pack seed registry
// (registerDefaultTaskPack), NOT a bespoke runner.
const workboardHeartbeat: Partial<ScheduledTask> = {
  kind: "watcher",                                   // structural kind
  trigger: { kind: "interval", everyMinutes: 10 },   // cadence  (types.ts:112)
  // fires ALSO on room mentions via a second event-triggered task:
  //   trigger: { kind: "event", eventKind: "MESSAGE_RECEIVED", filter: { roomId } }  (types.ts:115)
  // shouldFire is a list of registry gate REFS (types.ts:126 ScheduledTaskShouldFire = { gates: ScheduledTaskGateRef[] }):
  shouldFire: { gates: [{ kind: "taskboard_has_open_cards" }] },   // gate reads board state, not the prompt
  // completionCheck is a registry ref (types.ts:131 { kind, params }):
  completionCheck: { kind: "taskboard_owner_closed" },             // complete only when the OWNER closes it
  respectsGlobalPause: true,
  subject: { kind: "self", id: entityId },
  promptInstructions:
    "While the workboard has cards outside Done, or needs-human-verify cards " +
    "await the owner: pick up eligible work, keep your card statuses current, " +
    "check the room + board before and after every task, surface blockers in " +
    "the room, and never mark the workboard complete yourself — only the owner closes it.",
};
```

- `shouldFire` is a list of **gate refs** (`ScheduledTaskShouldFire = { gates:
  ScheduledTaskGateRef[] }`, `plugins/plugin-scheduling/src/scheduled-task/types.ts:126`)
  and `completionCheck` is a **check ref** (`{ kind, params }`,
  `plugins/plugin-scheduling/src/scheduled-task/types.ts:131`); the plugin
  registers the referenced predicates
  (`taskboard_has_open_cards`, `taskboard_owner_closed`) in the spine's
  `TaskGateRegistry` / `CompletionCheckRegistry`
  (`plugins/plugin-scheduling/src/scheduled-task/gate-registry.ts` /
  `completion-check-registry.ts`) — they read board state, they do not parse the
  prompt.
- On fire, the task nudges the agent's message loop for that room (a
  `MESSAGE_RECEIVED` into the room, or the swarm coordinator if bound). The
  agent then uses the `WORKBOARD_STATE` provider + the board actions.
- `respectsGlobalPause: true` so an owner "pause" halts every agent's loop.
- Diagnostics-must-not-kill-the-loop (J7): a telemetry write failure in the loop
  warns + `reportError`, it does not abort the heartbeat.

---

## 6. Cloud console surface (v1, Phase 4)

A **Workboards** page in the dashboard (`packages/app`): list boards, join room,
see live column counts + `needs-human-verify` queue. Follows the app visual-review
loop (`bun run --cwd packages/app audit:app`, root `AGENTS.md`) — orange accent
only, no blue, three-state renders. The view is a `Plugin.views` entry with
`viewKind: "release"` (SCAFFOLD §6). Every board mutation the page triggers goes
through the same actions as the agents (Clean-Architecture rule 10: every
endpoint has a client trigger; every read has a consuming component).

---

## 7. Ports for non-eliza devs (v2)

MCP is the portability layer — the board actions (`claim`, `update`, `done`,
`read-board`) are exposed **once** as an MCP server that is `TaskboardService`
run headless. Claude Code consumes it via a `/workboard` skill; Codex CLI via a
thin instructions file + the same MCP server. eliza stays the reference
implementation and the only surface with rooms; CLI ports coordinate through the
board + issue mirror only.

---

## 8. Open questions — resolutions taken in this plan

| # | Question | Resolution in this plan | Rationale |
| --- | --- | --- | --- |
| 1 | Rooms transport for laptop-local agents | Join via cloud room API with an agent token; needs a "headless room participant" SDK client (tracked as a Phase-1 dependency). Polling reconcile (§5) covers board→room until that lands. | Keeps laptop agents first-class without blocking on the SDK. |
| 2 | Column taxonomy: fixed vs configurable | **Fixed** v1 set (§2.2). Configurable deferred to v2. | Fixed columns keep the action verbs (rule 5) and the single-select field mapping simple. |
| 3 | Tracking-issue body: regenerated vs hand-edited | **Regenerated** from board state, with a preserved `## Notes` section. | Board = source of truth; avoids two writers of the same board state. |
| 4 | Multi-repo workboards | Deferred. `WorkboardBinding.repo` is a single repo in v1. | Scope control. |
| 5 | Cost/noise controls | Room message budget per agent/hour + a summarizer that compacts room history into the issue mirror (batched, §3.2). | The mirror already batches; the budget is a v1 guardrail on room spam. |
| 6 | Projects v2 GraphQL not on `plugin-github`'s client | **Extend** `plugin-github`'s `GitHubService` with a typed `graphql<T>()` method rather than fork a client. | Preserves the "one GitHub client" invariant; the only upstream change the build needs. |

---

## 9. Build phases (when green-lit)

0. **Phase 0 (½ day) — rooms QA.** Manual rooms shakedown: 2 agents + owner in a
   `ChannelType.GROUP` room, real work, find what breaks. Burns down the "rooms
   never manually tested" debt before building on it. Produces rooms bugfixes as
   a second deliverable.
1. **Phase 1 — skeleton.** `TaskboardService` + `GitHubService.graphql()`
   extension + GitHub App auth + `CREATE_WORKBOARD` + `CLAIM/START/UPDATE/
   NEEDS_VERIFY/DONE/READ` actions + `WORKBOARD_STATE` provider + the card
   `Component` cache + reconcile. Dogfood on the launch-QA board.
2. **Phase 2 — loop + mirror.** The structural goal-loop scheduled task
   (default-pack) + the batched tracking-issue mirror + the evidence gate.
3. **Phase 3 — ports.** MCP server (headless `TaskboardService`) + Claude Code
   `/workboard` skill + Codex instructions.
4. **Phase 4 — cloud console.** The Workboards page in `packages/app`.

## 10. Definition of done for the plugin (not this plan)

Each phase ships with the repo's non-negotiable evidence (`PR_EVIDENCE.md`):
live-LLM trajectories of an agent claiming/working/verifying a card, backend
`[TaskboardService]` logs of the GraphQL mutations firing, the real GitHub
board + tracking issue as domain artifacts (screenshots + issue-comment
permalinks), and full-featured E2E driving the real GitHub App round-trip (not a
mocked Octokit). No stubs, no `?? default`, no swallowed GitHub errors.

---

_This plan is the deliverable for #13469. It resolves the issue's five open
questions, cites the real elizaOS primitives it composes (file:line above), and
respects the binding architecture rules: dependencies inward only, one scheduler
(structural, no prompt-text matching), one GitHub client, one board source of
truth, three-state UI, and no fabricated defaults._

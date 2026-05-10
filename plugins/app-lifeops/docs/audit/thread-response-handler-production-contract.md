# Thread-Aware Response Handler Production Contract

This contract freezes the production target for thread-aware response
handling. The implementation waves are execution lanes only; they are not
product stages. The build must land against this final shape without
temporary schemas, second task primitives, or partial thread orchestration.

## Goals

- Keep the response-handler tool schema stable and cacheable.
- Make response-handler decisions modular through registered patchers.
- Route thread lifecycle work through normal planner actions.
- Keep `ScheduledTask` as the only durable task primitive.
- Represent work threads as lightweight coordination records, not schedulers.
- Enforce current-channel mutation and cross-channel read-only defaults.
- Keep OpenAI, Anthropic, Cerebras, gateway, and local cache behavior explicit
  and testable.

## Non-Goals

- No second task runner.
- No dynamic `HANDLE_RESPONSE` schema fields for thread operations.
- No per-thread LLM calls in the normal inbound-message path.
- No distributed leases or external queue assumptions for the single-process
  desktop/runtime agent.
- No behavior that pattern-matches `promptInstructions`.

## Core Response-Handler Contract

The `HANDLE_RESPONSE` tool remains the stable Stage-1 routing call. Modular
response-handler evaluators run after the model output is parsed and before
the route is acted on. They may only patch the parsed handler result through a
typed patch surface.

```ts
type ResponseHandlerPatch = {
  processMessage?: "RESPOND" | "IGNORE" | "STOP";
  requiresTool?: boolean;
  simple?: boolean;
  setContexts?: AgentContext[];
  addContexts?: AgentContext[];
  addCandidateActions?: string[];
  addParentActionHints?: string[];
  addContextSlices?: string[];
  clearReply?: boolean;
  reply?: string;
  debug?: string[];
};

type ResponseHandlerEvaluator = {
  name: string;
  description?: string;
  priority?: number;
  shouldRun(context: ResponseHandlerEvaluatorContext): boolean | Promise<boolean>;
  evaluate(context: ResponseHandlerEvaluatorContext): ResponseHandlerPatch | void | Promise<ResponseHandlerPatch | void>;
};
```

Patchers must be deterministic. They can query stores and inspect the parsed
result, message, state, available contexts, and runtime registries. They must
not make an LLM call in the normal response-handler path.

## Patch Semantics

- `setContexts` replaces selected contexts after filtering to available
  contexts.
- `addContexts` appends available contexts and removes `simple` when the turn
  now needs planning.
- `addCandidateActions` and `addParentActionHints` feed the existing action
  retrieval system.
- `requiresTool: true` and `simple: false` force the planner route when needed.
- Patchers run by priority, then name.
- Patch failures are logged and isolated; one failed patcher cannot break the
  inbound message.
- Patch traces are recorded in debug metadata and trajectory output.

## LifeOps Thread Contract

`WorkThread` is a coordination index. It does not run work.

```ts
type WorkThreadStatus =
  | "active"
  | "waiting"
  | "paused"
  | "stopped"
  | "completed";

type ThreadSourceRef = {
  connector: string;
  channelName?: string;
  channelKind?: string;
  roomId?: string;
  externalThreadId?: string;
  accountId?: string;
  grantId?: string;
  canRead?: boolean;
  canMutate?: boolean;
};

type WorkThread = {
  id: string;
  agentId: string;
  ownerEntityId?: string | null;
  status: WorkThreadStatus;
  title: string;
  summary: string;
  currentPlanSummary?: string | null;
  primarySourceRef: ThreadSourceRef;
  sourceRefs: ThreadSourceRef[];
  participantEntityIds: string[];
  currentScheduledTaskId?: string | null;
  workflowRunId?: string | null;
  approvalId?: string | null;
  lastMessageMemoryId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  metadata?: Record<string, unknown>;
};
```

Durable continuation uses existing records:

- `ScheduledTask.subject.kind = "thread"` for scheduled continuation.
- pending prompts for waiting-on-user correlation.
- approval queue for sensitive side effects.
- handoff store for room-level silence/resume policy.
- workflow runs for multi-step durable orchestration.

## Thread Operation Action

Thread lifecycle mutations happen through a planner action, not through the
response-handler tool schema.

```ts
type ThreadOperation =
  | { type: "create"; title?: string; summary?: string; sourceRef?: ThreadSourceRef; instruction?: string; reason?: string }
  | { type: "steer"; workThreadId: string; instruction: string; reason?: string }
  | { type: "stop"; workThreadId: string; reason?: string }
  | { type: "mark_waiting"; workThreadId: string; reason?: string }
  | { type: "mark_completed"; workThreadId: string; reason?: string }
  | { type: "merge"; workThreadId: string; sourceWorkThreadIds: string[]; instruction?: string; summary?: string; reason?: string }
  | { type: "attach_source"; workThreadId: string; sourceRef: ThreadSourceRef; reason?: string }
  | { type: "schedule_followup"; workThreadId: string; instruction: string; trigger: ScheduledTaskTrigger; reason?: string };
```

The action is hidden unless validation finds active/relevant thread state or
the inbound message clearly asks to create durable thread work.

## Permission Rules

- Current-channel work threads may be mutated when the caller has LifeOps
  owner access and the source reference allows mutation.
- Cross-channel work threads are read-only summaries by default.
- Cross-channel mutation requires an explicit current-channel source reference
  or a separately authorized owner/admin path.
- Merge requires the target and every source thread to be mutable in the
  current channel; cross-channel read-only summaries cannot be merged directly.
- Multi-user rooms are channel-scoped unless the work thread has a specific
  owner entity and the caller is that owner/admin.
- Handoff room policy remains authoritative for whether the agent should
  respond in a room.

## Resource Limits

The single-process runtime uses in-memory limits:

- one active lifecycle mutation per room;
- one active lifecycle mutation per work thread;
- bounded concurrent thread-control handlers, implemented with the shared core
  semaphore rather than a new queue primitive;
- at most 30 active/waiting/paused work threads per agent before new thread
  creation is refused with `THREAD_POOL_FULL`;
- bounded concurrent sub-agent/tool-worker operations remain owned by the
  existing agent-orchestrator session limits.

Stale `running`-style metadata, if introduced by a tool worker, must be
recoverable on startup by timestamp. No distributed lease table is required for
this production target.

## Cache Contract

- Keep `HANDLE_RESPONSE` and `PLAN_ACTIONS` tool names fixed.
- Keep thread summaries in dynamic provider text or post-parse patches, not in
  stable prompt segments.
- Provider cache options must include stable prefix hashes and conversation
  identifiers where supported.
- OpenAI extended retention, Anthropic breakpoints, Cerebras strict schemas,
  and local model message/tool support must be covered by tests.

## Production Definition Of Done

- A user message can create, steer, stop, wait, complete, merge, and schedule
  follow-up thread work end to end.
- No active/relevant thread state means no thread action exposure.
- Current-channel mutation and cross-channel read-only defaults are enforced.
- Scheduled thread work resumes through the existing LifeOps scheduler.
- Autonomy/proactive loops can observe thread summaries without owning
  execution.
- Cache hashes remain stable when only dynamic thread/user text changes.
- Tests assert exact LLM call counts for common paths.

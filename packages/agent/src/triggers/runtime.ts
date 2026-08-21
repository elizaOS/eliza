/**
 * Executes the agent's scheduled/event triggers and wires them into the task
 * scheduler and runtime events. Registers the TRIGGER_DISPATCH task worker,
 * bridges supported runtime events into persisted event triggers, dispatches
 * each fire to either a workflow (the WORKFLOW_DISPATCH service,
 * idempotency-keyed) or a prompt automation (a synthetic-entity turn through
 * the message service), then records the run, recomputes next-fire metadata,
 * deletes one-shot/exhausted tasks, and hands the per-fire re-arm interval back
 * so varying-cadence triggers don't drift. Tracks per-agent execution metrics,
 * surfaces success/failure on the notification rail, and projects tasks into
 * read-only trigger/heartbeat summaries and a health snapshot for the API.
 *
 * The runtime-event bridge is a production boundary that starts workflows, so
 * it is deliberately bounded: a trigger may not restart the workflow that
 * emitted the event, trigger-to-trigger chains stop after a fixed hop depth,
 * and each saved trigger has a sustained per-minute dispatch ceiling. Failures
 * anywhere on the bridge are reported, never propagated back into the emitting
 * run.
 */
import crypto from "node:crypto";
import type {
  EventPayload,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Service,
  Task,
  UUID,
} from "@elizaos/core";
import {
  ElizaError,
  inspectSendHandlerResult,
  MESSAGE_SOURCE_TRIGGER_PROMPT,
  registerRuntimeManagedInternalActor,
  ServiceType,
  stringToUuid,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import {
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  MAX_TRIGGER_RUN_HISTORY,
} from "./scheduling.ts";
import type {
  PromptTriggerConfig,
  TriggerConfig,
  TriggerHealthSnapshot,
  TriggerRunRecord,
  TriggerSummary,
  TriggerTaskMetadata,
  WorkflowTriggerConfig,
} from "./types.ts";

export const TRIGGER_TASK_NAME = "TRIGGER_DISPATCH" as const;
export const TRIGGER_TASK_TAGS = ["queue", "repeat", "trigger"] as const;
const HEARTBEAT_TASK_TAGS = ["queue", "repeat", "heartbeat"] as const;
const WORKFLOW_RUN_EVENT = "workflow_run_event" as const;
const RUNTIME_TRIGGER_EVENT_KINDS = [WORKFLOW_RUN_EVENT] as const;
/**
 * How many trigger hops a single originating run may cause. A workflow started
 * by an event trigger emits its own run events, so a mutually referential
 * configuration (A triggers B, B triggers A) would otherwise never quiesce.
 * Ancestry is tracked by run id, so the chain stops after this many hops.
 */
const MAX_EVENT_TRIGGER_CHAIN_DEPTH = 4;
/** Upper bound on remembered run-id ancestry entries per runtime. */
const MAX_EVENT_TRIGGER_CHAIN_ENTRIES = 1024;
/**
 * Long-run dispatch ceiling per saved trigger. The predecessor app-core bridge
 * enforced a one-second floor between fires, which silently dropped distinct
 * legitimate events arriving in a burst. This keeps the same sustained ceiling
 * without the burst loss: bursts of distinct events all fire, but a runaway
 * fan-out is cut off and reported instead of compounding.
 */
const EVENT_DISPATCH_WINDOW_MS = 60_000;
const MAX_EVENT_DISPATCHES_PER_WINDOW = 60;
const eventBridgeRegistrations = new WeakSet<IAgentRuntime>();
const eventDispatchQueues = new WeakMap<
  IAgentRuntime,
  Map<UUID, Promise<void>>
>();
/** Discovery queries shared by every event observed in the same event-loop turn. */
const eventDiscoveryBatches = new WeakMap<IAgentRuntime, Promise<Task[]>>();
/** Run id -> number of trigger hops between an external event and that run. */
const eventTriggerChainDepths = new WeakMap<
  IAgentRuntime,
  Map<string, number>
>();
interface EventDispatchWindow {
  windowStart: number;
  count: number;
  reported: boolean;
}
const eventDispatchWindows = new WeakMap<
  IAgentRuntime,
  Map<string, EventDispatchWindow>
>();

const DEFAULT_MAX_ACTIVE_TRIGGERS = 100;

interface TriggerMetricsState {
  totalExecutions: number;
  totalFailures: number;
  totalSkipped: number;
  lastExecutionAt?: number;
}

export interface TriggerExecutionOptions {
  source: "scheduler" | "manual" | "event";
  force?: boolean;
  event?: {
    kind: string;
    payload?: Record<string, unknown>;
  };
}

export interface TriggerExecutionResult {
  status: "success" | "error" | "skipped";
  error?: string;
  taskDeleted: boolean;
  runRecord?: TriggerRunRecord;
  trigger?: TriggerSummary | null;
  // Present when a workflow-kind trigger dispatches to WORKFLOW_DISPATCH and
  // the service returns an execution id.
  executionId?: string;
  // The re-arm interval this fire persisted (ms until the next scheduled fire).
  // Trigger cadence VARIES per fire (e.g. a weekday cron's Fri→Mon gap), so the
  // task worker must hand this back to the scheduler as `nextInterval` — else
  // the success path falls back to a frozen `baseInterval` and drifts.
  updateInterval?: number;
}

interface NotificationEmitter {
  notify: (input: {
    title: string;
    body?: string;
    category?: string;
    priority?: string;
    source?: string;
    deepLink?: string;
    groupKey?: string;
    data?: Record<string, unknown>;
  }) => Promise<unknown>;
}

function getNotifier(runtime: IAgentRuntime): NotificationEmitter | null {
  const svc = runtime.getService(
    ServiceType.NOTIFICATION,
  ) as NotificationEmitter | null;
  return svc && typeof svc.notify === "function" ? svc : null;
}

export function triggerNotificationsEnabled(runtime: IAgentRuntime): boolean {
  const value = runtime.getSetting("ELIZA_DEBUG_TRIGGER_NOTIFICATIONS");
  return value === true || value === "true" || value === "1";
}

/**
 * User-facing creation paths persist `notifyOnOutcome`; internal, migrated, and
 * legacy triggers omit it and therefore stay off the notification rail. The
 * diagnostic override is deliberately explicit and per-runtime.
 */
function shouldNotifyForTriggerOutcome(
  runtime: IAgentRuntime,
  trigger: TriggerConfig,
): boolean {
  return (
    trigger.notifyOnOutcome === true || triggerNotificationsEnabled(runtime)
  );
}

const metricsByAgent = new Map<UUID, TriggerMetricsState>();

function getMetrics(agentId: UUID): TriggerMetricsState {
  const current = metricsByAgent.get(agentId);
  if (current) return current;
  const created: TriggerMetricsState = {
    totalExecutions: 0,
    totalFailures: 0,
    totalSkipped: 0,
  };
  metricsByAgent.set(agentId, created);
  return created;
}

function recordExecutionMetric(
  agentId: UUID,
  status: TriggerExecutionResult["status"],
  ts: number,
): void {
  const metrics = getMetrics(agentId);
  if (status === "success" || status === "error") {
    metrics.totalExecutions += 1;
    metrics.lastExecutionAt = ts;
  }
  if (status === "error") {
    metrics.totalFailures += 1;
  }
  if (status === "skipped") {
    metrics.totalSkipped += 1;
  }
}

function appendRunRecord(
  existing: TriggerRunRecord[] | undefined,
  record: TriggerRunRecord,
): TriggerRunRecord[] {
  const runs = [...(existing ?? []), record];
  return runs.length <= MAX_TRIGGER_RUN_HISTORY
    ? runs
    : runs.slice(runs.length - MAX_TRIGGER_RUN_HISTORY);
}

/** Match an event payload against a recursive subset filter. */
function eventFilterMatches(
  expected: unknown,
  actual: unknown,
  depth = 0,
): boolean {
  if (depth > 16) return false;
  if (expected === undefined) return true;
  if (expected === actual) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) =>
        eventFilterMatches(value, actual[index], depth + 1),
      )
    );
  }
  if (
    typeof expected === "object" &&
    expected !== null &&
    typeof actual === "object" &&
    actual !== null &&
    !Array.isArray(actual)
  ) {
    return Object.entries(expected as Record<string, unknown>).every(
      ([key, value]) =>
        eventFilterMatches(
          value,
          (actual as Record<string, unknown>)[key],
          depth + 1,
        ),
    );
  }
  return false;
}

function taskMetadata(task: Task): TriggerTaskMetadata {
  const metadata = task.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as TriggerTaskMetadata)
    : {};
}

export function readTriggerConfig(task: Task): TriggerConfig | null {
  const trigger = taskMetadata(task).trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger))
    return null;
  return (trigger as TriggerConfig).triggerId
    ? (trigger as TriggerConfig)
    : null;
}

export function readTriggerRuns(task: Task): TriggerRunRecord[] {
  const runs = taskMetadata(task).triggerRuns;
  return Array.isArray(runs) ? (runs as TriggerRunRecord[]) : [];
}

export function triggersFeatureEnabled(runtime?: IAgentRuntime): boolean {
  const runtimeSetting = runtime?.getSetting("ELIZA_TRIGGERS_ENABLED");
  if (
    runtimeSetting === false ||
    runtimeSetting === "false" ||
    runtimeSetting === "0"
  ) {
    return false;
  }
  const env = process.env.ELIZA_TRIGGERS_ENABLED;
  if (!env) return true;
  const normalized = env.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export function getTriggerLimit(runtime?: IAgentRuntime): number {
  const runtimeSetting = runtime?.getSetting("ELIZA_TRIGGERS_MAX_ACTIVE");
  if (typeof runtimeSetting === "number" && Number.isFinite(runtimeSetting)) {
    return Math.max(1, Math.floor(runtimeSetting));
  }
  if (typeof runtimeSetting === "string" && /^\d+$/.test(runtimeSetting)) {
    return Math.max(1, Number(runtimeSetting));
  }
  const env = process.env.ELIZA_TRIGGERS_MAX_ACTIVE;
  if (env && /^\d+$/.test(env)) {
    return Math.max(1, Number(env));
  }
  return DEFAULT_MAX_ACTIVE_TRIGGERS;
}

interface WorkflowDispatchOptionsLike {
  triggerData?: Record<string, unknown>;
  idempotencyKey?: string;
}

interface WorkflowDispatchServiceLike {
  execute(
    workflowId: string,
    payload?: Record<string, unknown>,
    options?: WorkflowDispatchOptionsLike,
  ): Promise<{
    ok: boolean;
    error?: string;
    executionId?: string;
    dedup?: boolean;
    code?: string;
  }>;
}

/**
 * Read the idempotency key the task metadata carries for this trigger
 * fire. armSchedules / rehydrateSchedules write a minute-bucketed key
 * onto the metadata so dispatch can short-circuit duplicate fires.
 */
function readTaskIdempotencyKey(task: Task): string | undefined {
  const meta = task.metadata as Record<string, unknown> | undefined;
  const key = meta?.idempotencyKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * Smithers assigns every native run event a durable id. Include the saved
 * trigger identity when deriving the workflow-dispatch key so replaying one
 * source event cannot launch the same target twice, while two independently
 * configured triggers may still react to that event.
 */
function resolveDispatchIdempotencyKey(
  task: Task,
  trigger: WorkflowTriggerConfig,
  event?: TriggerExecutionOptions["event"],
): string | undefined {
  const eventId = readNestedRunEvent(event?.payload)?.id;
  if (typeof eventId === "string" && eventId.trim().length > 0) {
    const digest = crypto
      .createHash("sha256")
      .update(event?.kind ?? "")
      .update("\0")
      .update(eventId.trim())
      .digest("hex");
    return `event:${trigger.triggerId}:${digest}`;
  }
  return readTaskIdempotencyKey(task);
}

/**
 * The native Smithers event nested inside a bridged `workflow_run_event`
 * payload. Read from persisted/untrusted shape, so every field is optional.
 */
interface NestedRunEvent {
  id?: unknown;
  runId?: unknown;
  workflowId?: unknown;
}

function readNestedRunEvent(
  payload: Record<string, unknown> | undefined,
): NestedRunEvent | undefined {
  const nested = payload?.event;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as NestedRunEvent)
    : undefined;
}

function readNestedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * How long a workflow trigger waits for the WORKFLOW_DISPATCH service before
 * declaring the workflow subsystem unavailable. plugin-workflow loads in the
 * DEFERRED boot phase and registers the dispatcher inside its init, so a
 * trigger firing in the boot window can race the registration — a bounded
 * wait turns that race into a short dispatch delay instead of a spurious
 * "Automation failed" notification.
 */
const WORKFLOW_DISPATCH_WAIT_MS = 15_000;
const WORKFLOW_DISPATCH_POLL_MS = 250;

/**
 * Resolve the workflow dispatcher, waiting out the deferred-boot window.
 * WORKFLOW_DISPATCH is a closure-based singleton set directly into the
 * runtime services map by plugin-workflow's init (no service class), so
 * `getServiceLoadPromise` can't await it — polling `getService` is the one
 * signal that exists. Returns null only when the plugin never registers it
 * (not enabled on this runtime), which is a configuration state, not a race.
 */
async function resolveWorkflowDispatch(
  runtime: IAgentRuntime,
): Promise<(Service & WorkflowDispatchServiceLike) | null> {
  const deadline = Date.now() + WORKFLOW_DISPATCH_WAIT_MS;
  for (;;) {
    const svc = runtime.getService<Service & WorkflowDispatchServiceLike>(
      "WORKFLOW_DISPATCH",
    ) as (Service & WorkflowDispatchServiceLike) | null;
    if (svc) return svc;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) =>
      setTimeout(resolve, WORKFLOW_DISPATCH_POLL_MS),
    );
  }
}

async function dispatchWorkflow(
  runtime: IAgentRuntime,
  task: Task,
  trigger: WorkflowTriggerConfig,
  event?: TriggerExecutionOptions["event"],
): Promise<
  | { ok: true; executionId?: string; dedup?: boolean }
  | { ok: false; error: string; code?: string }
> {
  if (!trigger.workflowId) {
    return { ok: false, error: "workflow trigger missing workflowId" };
  }
  const svc = await resolveWorkflowDispatch(runtime);
  if (!svc) {
    runtime.logger.warn(
      {
        src: "trigger-runtime",
        triggerId: trigger.triggerId,
        workflowId: trigger.workflowId,
      },
      "[triggers] workflow dispatch requested but the workflow plugin never registered WORKFLOW_DISPATCH — is @elizaos/plugin-workflow enabled on this agent?",
    );
    return {
      ok: false,
      error:
        "workflow subsystem unavailable: the workflow plugin is not enabled on this agent",
    };
  }
  const idempotencyKey = resolveDispatchIdempotencyKey(task, trigger, event);
  const payload = event
    ? {
        eventKind: event.kind,
        eventPayload: event.payload ?? {},
      }
    : {};
  const result = await svc.execute(trigger.workflowId, payload, {
    idempotencyKey,
  });
  return result.ok
    ? {
        ok: true,
        executionId: result.executionId,
        ...(result.dedup === true ? { dedup: true } : {}),
      }
    : {
        ok: false,
        error: result.error ?? "workflow execution failed",
        ...(result.code ? { code: result.code } : {}),
      };
}

interface AutonomyRoomService {
  getAutonomousRoomId?(): UUID;
}

/**
 * Dispatch a `prompt`-kind trigger: inject the trigger's `instructions` as an
 * agent turn via the message-service pipeline, so the agent can act on it (the
 * "prompt automation" path). The message is authored by a per-trigger synthetic
 * entity (never the agent's own id — the pipeline skips messages "from self").
 *
 * Delivery: connector rooms (Discord/Telegram/…) post replies ONLY through the
 * turn's callback or an explicit send — persisting the reply memory alone shows
 * nothing to the user. When the trigger has an origin room on a connector, the
 * agent's reply is forwarded there via `runtime.sendMessageToTarget`, so a
 * fired reminder actually reaches the chat it was created in. Triggers with no
 * origin room land in the autonomy room as before.
 */
async function dispatchPrompt(
  runtime: IAgentRuntime,
  trigger: PromptTriggerConfig,
  originRoomId?: UUID,
): Promise<
  { ok: true; executionId?: undefined } | { ok: false; error: string }
> {
  const instructions = trigger.instructions.trim();
  if (!instructions) {
    return { ok: false, error: "prompt trigger missing instructions" };
  }
  const messageService = runtime.messageService;
  if (!messageService) {
    return { ok: false, error: "message service not available" };
  }

  // Deliver where the trigger was created (a reminder's originating chat room)
  // so the user actually receives it; fall back to the autonomy room for
  // triggers with no origin room (e.g. system-seeded prompt automations).
  const roomId =
    originRoomId ??
    (
      runtime.getService("AUTONOMY") as AutonomyRoomService | null
    )?.getAutonomousRoomId?.() ??
    stringToUuid(`trigger-room:${runtime.agentId}`);
  const entityId = stringToUuid(`trigger-entity:${trigger.triggerId}`);

  const message: Memory = {
    id: stringToUuid(crypto.randomUUID()),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      // Provenance framing: the model only sees text, so the fired trigger
      // must identify itself — a bare instruction like "drink water" reads as
      // ambient chatter and gets re-interpreted instead of acted on.
      text: `Scheduled trigger "${trigger.displayName}" fired. Do this now: ${instructions}`,
      source: MESSAGE_SOURCE_TRIGGER_PROMPT,
      metadata: {
        type: "prompt-automation",
        triggerId: trigger.triggerId,
        wakeMode: trigger.wakeMode,
      },
    },
    createdAt: Date.now(),
  };

  // error-policy:J1 boundary translation — the trigger dispatch boundary
  // returns a structured failure so executeTriggerTask records the run,
  // notifies the rail, and logs the REAL cause; an uncaught throw would be
  // swallowed into the task service's generic "execution failed" wrapper.
  try {
    const room = await runtime.getRoom(roomId);

    // Forward the turn's replies to the origin room's connector. The reply
    // content is already model-voiced, so it is marked agentVoiced to skip
    // the outbound voice-gate rephrase.
    let deliveryCallback: HandlerCallback | undefined;
    const connectorSource = originRoomId ? room?.source?.trim() : undefined;
    if (originRoomId && connectorSource) {
      deliveryCallback = async (content) => {
        const disposition = inspectSendHandlerResult(
          await runtime.sendMessageToTarget(
            { source: connectorSource, roomId: originRoomId },
            { ...content, agentVoiced: true },
          ),
        );
        if (disposition.kind !== "delivered") {
          throw new Error(
            `Trigger reply was not fully delivered: ${disposition.message}`,
          );
        }
        if (
          disposition.receipt &&
          (disposition.receipt.persistence.status === "partial" ||
            disposition.receipt.persistence.status === "failed")
        ) {
          throw new Error(
            `Trigger reply reached the provider, but local evidence is ${disposition.receipt.persistence.status}; do not retry blindly.`,
          );
        }
        return [...disposition.memories];
      };
    }

    // The synthetic author must exist as an entity + room participant before
    // the pipeline persists its message — the same contract every connector
    // honors for real users. Without it the turn dies on the memory write.
    // `ensureConnection` UPSERTS the room (channelId defaults to roomId, type
    // to DM), so an existing room's own fields MUST be passed through or the
    // upsert corrupts a connector room's channel mapping and delivery breaks.
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId:
        room?.worldId ?? stringToUuid(`trigger-world:${runtime.agentId}`),
      roomName: room?.name,
      channelId: room?.channelId,
      messageServerId: room?.messageServerId,
      type: room?.type,
      name: `Trigger: ${trigger.displayName}`,
      userName: "trigger",
      source: room?.source ?? MESSAGE_SOURCE_TRIGGER_PROMPT,
    });
    // Self-certifying provenance for the owner-exclusive disclosure census
    // (#19999): the synthetic author stays a durable room participant after
    // this turn, so the census must be able to verify — not trust — that it is
    // runtime-made. The marker holds the triggerId whose hash IS this entity's
    // id; connector-minted entities derive their ids differently and cannot
    // reproduce the relationship.
    try {
      const authorEntity = await runtime.getEntityById(entityId);
      const marker = (
        authorEntity?.metadata as
          | { triggerEntity?: { triggerId?: unknown } }
          | undefined
      )?.triggerEntity;
      if (authorEntity && marker?.triggerId !== trigger.triggerId) {
        await runtime.updateEntity({
          ...authorEntity,
          metadata: {
            ...authorEntity.metadata,
            triggerEntity: { triggerId: trigger.triggerId },
          },
        });
      }
    } catch (err) {
      // error-policy:J7 a failed marker write must not block the fire; the
      // census then keeps this participant and the disclosure gate stays
      // strict until a later fire re-stamps it.
      runtime.reportError("TriggerRuntime.entityProvenanceMarker", err, {
        triggerId: trigger.triggerId,
        entityId,
      });
    }
    const releaseInternalActor = registerRuntimeManagedInternalActor(
      runtime,
      entityId,
    );
    try {
      await messageService.handleMessage(runtime, message, deliveryCallback);
    } finally {
      releaseInternalActor();
    }
  } catch (err) {
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack.split("\n").slice(1, 4).join("\n")}` : ""}`
        : String(err);
    return { ok: false, error: detail };
  }
  return { ok: true };
}

export async function executeTriggerTask(
  runtime: IAgentRuntime,
  task: Task,
  options: TriggerExecutionOptions,
): Promise<TriggerExecutionResult> {
  if (!task.id) {
    return { status: "skipped", taskDeleted: false };
  }

  const trigger = readTriggerConfig(task);
  if (!trigger) {
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  if (!trigger.enabled && !options.force) {
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  if (
    options.source === "event" &&
    trigger.triggerType !== "event" &&
    !options.force
  ) {
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  if (
    options.source === "event" &&
    trigger.triggerType === "event" &&
    !eventFilterMatches(trigger.eventFilter, options.event?.payload) &&
    !options.force
  ) {
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  if (
    options.source === "event" &&
    trigger.triggerType === "event" &&
    trigger.eventKind !== options.event?.kind &&
    !options.force
  ) {
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  if (
    typeof trigger.maxRuns === "number" &&
    trigger.maxRuns > 0 &&
    trigger.runCount >= trigger.maxRuns
  ) {
    await runtime.deleteTask(task.id);
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return {
      status: "skipped",
      taskDeleted: true,
      trigger: taskToTriggerSummary(task),
    };
  }

  // `trigger.kind` is a `TriggerKind` literal in the type system, but the value
  // is read from persisted jsonb, so a corrupt row could carry anything. Widen
  // to string once here so the guard can report the offending value without a
  // cast on the narrowed (`never`) branch.
  const triggerKind: string = trigger.kind;
  if (triggerKind !== "workflow" && triggerKind !== "prompt") {
    runtime.logger.warn(
      {
        src: "trigger-runtime",
        taskId: task.id,
        triggerId: trigger.triggerId,
        kind: triggerKind,
      },
      "Trigger kind is not workflow or prompt; skipping",
    );
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  const startedAt = Date.now();
  let status: TriggerExecutionResult["status"] = "success";
  let errorMessage = "";
  let workflowExecutionId: string | undefined;
  let workflowGone = false;
  const dispatchedWorkflowId =
    trigger.kind === "workflow" ? trigger.workflowId : undefined;

  const result =
    trigger.kind === "workflow"
      ? await dispatchWorkflow(runtime, task, trigger, options.event)
      : await dispatchPrompt(runtime, trigger, task.roomId);
  if (result.ok === true && "dedup" in result && result.dedup === true) {
    // The workflow dispatcher has already accepted this native event identity.
    // A replay is not a new trigger run: recording it would inflate runCount,
    // emit a duplicate success notification, and could prematurely exhaust
    // maxRuns even though no second workflow execution was started.
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return {
      status: "skipped",
      taskDeleted: false,
      trigger: taskToTriggerSummary(task),
      executionId: result.executionId,
    };
  }
  if (result.ok === true) {
    // Only workflow dispatch carries an execution id; prompt dispatch types it
    // as `undefined`, so this reads `string | undefined` without a cast.
    workflowExecutionId = result.executionId;
  } else {
    status = "error";
    errorMessage = result.error;
    // A workflow_not_found dispatch is permanent: the workflow row was
    // deleted, so every future fire of this schedule fails identically. One
    // final "disabled" notification and task deletion below replace the
    // hourly failed-automation storm.
    workflowGone = "code" in result && result.code === "workflow_not_found";
    runtime.logger.error(
      {
        src: "trigger-runtime",
        agentId: runtime.agentId,
        taskId: task.id,
        triggerId: trigger.triggerId,
        kind: trigger.kind,
        workflowId:
          trigger.kind === "workflow" ? trigger.workflowId : undefined,
        error: errorMessage,
        ...(workflowGone ? { permanentFailure: "workflow_not_found" } : {}),
      },
      workflowGone
        ? "Trigger workflow no longer exists; disabling the schedule"
        : "Trigger dispatch failed",
    );
    // Scheduled automations run without the user in the chat loop, so a
    // dispatch failure is otherwise invisible. Surface it on the notification
    // rail (fire-and-forget; never let a notify failure mask the trigger error).
    if (shouldNotifyForTriggerOutcome(runtime, trigger)) {
      void getNotifier(runtime)
        ?.notify({
          title: workflowGone
            ? `Automation "${trigger.displayName}" disabled`
            : `Automation "${trigger.displayName}" failed`,
          body: workflowGone
            ? "Its workflow no longer exists, so the schedule was removed. Recreate the automation if you still need it."
            : truncateWellFormed(toWellFormedUnicode(errorMessage), 200),
          category: "workflow",
          priority: "high",
          source: "trigger",
          groupKey: `trigger:${task.id ?? trigger.triggerId}`,
          data: {
            taskId: task.id,
            triggerId: trigger.triggerId,
            error: errorMessage,
          },
        })
        .catch((error) => {
          // error-policy:J7 notification diagnostics must not mask dispatch failure.
          runtime.reportError("TriggerRuntime.notifyFailure", error, {
            taskId: task.id,
            triggerId: trigger.triggerId,
          });
        });
    }
  }

  if (status === "success") {
    runtime.logger.info(
      {
        src: "trigger-runtime",
        triggerId: trigger.triggerId,
        triggerName: trigger.displayName,
        triggerType: trigger.triggerType,
        source: options.source,
        latencyMs: Date.now() - startedAt,
      },
      `Trigger "${trigger.displayName}" executed successfully`,
    );
    // Scheduled automations run without the user in the chat loop, so a
    // successful completion is otherwise invisible — the rail only ever showed
    // the failure path (#10697). Surface a low-priority "completed" so the user
    // can see the agent finished the task. Grouped per trigger so a frequently
    // scheduled automation updates ONE rail entry instead of spamming, and
    // fire-and-forget so a notify failure never masks the successful run.
    if (shouldNotifyForTriggerOutcome(runtime, trigger)) {
      void getNotifier(runtime)
        ?.notify({
          title: `Automation "${trigger.displayName}" completed`,
          category: "workflow",
          priority: "low",
          source: "trigger",
          groupKey: `trigger:${task.id ?? trigger.triggerId}`,
          data: {
            taskId: task.id,
            triggerId: trigger.triggerId,
            workflowExecutionId,
          },
        })
        .catch((error) => {
          // error-policy:J7 notification diagnostics must not change run success.
          runtime.reportError("TriggerRuntime.notifySuccess", error, {
            taskId: task.id,
            triggerId: trigger.triggerId,
          });
        });
    }
  }

  let taskToPersist = task;
  let triggerToPersist = trigger;
  if (options.source === "event") {
    const currentTask = await runtime.getTask(task.id);
    if (!currentTask) {
      const finishedAt = Date.now();
      recordExecutionMetric(runtime.agentId, status, finishedAt);
      return {
        status,
        error: errorMessage || undefined,
        taskDeleted: true,
        executionId: workflowExecutionId,
      };
    }
    const currentTrigger = readTriggerConfig(currentTask);
    if (!currentTrigger) {
      const finishedAt = Date.now();
      recordExecutionMetric(runtime.agentId, status, finishedAt);
      return {
        status,
        error: errorMessage || undefined,
        taskDeleted: false,
        executionId: workflowExecutionId,
      };
    }
    taskToPersist = currentTask;
    triggerToPersist = currentTrigger;
  }

  const finishedAt = Date.now();
  const runRecord: TriggerRunRecord = {
    triggerRunId: stringToUuid(crypto.randomUUID()),
    triggerId: triggerToPersist.triggerId,
    taskId: task.id,
    startedAt,
    finishedAt,
    status,
    error: errorMessage || undefined,
    latencyMs: finishedAt - startedAt,
    source: options.source,
    eventKind: options.event?.kind,
  };

  const updatedTrigger: TriggerConfig = {
    ...triggerToPersist,
    runCount: triggerToPersist.runCount + 1,
    lastRunAtIso: new Date(finishedAt).toISOString(),
    lastStatus: status,
    lastError: errorMessage || undefined,
  };

  const workflowStillGone =
    workflowGone &&
    triggerToPersist.kind === "workflow" &&
    triggerToPersist.workflowId === dispatchedWorkflowId;
  const shouldDeleteTask =
    workflowStillGone ||
    updatedTrigger.triggerType === "once" ||
    (typeof updatedTrigger.maxRuns === "number" &&
      updatedTrigger.maxRuns > 0 &&
      updatedTrigger.runCount >= updatedTrigger.maxRuns);

  const existingMetadata = taskMetadata(taskToPersist);
  const nextMetadata = buildTriggerMetadata({
    existingMetadata,
    trigger: updatedTrigger,
    nowMs: finishedAt,
  });

  let metadataToPersist: TriggerTaskMetadata;
  if (!nextMetadata && !updatedTrigger.enabled) {
    metadataToPersist = {
      ...existingMetadata,
      updatedAt: finishedAt,
      updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
      trigger: {
        ...updatedTrigger,
        nextRunAtMs: finishedAt + DISABLED_TRIGGER_INTERVAL_MS,
      },
      triggerRuns: appendRunRecord(existingMetadata.triggerRuns, runRecord),
    };
  } else if (!nextMetadata) {
    metadataToPersist = {
      ...existingMetadata,
      updatedAt: finishedAt,
      updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
      trigger: {
        ...updatedTrigger,
        enabled: false,
        nextRunAtMs: finishedAt + DISABLED_TRIGGER_INTERVAL_MS,
        lastError:
          updatedTrigger.lastError ?? "Failed to compute next trigger schedule",
      },
      triggerRuns: appendRunRecord(existingMetadata.triggerRuns, runRecord),
    };
  } else {
    metadataToPersist = {
      ...nextMetadata,
      triggerRuns: appendRunRecord(existingMetadata.triggerRuns, runRecord),
    };
  }

  // Refresh the idempotency key for the next fire so a re-run within the
  // same minute window collapses at dispatch. The schedule-arming layer
  // (`armSchedules`) seeds the initial key with the same formula.
  if (
    metadataToPersist.trigger?.kind === "workflow" &&
    metadataToPersist.trigger.workflowId &&
    typeof metadataToPersist.trigger.nextRunAtMs === "number"
  ) {
    const minuteBucket = Math.floor(
      metadataToPersist.trigger.nextRunAtMs / 60_000,
    );
    metadataToPersist.idempotencyKey = `${metadataToPersist.trigger.workflowId}:${minuteBucket}`;
  } else {
    delete metadataToPersist.idempotencyKey;
  }

  await runtime.updateTask(task.id, {
    description:
      metadataToPersist.trigger?.displayName ?? taskToPersist.description,
    metadata: metadataToPersist,
  });

  const updatedTask: Task = {
    ...taskToPersist,
    description:
      metadataToPersist.trigger?.displayName ?? taskToPersist.description,
    metadata: metadataToPersist,
  };
  const triggerSummary = taskToTriggerSummary(updatedTask);

  if (shouldDeleteTask) {
    await runtime.deleteTask(task.id);
    recordExecutionMetric(runtime.agentId, status, finishedAt);
    return {
      status,
      error: errorMessage || undefined,
      runRecord,
      taskDeleted: true,
      trigger: triggerSummary,
      executionId: workflowExecutionId,
    };
  }

  recordExecutionMetric(runtime.agentId, status, finishedAt);
  return {
    status,
    error: errorMessage || undefined,
    runRecord,
    taskDeleted: false,
    trigger: triggerSummary,
    executionId: workflowExecutionId,
    updateInterval:
      typeof metadataToPersist.updateInterval === "number"
        ? metadataToPersist.updateInterval
        : undefined,
  };
}

/**
 * Copy an emitted event payload into a plain, transportable object. The result
 * becomes workflow input, so runtime/function handles are dropped and
 * `__proto__` is never assigned through a computed key. Property reads are
 * individually guarded because a subscriber must never fail the emitting run
 * over one hostile or lazily-computed accessor.
 */
function serializableEventPayload(
  runtime: IAgentRuntime,
  eventKind: string,
  params: EventPayload,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  // `EventPayload` is a closed interface, but subscribers receive whatever the
  // emitter constructed, so the copy reads it as an open record.
  const source = params as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key === "runtime" || key === "source" || key === "__proto__") continue;
    let value: unknown;
    try {
      value = source[key];
    } catch (error) {
      // error-policy:J7 an accessor that throws is a defect in the emitter, not
      // a reason to reject the source run's own event recording; the key is
      // dropped from the bridged payload and the failure is reported.
      runtime.reportError("TriggerRuntime.eventPayload", error, {
        eventKind,
        key,
      });
      continue;
    }
    if (typeof value === "function") continue;
    payload[key] = value;
  }
  return payload;
}

async function listEventTriggerTasks(runtime: IAgentRuntime): Promise<Task[]> {
  if (!triggersFeatureEnabled(runtime)) return [];
  // Saved triggers always carry the trigger tags; heartbeat-only repeat tasks
  // can never hold an event trigger config, so the event path reads one tag set
  // instead of the two `listTriggerTasks` merges for the Automations UI.
  return runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: ["repeat", "trigger"],
  });
}

/**
 * Discover event triggers for one emitted event.
 *
 * Trigger creation and enablement have no invalidation channel, so a cached
 * snapshot can miss a trigger saved moments before the event. The query is
 * therefore never reused across event-loop turns; it is only shared by events
 * observed in the same turn, which is safe because the query is issued in a
 * microtask after all of those events have already arrived.
 */
function discoverEventTriggerTasks(runtime: IAgentRuntime): Promise<Task[]> {
  const batched = eventDiscoveryBatches.get(runtime);
  if (batched) return batched;
  const batch = Promise.resolve().then(() => {
    eventDiscoveryBatches.delete(runtime);
    return listEventTriggerTasks(runtime);
  });
  eventDiscoveryBatches.set(runtime, batch);
  return batch;
}

/** Trigger hops between an external event and the run that emitted `runId`. */
function readChainDepth(runtime: IAgentRuntime, runId?: string): number {
  if (!runId) return 0;
  return eventTriggerChainDepths.get(runtime)?.get(runId) ?? 0;
}

function recordChainDepth(
  runtime: IAgentRuntime,
  runId: string,
  depth: number,
): void {
  const depths =
    eventTriggerChainDepths.get(runtime) ?? new Map<string, number>();
  eventTriggerChainDepths.set(runtime, depths);
  depths.set(runId, depth);
  // Insertion-ordered eviction keeps ancestry bounded for long-lived hosts.
  while (depths.size > MAX_EVENT_TRIGGER_CHAIN_ENTRIES) {
    const oldest = depths.keys().next();
    if (oldest.done) break;
    depths.delete(oldest.value);
  }
}

/**
 * Consume one dispatch slot for a saved trigger, returning false once the
 * sustained ceiling is reached so a runaway configuration stops compounding.
 */
function admitTriggerDispatch(
  runtime: IAgentRuntime,
  triggerId: string,
  eventKind: string,
): boolean {
  const windows =
    eventDispatchWindows.get(runtime) ?? new Map<string, EventDispatchWindow>();
  eventDispatchWindows.set(runtime, windows);
  const now = Date.now();
  const window = windows.get(triggerId);
  if (!window || now - window.windowStart >= EVENT_DISPATCH_WINDOW_MS) {
    windows.set(triggerId, { windowStart: now, count: 1, reported: false });
    return true;
  }
  if (window.count < MAX_EVENT_DISPATCHES_PER_WINDOW) {
    window.count += 1;
    return true;
  }
  if (!window.reported) {
    window.reported = true;
    runtime.reportError(
      "TriggerRuntime.eventDispatch",
      new ElizaError(
        `Event trigger ${triggerId} exceeded ${MAX_EVENT_DISPATCHES_PER_WINDOW} dispatches per minute; further events are dropped until the window rolls`,
        {
          code: "TRIGGER_EVENT_DISPATCH_RATE_EXCEEDED",
          context: { triggerId, eventKind },
        },
      ),
      { triggerId, eventKind },
    );
  }
  return false;
}

/**
 * Dispatch one runtime event through the same persisted trigger engine the
 * scheduler uses, serialized per saved trigger so concurrent emissions observe
 * each other's persisted run state.
 */
export async function dispatchRuntimeEventTriggers(
  runtime: IAgentRuntime,
  eventKind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const nestedEvent = readNestedRunEvent(payload);
  const sourceWorkflowId = readNestedString(nestedEvent?.workflowId);
  const sourceRunId = readNestedString(nestedEvent?.runId);
  const chainDepth = readChainDepth(runtime, sourceRunId);
  if (chainDepth >= MAX_EVENT_TRIGGER_CHAIN_DEPTH) {
    // The emitting run was itself started by a trigger chain that has already
    // reached its hop limit. Continuing would let a mutually referential
    // configuration (A triggers B, B triggers A) run without ever quiescing.
    runtime.logger.warn(
      { src: "trigger-runtime", eventKind, runId: sourceRunId, chainDepth },
      "Event trigger chain depth limit reached; not dispatching further",
    );
    return;
  }

  const tasks = await discoverEventTriggerTasks(runtime);
  const matchingTasks = tasks.filter((task) => {
    const trigger = readTriggerConfig(task);
    if (
      trigger?.enabled !== true ||
      trigger.triggerType !== "event" ||
      trigger.eventKind !== eventKind
    ) {
      return false;
    }
    if (
      trigger.kind === "workflow" &&
      sourceWorkflowId !== undefined &&
      trigger.workflowId === sourceWorkflowId
    ) {
      // The trigger's target is the workflow that emitted this event. Every
      // dispatched run emits the same event again under a fresh run id, so the
      // durable idempotency key never collapses it: this is unbounded by
      // construction and is never a configuration worth honoring.
      runtime.logger.warn(
        {
          src: "trigger-runtime",
          eventKind,
          triggerId: trigger.triggerId,
          workflowId: sourceWorkflowId,
        },
        "Event trigger targets the workflow that emitted the event; skipping self-trigger",
      );
      return false;
    }
    return true;
  });

  const queues =
    eventDispatchQueues.get(runtime) ?? new Map<UUID, Promise<void>>();
  eventDispatchQueues.set(runtime, queues);

  await Promise.all(
    matchingTasks.map(async (task) => {
      if (!task.id) return;
      const taskId = task.id;
      const prior = queues.get(taskId) ?? Promise.resolve();
      const pending = prior.then(async () => {
        try {
          // Re-read after preceding events finish. This preserves runCount,
          // maxRuns, enabled state, and edited filters under concurrent source
          // workflow runs instead of executing against a stale task snapshot.
          const currentTask = await runtime.getTask(taskId);
          if (!currentTask) return;
          const currentTrigger = readTriggerConfig(currentTask);
          if (
            currentTrigger &&
            !admitTriggerDispatch(runtime, currentTrigger.triggerId, eventKind)
          ) {
            return;
          }
          const result = await executeTriggerTask(runtime, currentTask, {
            source: "event",
            event: { kind: eventKind, payload },
          });
          if (result.executionId) {
            // The dispatched run's id is the ancestry key its own emitted
            // events will carry, so the chain can be bounded at the next hop.
            recordChainDepth(runtime, result.executionId, chainDepth + 1);
          }
        } catch (error) {
          // error-policy:J7 one trigger's persistence/dispatch failure must not
          // reject the source runtime event or prevent sibling triggers.
          runtime.reportError("TriggerRuntime.eventDispatch", error, {
            eventKind,
            taskId,
          });
        }
      });
      queues.set(taskId, pending);
      await pending;
      if (queues.get(taskId) === pending) queues.delete(taskId);
    }),
  );
}

function registerRuntimeEventTriggerBridge(runtime: IAgentRuntime): void {
  if (eventBridgeRegistrations.has(runtime)) return;

  for (const eventKind of RUNTIME_TRIGGER_EVENT_KINDS) {
    runtime.registerEvent(eventKind, async (params: EventPayload) => {
      try {
        const payload = serializableEventPayload(runtime, eventKind, params);
        void dispatchRuntimeEventTriggers(runtime, eventKind, payload).catch(
          (error) => {
            // error-policy:J7 trigger discovery failures are observed without
            // blocking the source message or a nested Smithers execution event.
            runtime.reportError("TriggerRuntime.eventBridge", error, {
              eventKind,
            });
          },
        );
      } catch (error) {
        // error-policy:J7 the handler is awaited by `emitEvent`, which the
        // Smithers service awaits inside `recordEvent`. Any synchronous failure
        // here would fail the emitting workflow run, so it is reported instead.
        runtime.reportError("TriggerRuntime.eventBridge", error, { eventKind });
      }
    });
  }

  eventBridgeRegistrations.add(runtime);
}

export function registerTriggerTaskWorker(runtime: IAgentRuntime): void {
  if (!runtime.getTaskWorker(TRIGGER_TASK_NAME)) {
    runtime.registerTaskWorker({
      name: TRIGGER_TASK_NAME,
      shouldRun: async () => true,
      execute: async (rt, options, task) => {
        const result = await executeTriggerTask(rt, task, {
          source: options.source === "manual" ? "manual" : "scheduler",
          force: options.force === true,
        });
        // Hand the per-fire re-arm interval back to the task service as scheduling
        // metadata. Without it, the service's success path falls through to a
        // frozen `baseInterval` (seeded on the first transient failure), so a
        // varying-cadence trigger (e.g. weekday cron) permanently drifts — firing
        // on the wrong days. Deleted tasks don't reschedule, so return nothing.
        if (!result.taskDeleted && typeof result.updateInterval === "number") {
          return { nextInterval: result.updateInterval };
        }
        return undefined;
      },
    });
  }

  registerRuntimeEventTriggerBridge(runtime);
}

export async function listTriggerTasks(
  runtime: IAgentRuntime,
): Promise<Task[]> {
  if (!triggersFeatureEnabled(runtime)) return [];
  const agentIds = [runtime.agentId];
  const [triggerTasks, heartbeatTasks] = await Promise.all([
    runtime.getTasks({
      agentIds,
      tags: ["repeat", "trigger"],
    }),
    runtime.getTasks({
      agentIds,
      tags: ["repeat", "heartbeat"],
    }),
  ]);

  const merged = new Map<string, Task>();
  for (const task of [...triggerTasks, ...heartbeatTasks]) {
    const key =
      task.id ??
      `${task.name}:${task.description ?? ""}:${(task.tags ?? []).join(",")}`;
    if (!merged.has(key)) {
      merged.set(key, task);
    }
  }
  return [...merged.values()];
}

function isExplicitHeartbeatTask(task: Task): boolean {
  const tags = task.tags ?? [];
  return HEARTBEAT_TASK_TAGS.every((tag) => tags.includes(tag));
}

/**
 * Derive a friendly display name for a plugin-owned repeat task that
 * doesn't carry explicit trigger metadata. Prefers the task's own
 * `name` (e.g. "IMESSAGE_HEARTBEAT") humanized, then falls back to the
 * first non-generic tag ("imessage", "telegram", etc.), then to a
 * generic "System Heartbeat" label.
 */
function deriveSystemHeartbeatName(task: Task): string {
  if (task.name && task.name.length > 0) {
    return task.name
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const tag = (task.tags ?? []).find(
    (t) => t !== "queue" && t !== "repeat" && t !== "trigger",
  );
  if (tag) {
    return `${tag.charAt(0).toUpperCase()}${tag.slice(1)} Heartbeat`;
  }
  return "System Heartbeat";
}

/**
 * Synthesize a read-only TriggerSummary for an explicit heartbeat task
 * that Eliza's trigger schema doesn't fully own. This is narrower than
 * "any repeat task": internal queue drains and runtime schedulers should
 * stay out of the Heartbeats UI even though they also use repeat tasks.
 */
function synthesizeSystemHeartbeatSummary(task: Task): TriggerSummary | null {
  if (!task.id) return null;
  const metadata = taskMetadata(task);
  const intervalMs =
    typeof metadata.updateInterval === "number"
      ? metadata.updateInterval
      : undefined;
  const tags = task.tags ?? [];
  // Identify the owning plugin from the third tag (first two are "queue"
  // and "repeat"). This becomes createdBy so the UI can group by source.
  const createdBy =
    tags.find((t) => t !== "queue" && t !== "repeat" && t !== "trigger") ??
    "system";
  return {
    id: task.id,
    taskId: task.id,
    displayName: deriveSystemHeartbeatName(task),
    instructions: task.description ?? "",
    triggerType: "interval",
    enabled: true,
    wakeMode: "next_autonomy_cycle",
    createdBy,
    intervalMs,
    runCount: 0,
    updatedAt:
      typeof metadata.updatedAt === "number" ? metadata.updatedAt : undefined,
    updateInterval: intervalMs,
  };
}

export function taskToTriggerSummary(task: Task): TriggerSummary | null {
  const trigger = readTriggerConfig(task);
  if (trigger && task.id) {
    const metadata = taskMetadata(task);
    return {
      id: trigger.triggerId,
      taskId: task.id,
      displayName: trigger.displayName,
      instructions: trigger.instructions,
      triggerType: trigger.triggerType,
      enabled: trigger.enabled,
      wakeMode: trigger.wakeMode,
      createdBy: trigger.createdBy,
      timezone: trigger.timezone,
      intervalMs: trigger.intervalMs,
      scheduledAtIso: trigger.scheduledAtIso,
      cronExpression: trigger.cronExpression,
      eventKind: trigger.eventKind,
      eventFilter: trigger.eventFilter,
      maxRuns: trigger.maxRuns,
      runCount: trigger.runCount,
      nextRunAtMs: trigger.nextRunAtMs,
      lastRunAtIso: trigger.lastRunAtIso,
      lastStatus: trigger.lastStatus,
      lastError: trigger.lastError,
      updatedAt: metadata.updatedAt,
      updateInterval: metadata.updateInterval,
      kind: trigger.kind,
      workflowId: trigger.kind === "workflow" ? trigger.workflowId : undefined,
      workflowName:
        trigger.kind === "workflow" ? trigger.workflowName : undefined,
    };
  }

  if (isExplicitHeartbeatTask(task)) {
    return synthesizeSystemHeartbeatSummary(task);
  }

  return null;
}

export async function getTriggerHealthSnapshot(
  runtime: IAgentRuntime,
): Promise<TriggerHealthSnapshot> {
  const tasks = await listTriggerTasks(runtime);
  let activeTriggers = 0;
  let disabledTriggers = 0;

  let durableExecutions = 0;
  let durableFailures = 0;
  let durableLastExecAt: number | undefined;

  for (const task of tasks) {
    const trigger = readTriggerConfig(task);
    if (!trigger) continue;
    if (trigger.enabled) {
      activeTriggers += 1;
    } else {
      disabledTriggers += 1;
    }

    const runs = readTriggerRuns(task);
    for (const run of runs) {
      durableExecutions += 1;
      if (run.status === "error") durableFailures += 1;
      if (!durableLastExecAt || run.finishedAt > durableLastExecAt) {
        durableLastExecAt = run.finishedAt;
      }
    }
  }

  const inMemory = getMetrics(runtime.agentId);
  return {
    triggersEnabled: triggersFeatureEnabled(runtime),
    activeTriggers,
    disabledTriggers,
    totalExecutions: Math.max(inMemory.totalExecutions, durableExecutions),
    totalFailures: Math.max(inMemory.totalFailures, durableFailures),
    totalSkipped: inMemory.totalSkipped,
    lastExecutionAt: inMemory.lastExecutionAt ?? durableLastExecAt,
  };
}

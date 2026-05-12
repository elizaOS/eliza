import type {
  IAgentRuntime,
  JsonValue,
  Memory,
  Task,
  TaskMetadata,
  UUID,
} from "@elizaos/core";
import {
  createUniqueUuid,
  logger,
  MemoryType,
  stringToUuid,
} from "@elizaos/core";
import { loadLifeOpsAppState } from "../lifeops/app-state.js";
import {
  type BackgroundJobContext,
  BackgroundPlannerError,
  planJob,
} from "../lifeops/background-planner.js";
import { enqueueIfSensitive } from "../lifeops/background-planner-dispatch.js";

/**
 * Periodically scans known contacts managed by the RelationshipsService and
 * identifies contacts whose `lastContactedAt` has exceeded the configured
 * threshold. Overdue entries are written as a single consolidated memory per
 * tick (`followup_overdue_digest`) so the morning check-in + the
 * `LIST_OVERDUE_FOLLOWUPS` action can pull from a canonical location.
 *
 * If `RelationshipsService` is not registered on the runtime, the tracker logs
 * once at info level and returns an empty digest.
 */

/**
 * Structural view of the RelationshipsService shape we depend on. Kept local
 * so this module doesn't force a compile-time dependency on the core service
 * type, and so it degrades gracefully when the service isn't registered.
 */
export interface ContactInfo {
  entityId: UUID;
  categories: string[];
  tags: string[];
  customFields: Record<string, JsonValue>;
}

export interface RelationshipsServiceLike {
  searchContacts(criteria: Record<string, unknown>): Promise<ContactInfo[]>;
  getContact(entityId: UUID): Promise<ContactInfo | null>;
  updateContact(
    entityId: UUID,
    updates: { customFields?: Record<string, JsonValue> },
  ): Promise<ContactInfo | null>;
}

function isRelationshipsServiceLike(
  service: unknown,
): service is RelationshipsServiceLike {
  if (!service || typeof service !== "object") return false;
  const candidate = service as Partial<RelationshipsServiceLike>;
  return (
    typeof candidate.searchContacts === "function" &&
    typeof candidate.getContact === "function" &&
    typeof candidate.updateContact === "function"
  );
}

export const FOLLOWUP_TRACKER_TASK_NAME = "FOLLOWUP_TRACKER_RECONCILE" as const;
export const FOLLOWUP_TRACKER_TASK_TAGS = [
  "queue",
  "repeat",
  "relationships",
  "followup-tracker",
] as const;
export const FOLLOWUP_TRACKER_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
export const FOLLOWUP_DEFAULT_THRESHOLD_DAYS = 30;
export const FOLLOWUP_MEMORY_TABLE = "reminders" as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveTrackerNowMs(options: Record<string, unknown> = {}): number {
  const raw = options.now;
  if (raw instanceof Date) {
    return raw.getTime();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = new Date(raw).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function isFollowupTrackerTask(task: Task): boolean {
  return task.name === FOLLOWUP_TRACKER_TASK_NAME;
}

function buildFollowupTrackerMetadata(
  previous?: TaskMetadata | null,
): TaskMetadata {
  const metadata: TaskMetadata = {
    ...(isRecord(previous) ? previous : {}),
    updateInterval: FOLLOWUP_TRACKER_INTERVAL_MS,
  };
  return metadata;
}

export interface OverdueFollowup {
  entityId: UUID;
  displayName: string;
  lastContactedAt: string;
  daysOverdue: number;
  thresholdDays: number;
}

export interface OverdueDigest {
  generatedAt: string;
  thresholdDefaultDays: number;
  overdue: OverdueFollowup[];
}

export function getRelationshipsServiceLike(
  runtime: IAgentRuntime,
): RelationshipsServiceLike | null {
  const service = runtime.getService("relationships");
  if (!service) return null;
  return isRelationshipsServiceLike(service) ? service : null;
}

let degradedLogged = false;

function getNumberField(contact: ContactInfo, key: string): number | null {
  const value = contact.customFields[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getStringField(contact: ContactInfo, key: string): string | null {
  const value = contact.customFields[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolveLastContactedAtMs(contact: ContactInfo): number | null {
  const raw =
    getStringField(contact, "lastContactedAt") ??
    getStringField(contact, "lastInteractionAt");
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function resolveThresholdDays(
  contact: ContactInfo,
  defaultDays: number,
): number {
  const days = getNumberField(contact, "followupThresholdDays");
  if (days !== null && days > 0) return days;
  return defaultDays;
}

async function resolveDisplayName(
  runtime: IAgentRuntime,
  contact: ContactInfo,
): Promise<string> {
  const explicit = getStringField(contact, "displayName");
  if (explicit) return explicit;
  const entity = await runtime.getEntityById(contact.entityId);
  return entity?.names?.[0] ?? String(contact.entityId);
}

/**
 * One tick of the tracker. Pure async fn — safe to call from tests.
 */
export async function computeOverdueFollowups(
  runtime: IAgentRuntime,
  now: number = Date.now(),
  defaultThresholdDays: number = FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
): Promise<OverdueDigest> {
  const service = getRelationshipsServiceLike(runtime);
  if (!service) {
    if (!degradedLogged) {
      degradedLogged = true;
      logger.info(
        "[FollowupTracker] RelationshipsService unavailable; follow-up tracking is disabled until contacts exist",
      );
    }
    return {
      generatedAt: new Date(now).toISOString(),
      thresholdDefaultDays: defaultThresholdDays,
      overdue: [],
    };
  }

  const contacts = await service.searchContacts({});
  const overdue: OverdueFollowup[] = [];

  for (const contact of contacts) {
    const lastMs = resolveLastContactedAtMs(contact);
    if (lastMs === null) continue;

    const thresholdDays = resolveThresholdDays(contact, defaultThresholdDays);
    const thresholdMs = thresholdDays * DAY_MS;
    const ageMs = now - lastMs;
    if (ageMs <= thresholdMs) continue;

    const displayName = await resolveDisplayName(runtime, contact);
    overdue.push({
      entityId: contact.entityId,
      displayName,
      lastContactedAt: new Date(lastMs).toISOString(),
      daysOverdue: Math.floor((ageMs - thresholdMs) / DAY_MS),
      thresholdDays,
    });
  }

  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);

  return {
    generatedAt: new Date(now).toISOString(),
    thresholdDefaultDays: defaultThresholdDays,
    overdue,
  };
}

function followupDigestRoomId(agentId: UUID): UUID {
  return stringToUuid(`followup-tracker-${agentId}`);
}

function followupDigestWorldId(agentId: UUID): UUID {
  return stringToUuid(`followup-tracker-world-${agentId}`);
}

/**
 * Persist the digest as a memory so morning check-in + actions can retrieve
 * it. One memory per tick; callers querying the most recent
 * `followup_overdue_digest` memory in the followup room get the latest view.
 */
export async function writeOverdueDigestMemory(
  runtime: IAgentRuntime,
  digest: OverdueDigest,
): Promise<UUID> {
  const worldId = followupDigestWorldId(runtime.agentId);
  const roomId = followupDigestRoomId(runtime.agentId);

  if (typeof runtime.ensureWorldExists === "function") {
    await runtime.ensureWorldExists({
      id: worldId,
      name: "Follow-up Tracker",
      agentId: runtime.agentId,
    } as Parameters<typeof runtime.ensureWorldExists>[0]);
  }
  if (typeof runtime.ensureRoomExists === "function") {
    await runtime.ensureRoomExists({
      id: roomId,
      name: "Follow-up Tracker",
      source: "followup-tracker",
      type: "API",
      channelId: `followup-tracker-${runtime.agentId}`,
      worldId,
    } as Parameters<typeof runtime.ensureRoomExists>[0]);
  }

  const memory: Memory = {
    id: createUniqueUuid(runtime, `followup-digest-${Date.now()}`),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId,
    worldId,
    content: {
      text:
        digest.overdue.length === 0
          ? "No overdue follow-ups."
          : `Overdue follow-ups (${digest.overdue.length}): ${digest.overdue
              .map((o) => `${o.displayName} (+${o.daysOverdue}d)`)
              .join(", ")}`,
      type: "followup_overdue_digest",
    },
    metadata: {
      type: MemoryType.CUSTOM,
      source: "followup-tracker",
      generatedAt: digest.generatedAt,
      thresholdDefaultDays: digest.thresholdDefaultDays,
      overdue: digest.overdue.map((entry) => ({
        entityId: String(entry.entityId),
        displayName: entry.displayName,
        lastContactedAt: entry.lastContactedAt,
        daysOverdue: entry.daysOverdue,
        thresholdDays: entry.thresholdDays,
      })),
    },
    createdAt: Date.now(),
  };

  const memoryId = await runtime.createMemory(memory, FOLLOWUP_MEMORY_TABLE);
  logger.info(
    `[FollowupTracker] Wrote overdue digest memory ${memoryId} with ${digest.overdue.length} entries`,
  );
  return memoryId;
}

/**
 * One reconciler tick. Compute + persist. Returns the digest for testability.
 */
export async function reconcileFollowupsOnce(
  runtime: IAgentRuntime,
  now: number = Date.now(),
  defaultThresholdDays: number = FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
): Promise<OverdueDigest> {
  const digest = await computeOverdueFollowups(
    runtime,
    now,
    defaultThresholdDays,
  );
  await writeOverdueDigestMemory(runtime, digest);

  // Route each overdue contact through the shared LLM planner. Sensitive
  // actions are enqueued into the approval queue; the tracker never auto-sends.
  for (const entry of digest.overdue) {
    const plannerContext: BackgroundJobContext = {
      jobKind: "followup_watchdog",
      subjectUserId: String(entry.entityId),
      snapshot: {
        entityId: String(entry.entityId),
        displayName: entry.displayName,
        lastContactedAt: entry.lastContactedAt,
        daysOverdue: entry.daysOverdue,
        thresholdDays: entry.thresholdDays,
        generatedAt: digest.generatedAt,
      },
      availableChannels: ["telegram", "imessage", "sms", "email", "internal"],
      trigger: `followup_watchdog:${entry.daysOverdue}d_overdue`,
    };
    try {
      const plan = await planJob(runtime, plannerContext);
      await enqueueIfSensitive(runtime, plannerContext, plan);
    } catch (error) {
      if (error instanceof BackgroundPlannerError) {
        logger.warn(
          `[FollowupTracker] background planner unavailable — ${error.message}`,
        );
        break;
      }
      throw error;
    }
  }

  return digest;
}

export async function executeFollowupTrackerTick(
  runtime: IAgentRuntime,
  options: Record<string, unknown> = {},
): Promise<{ nextInterval: number; digest: OverdueDigest }> {
  const defaultThresholdDays =
    typeof options.defaultThresholdDays === "number" &&
    Number.isFinite(options.defaultThresholdDays) &&
    options.defaultThresholdDays > 0
      ? options.defaultThresholdDays
      : FOLLOWUP_DEFAULT_THRESHOLD_DAYS;
  const digest = await reconcileFollowupsOnce(
    runtime,
    resolveTrackerNowMs(options),
    defaultThresholdDays,
  );
  return {
    nextInterval: FOLLOWUP_TRACKER_INTERVAL_MS,
    digest,
  };
}

type AutonomyServiceLike = {
  getAutonomousRoomId?: () => UUID;
};

export async function ensureFollowupTrackerTask(
  runtime: IAgentRuntime,
): Promise<UUID> {
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...FOLLOWUP_TRACKER_TASK_TAGS],
  });
  const existing = tasks.find(isFollowupTrackerTask);
  const metadata = buildFollowupTrackerMetadata(
    isRecord(existing?.metadata) ? existing.metadata : null,
  );
  if (existing?.id) {
    await runtime.updateTask(existing.id, {
      description: "Reconcile overdue LifeOps follow-ups",
      metadata,
    });
    return existing.id;
  }

  const autonomy = runtime.getService("AUTONOMY") as AutonomyServiceLike | null;
  const roomId =
    autonomy?.getAutonomousRoomId?.() ??
    stringToUuid(`followup-tracker-room-${runtime.agentId}`);

  return runtime.createTask({
    name: FOLLOWUP_TRACKER_TASK_NAME,
    description: "Reconcile overdue LifeOps follow-ups",
    roomId,
    tags: [...FOLLOWUP_TRACKER_TASK_TAGS],
    metadata,
    dueAt: Date.now(),
  });
}

/**
 * Register the tracker as a periodic task worker. Mirrors the
 * BlockRuleReconciler pattern so it integrates with the agent scheduler.
 */
export function registerFollowupTrackerWorker(runtime: IAgentRuntime): void {
  if (runtime.getTaskWorker(FOLLOWUP_TRACKER_TASK_NAME)) {
    return;
  }
  runtime.registerTaskWorker({
    name: FOLLOWUP_TRACKER_TASK_NAME,
    // Skip execution when LifeOps is disabled via the UI. Cycles become
    // cheap no-ops; re-enabling requires no restart.
    shouldRun: async (rt) => {
      try {
        const state = await loadLifeOpsAppState(rt as IAgentRuntime);
        return state.enabled;
      } catch (error) {
        logger.warn(
          `[followup-tracker] loadLifeOpsAppState failed; skipping follow-up tick because LifeOps toggle state is unknown: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    },
    execute: (rt, options) =>
      executeFollowupTrackerTick(rt, isRecord(options) ? options : {}),
  });
}

/**
 * Resolve the room used to store follow-up tracker memories. Exposed for
 * callers (e.g. LIST_OVERDUE_FOLLOWUPS action or morning check-in) that need
 * to query the digest.
 */
export function getFollowupTrackerRoomId(runtime: IAgentRuntime): UUID {
  return followupDigestRoomId(runtime.agentId);
}

/**
 * Test-only: reset the one-time degraded-mode log so unit tests can observe
 * the log path repeatedly.
 */
export function __resetFollowupTrackerForTests(): void {
  degradedLogged = false;
}

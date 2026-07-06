/**
 * Applies a scenario's `seed` steps to a live runtime before turns execute,
 * standing up the domain state a scenario assumes: todos, contacts, memories,
 * LifeOps task definitions/occurrences, and Gmail inbox fixtures. `applyScenarioSeedStep`
 * dispatches on the seed step's type and writes directly through the runtime's
 * stores so scenarios start from a known, deterministic world. Consumed by the
 * executor between setup and the first turn.
 */
import type { AgentRuntime, UUID } from "@elizaos/core";
import { createMessageMemory, MemoryType, stringToUuid } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { isLoopbackUrl } from "./utils.js";

type LifeOpsOccurrenceState =
  | "completed"
  | "visible"
  | "pending"
  | "expired"
  | "snoozed"
  | "skipped"
  | "muted";

type LifeOpsTaskDefinitionInput = Record<string, unknown>;

type LifeOpsTaskDefinition = LifeOpsTaskDefinitionInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type LifeOpsOccurrence = Record<string, unknown> & {
  occurrenceKey: string;
  state: LifeOpsOccurrenceState;
};

type LifeOpsScheduledTask = Record<string, unknown> & {
  taskId: string;
  kind: string;
  promptInstructions: string;
  trigger: Record<string, unknown>;
  priority: "low" | "medium" | "high";
  respectsGlobalPause: boolean;
  state: { status: string; followupCount: number };
  source: string;
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
};

type LifeOpsReminderAttempt = Record<string, unknown> & {
  id: string;
  agentId: string;
  planId: string;
  ownerType: "occurrence" | "calendar_event";
  ownerId: string;
  occurrenceId: string | null;
  channel: string;
  stepIndex: number;
  scheduledFor: string;
  attemptedAt: string | null;
  outcome: string;
  connectorRef: string | null;
  deliveryMetadata: Record<string, unknown>;
  reviewAt?: string | null;
  reviewStatus?: string | null;
};

type LifeOpsCalendarEventSeedInput = {
  id: string;
  externalId: string;
  agentId: string;
  provider: "google" | "apple_calendar";
  side: "owner" | "agent";
  calendarId: string;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string | null;
  htmlLink: string | null;
  conferenceLink: string | null;
  organizer: Record<string, unknown> | null;
  attendees: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
  connectorAccountId?: string;
  grantId?: string;
  accountEmail?: string;
};

type LifeOpsRepositoryInstance = {
  createDefinition: (definition: LifeOpsTaskDefinition) => Promise<unknown>;
  upsertOccurrence: (occurrence: LifeOpsOccurrence) => Promise<unknown>;
  upsertScheduledTask: (
    agentId: string,
    task: LifeOpsScheduledTask,
    options?: { nextFireAtIso?: string | null },
  ) => Promise<unknown>;
  listScheduledTasks: (
    agentId: string,
    filter?: Record<string, unknown>,
  ) => Promise<LifeOpsScheduledTask[]>;
  createReminderAttempt: (attempt: LifeOpsReminderAttempt) => Promise<unknown>;
  listReminderAttempts: (
    agentId: string,
    options?: Record<string, unknown>,
  ) => Promise<LifeOpsReminderAttempt[]>;
  upsertCalendarEvent: (
    event: LifeOpsCalendarEventSeedInput,
    side?: LifeOpsCalendarEventSeedInput["side"],
  ) => Promise<unknown>;
};

type LifeOpsRepositoryConstructor = {
  new (runtime: AgentRuntime): LifeOpsRepositoryInstance;
  bootstrapSchema: (runtime: AgentRuntime) => Promise<void>;
};

type LifeOpsDefaultsModule = {
  resolveDefaultWindowPolicy: (
    timeZone?: string | null,
  ) => Record<string, unknown>;
};

type LifeOpsEngineModule = {
  materializeDefinitionOccurrences: (
    definition: LifeOpsTaskDefinition,
    existingOccurrences: LifeOpsOccurrence[],
    options?: { now?: Date; lookbackDays?: number; lookaheadDays?: number },
  ) => LifeOpsOccurrence[];
};

type LifeOpsRepositoryModule = {
  createLifeOpsTaskDefinition: (
    params: LifeOpsTaskDefinitionInput,
  ) => LifeOpsTaskDefinition;
  LifeOpsRepository: LifeOpsRepositoryConstructor;
};

// Loaded lazily so this module can be built without pulling app-lifeops into the
// scenario-runner rootDir (app-lifeops is only available at runtime).
async function loadLifeOps() {
  const defaultsSpecifier = new URL(
    "../../../plugins/plugin-personal-assistant/src/lifeops/defaults.ts",
    import.meta.url,
  ).href;
  const engineSpecifier = new URL(
    "../../../plugins/plugin-personal-assistant/src/lifeops/engine.ts",
    import.meta.url,
  ).href;
  const repositorySpecifier = new URL(
    "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts",
    import.meta.url,
  ).href;
  const [
    { resolveDefaultWindowPolicy },
    { materializeDefinitionOccurrences },
    repo,
  ]: [LifeOpsDefaultsModule, LifeOpsEngineModule, LifeOpsRepositoryModule] =
    await Promise.all([
      import(defaultsSpecifier),
      import(engineSpecifier),
      import(repositorySpecifier),
    ]);
  return {
    resolveDefaultWindowPolicy,
    materializeDefinitionOccurrences,
    createLifeOpsTaskDefinition: repo.createLifeOpsTaskDefinition,
    LifeOpsRepository: repo.LifeOpsRepository,
  };
}

type TodoSeed = {
  type: "todo";
  name?: unknown;
  title?: unknown;
  description?: unknown;
  dueIso?: unknown;
  priority?: unknown;
  isUrgent?: unknown;
  state?: unknown;
};

type ContactSeedHandle = {
  platform?: unknown;
  identifier?: unknown;
  handle?: unknown;
  displayLabel?: unknown;
  isPrimary?: unknown;
  realPerson?: unknown;
};

type ContactSeed = {
  type: "contact";
  name?: unknown;
  notes?: unknown;
  categories?: unknown;
  tags?: unknown;
  handles?: unknown;
  followupThresholdDays?: unknown;
  relationshipStatus?: unknown;
  relationshipGoal?: unknown;
  lastContactedAt?: unknown;
};

type MemorySeed = {
  type: "memory";
  content?: unknown;
};

type GmailInboxSeed = {
  type: "gmailInbox";
  account?: unknown;
  fixture?: unknown;
  fixtures?: unknown;
  requiredMessageIds?: unknown;
  clearLedger?: unknown;
  faultInjection?: unknown;
};

type GmailFaultInjectionSeed = {
  mode?: unknown;
  method?: unknown;
  path?: unknown;
  endpoint?: unknown;
  limit?: unknown;
};

type GmailFaultInjectionConfig = {
  mode: "auth_expired" | "rate_limit" | "server_error" | "partial_failure";
  method: string;
  path: string;
  remaining?: number;
};

type ConnectorSeed = {
  type: "connectorStatus" | "connectorAuthSession" | "transportFault";
  connector?: unknown;
  provider?: unknown;
  state?: unknown;
  capabilities?: unknown;
  scopes?: unknown;
  limit?: unknown;
};

type UserStateMemorySeed = {
  kind?: unknown;
  type?: unknown;
  doNotDisturb?: unknown;
  dndActive?: unknown;
  isCurrentlyActive?: unknown;
  lastSeenPlatform?: unknown;
  primaryPlatform?: unknown;
  secondaryPlatform?: unknown;
  calendarBusy?: unknown;
  screenContextBusy?: unknown;
  screenContextAvailable?: unknown;
  screenContextFocus?: unknown;
  metadata?: unknown;
};

type FocusWindowMemorySeed = {
  kind?: unknown;
  type?: unknown;
  title?: unknown;
  startAt?: unknown;
  endAt?: unknown;
};

type QueuedPushMemorySeed = {
  kind?: unknown;
  type?: unknown;
  title?: unknown;
  urgency?: unknown;
  channel?: unknown;
  dueAt?: unknown;
};

type DeviceIntentMemorySeed = {
  kind?: unknown;
  type?: unknown;
  id?: unknown;
  title?: unknown;
  body?: unknown;
  priority?: unknown;
  dispatchedTo?: unknown;
  actionUrl?: unknown;
  expiresAt?: unknown;
};

type ReminderAttemptMemorySeed = {
  kind?: unknown;
  type?: unknown;
  id?: unknown;
  title?: unknown;
  channel?: unknown;
  sentAt?: unknown;
  readAt?: unknown;
  attemptedAt?: unknown;
  scheduledFor?: unknown;
  priority?: unknown;
  urgency?: unknown;
  result?: unknown;
  statusCode?: unknown;
  topic?: unknown;
};

type LadderStateMemorySeed = {
  kind?: unknown;
  type?: unknown;
  history?: unknown;
  urgency?: unknown;
};

type LadderHistoryEntry = {
  channel?: unknown;
  at?: unknown;
  ackedAt?: unknown;
};

type MemoryContactSeed = {
  kind?: unknown;
  type?: unknown;
  name?: unknown;
  displayName?: unknown;
  id?: unknown;
  notes?: unknown;
  company?: unknown;
  handles?: unknown;
  platform?: unknown;
  handle?: unknown;
  oldHandle?: unknown;
  newHandle?: unknown;
  platformUserId?: unknown;
  tags?: unknown;
  primaryChannel?: unknown;
  telegramHandle?: unknown;
  recentNews?: unknown;
  renameConfirmed?: unknown;
  mergedAccidentally?: unknown;
  relationshipGoal?: unknown;
  followupThresholdDays?: unknown;
  lastContactedAt?: unknown;
  relationshipStatus?: unknown;
};

const PROACTIVE_TASK_NAME = "PROACTIVE_AGENT";
const PROACTIVE_TASK_TAGS = ["queue", "repeat", "proactive"];

const TRAVEL_FACT_MEMORY_KINDS = new Set([
  "profile",
  "trip",
  "booking",
  "upgrade-offer",
  "calendar-focus-window",
]);

type CalendarEventMemorySeed = MemoryContactSeed & {
  externalId?: unknown;
  calendarId?: unknown;
  provider?: unknown;
  side?: unknown;
  title?: unknown;
  description?: unknown;
  location?: unknown;
  status?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  durationMinutes?: unknown;
  isAllDay?: unknown;
  timezone?: unknown;
  timeZone?: unknown;
  htmlLink?: unknown;
  url?: unknown;
  conferenceLink?: unknown;
  joinLink?: unknown;
  organizer?: unknown;
  attendees?: unknown;
  metadata?: unknown;
  connectorAccountId?: unknown;
  grantId?: unknown;
  accountEmail?: unknown;
  cancelled?: unknown;
  canceled?: unknown;
  cancelledAt?: unknown;
  canceledAt?: unknown;
};

type InboundMessageMemorySeed = MemoryContactSeed & {
  from?: unknown;
  relationship?: unknown;
  priority?: unknown;
  text?: unknown;
  source?: unknown;
  messageId?: unknown;
  occurredAt?: unknown;
  threadId?: unknown;
  url?: unknown;
};

type ConnectorStatusLike = {
  state: "ok" | "degraded" | "disconnected";
  message?: string;
  observedAt: string;
};

type DispatchResultLike =
  | { ok: true; messageId?: string }
  | {
      ok: false;
      reason:
        | "disconnected"
        | "rate_limited"
        | "auth_expired"
        | "unknown_recipient"
        | "transport_error";
      retryAfterMinutes?: number;
      userActionable: boolean;
      message?: string;
    };

type ConnectorModeLike = "local" | "cloud";

type ConnectorRegistryFilterLike = {
  capability?: string;
  mode?: ConnectorModeLike;
};

type ConnectorContributionLike = {
  kind: string;
  capabilities: string[];
  modes: ConnectorModeLike[];
  describe: { label: string };
  start: () => Promise<void>;
  disconnect: () => Promise<void>;
  verify: () => Promise<boolean>;
  status: () => Promise<ConnectorStatusLike>;
  send?: (payload: unknown) => Promise<DispatchResultLike>;
  read?: (query: unknown) => Promise<unknown>;
  requiresApproval?: boolean;
  oauth?: unknown;
  apiBaseUrl?: string;
};

type ConnectorRegistryLike = {
  register: (contribution: ConnectorContributionLike) => void;
  list: (filter?: ConnectorRegistryFilterLike) => ConnectorContributionLike[];
  get: (kind: string) => ConnectorContributionLike | null;
  byCapability: (capability: string) => ConnectorContributionLike[];
};

type ConnectorRegistryModule = {
  createConnectorRegistry: () => ConnectorRegistryLike;
  getConnectorRegistry: (runtime: AgentRuntime) => ConnectorRegistryLike | null;
  registerConnectorRegistry: (
    runtime: AgentRuntime,
    registry: ConnectorRegistryLike,
  ) => void;
};

async function loadConnectorRegistry(): Promise<ConnectorRegistryModule> {
  const specifier = new URL(
    "../../../plugins/plugin-personal-assistant/src/lifeops/connectors/registry.ts",
    import.meta.url,
  ).href;
  return import(specifier) as Promise<ConnectorRegistryModule>;
}

type RelationshipsServiceLike = {
  getContact: (entityId: UUID) => Promise<unknown>;
  addContact: (
    entityId: UUID,
    categories?: string[],
    preferences?: Record<string, unknown>,
    customFields?: Record<string, unknown>,
  ) => Promise<unknown>;
  updateContact: (
    entityId: UUID,
    updates: Record<string, unknown>,
  ) => Promise<unknown>;
  addHandle?: (
    entityId: UUID,
    handle: {
      platform: string;
      identifier: string;
      displayLabel?: string;
      isPrimary?: boolean;
    },
  ) => Promise<unknown>;
  recordInteraction?: (input: {
    contactId: UUID;
    platform: string;
    direction: "inbound" | "outbound";
    occurredAt?: string;
    summary?: string;
  }) => Promise<unknown>;
  setRelationshipGoal?: (
    contactId: UUID,
    goal: { goalText: string; targetCadenceDays?: number },
  ) => Promise<unknown>;
};

function requireRuntime(ctx: ScenarioContext): AgentRuntime {
  const runtime = ctx.runtime as AgentRuntime | undefined;
  if (!runtime) {
    throw new Error("scenario runtime unavailable during seed");
  }
  return runtime;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readNonEmptyString(entry))
    .filter((entry): entry is string => entry !== null);
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readIsoDate(value: unknown): Date | null {
  const text = readNonEmptyString(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readScenarioNow(ctx: ScenarioContext): Date {
  return typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
    ? new Date(ctx.now)
    : new Date();
}

function normalizeTodoTitle(seed: TodoSeed): string {
  return (
    readNonEmptyString(seed.name) ?? readNonEmptyString(seed.title) ?? "Todo"
  );
}

function normalizeTodoDueIso(seed: TodoSeed, ctx: ScenarioContext): string {
  const explicitDue = readNonEmptyString(seed.dueIso);
  if (explicitDue) {
    return explicitDue;
  }
  return new Date(readScenarioNow(ctx).getTime() + 60 * 60_000).toISOString();
}

async function seedTodo(
  ctx: ScenarioContext,
  seed: TodoSeed,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const {
    resolveDefaultWindowPolicy,
    materializeDefinitionOccurrences,
    createLifeOpsTaskDefinition,
    LifeOpsRepository,
  } = await loadLifeOps();
  await LifeOpsRepository.bootstrapSchema(runtime);

  const title = normalizeTodoTitle(seed);
  const dueAt = normalizeTodoDueIso(seed, ctx);
  const priority =
    readOptionalNumber(seed.priority) ??
    (readOptionalBoolean(seed.isUrgent) ? 5 : 3);
  const repository = new LifeOpsRepository(runtime);
  const definition = createLifeOpsTaskDefinition({
    agentId: String(runtime.agentId),
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: String(runtime.agentId),
    visibilityScope: "owner_only",
    contextPolicy: "allowed_in_private_chat",
    kind: "task",
    title,
    description: readNonEmptyString(seed.description) ?? "",
    originalIntent: title,
    timezone: "America/Los_Angeles",
    status: "active",
    priority,
    cadence: {
      kind: "once",
      dueAt,
    },
    windowPolicy: resolveDefaultWindowPolicy("America/Los_Angeles"),
    progressionRule: { kind: "none" },
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "scenario-seed",
    metadata: {},
  });
  await repository.createDefinition(definition);
  const materialized = materializeDefinitionOccurrences(definition, [], {
    now: readScenarioNow(ctx),
  });
  const requestedState = readNonEmptyString(seed.state);
  for (const occurrence of materialized) {
    await repository.upsertOccurrence({
      ...occurrence,
      state:
        requestedState === "completed" ||
        requestedState === "visible" ||
        requestedState === "pending" ||
        requestedState === "expired" ||
        requestedState === "snoozed" ||
        requestedState === "skipped" ||
        requestedState === "muted"
          ? requestedState
          : occurrence.state,
    });
  }
  return undefined;
}

type NormalizedContactHandle = {
  platform: string;
  identifier: string;
  displayLabel?: string;
  isPrimary?: boolean;
};

function normalizeContactHandles(value: unknown): NormalizedContactHandle[] {
  if (!Array.isArray(value)) return [];
  const handles: NormalizedContactHandle[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const handle = entry as ContactSeedHandle;
    const platform = readNonEmptyString(handle.platform);
    const identifier =
      readNonEmptyString(handle.identifier) ??
      readNonEmptyString(handle.handle);
    if (!platform || !identifier) continue;
    handles.push({
      platform,
      identifier,
      displayLabel: readNonEmptyString(handle.displayLabel) ?? undefined,
      isPrimary: readOptionalBoolean(handle.isPrimary),
    });
  }
  return handles;
}

function dedupeContactHandles(
  handles: NormalizedContactHandle[],
): NormalizedContactHandle[] {
  const seen = new Set<string>();
  const deduped: NormalizedContactHandle[] = [];
  for (const handle of handles) {
    const key = `${handle.platform}:${handle.identifier}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(handle);
  }
  return deduped;
}

function normalizeEntityHandles(
  seed: MemoryContactSeed,
): NormalizedContactHandle[] {
  const handles = normalizeContactHandles(seed.handles);
  const displayLabel =
    readNonEmptyString(seed.displayName) ??
    readNonEmptyString(seed.name) ??
    undefined;
  const platform = readNonEmptyString(seed.platform);
  if (platform) {
    const primaryHandle = readNonEmptyString(seed.handle);
    for (const identifier of [
      primaryHandle,
      readNonEmptyString(seed.newHandle),
      readNonEmptyString(seed.oldHandle),
    ]) {
      if (!identifier) continue;
      handles.push({
        platform,
        identifier,
        displayLabel,
        isPrimary: primaryHandle ? identifier === primaryHandle : undefined,
      });
    }
  }
  const telegramHandle = readNonEmptyString(seed.telegramHandle);
  if (telegramHandle) {
    handles.push({
      platform: readNonEmptyString(seed.primaryChannel) ?? "telegram",
      identifier: telegramHandle,
      displayLabel,
      isPrimary: true,
    });
  }
  return dedupeContactHandles(handles);
}

function entityMemoryNotes(seed: MemoryContactSeed): string | undefined {
  const notes: string[] = [];
  const authoredNotes = readNonEmptyString(seed.notes);
  if (authoredNotes) notes.push(authoredNotes);
  const scenarioEntityId = readNonEmptyString(seed.id);
  if (scenarioEntityId) notes.push(`Scenario entity id: ${scenarioEntityId}`);
  const company = readNonEmptyString(seed.company);
  if (company) notes.push(`Company: ${company}`);
  const recentNews = readNonEmptyString(seed.recentNews);
  if (recentNews) notes.push(`Recent news: ${recentNews}`);
  const platformUserId = readNonEmptyString(seed.platformUserId);
  if (platformUserId) notes.push(`Platform user ID: ${platformUserId}`);
  const oldHandle = readNonEmptyString(seed.oldHandle);
  const newHandle = readNonEmptyString(seed.newHandle);
  if (oldHandle || newHandle) {
    notes.push(
      `Handle rename: ${oldHandle ?? "(unknown)"} -> ${newHandle ?? "(unknown)"}`,
    );
  }
  const renameConfirmed = readOptionalBoolean(seed.renameConfirmed);
  if (renameConfirmed !== undefined) {
    notes.push(`Rename confirmed: ${renameConfirmed}`);
  }
  const mergedAccidentally = readOptionalBoolean(seed.mergedAccidentally);
  if (mergedAccidentally !== undefined) {
    notes.push(`Merged accidentally: ${mergedAccidentally}`);
  }
  if (Array.isArray(seed.handles)) {
    for (const entry of seed.handles) {
      if (!entry || typeof entry !== "object") continue;
      const handle = entry as ContactSeedHandle;
      const platform = readNonEmptyString(handle.platform);
      const identifier =
        readNonEmptyString(handle.identifier) ??
        readNonEmptyString(handle.handle);
      const realPerson = readNonEmptyString(handle.realPerson);
      if (platform && identifier && realPerson) {
        notes.push(`${platform} ${identifier} real person: ${realPerson}`);
      }
    }
  }
  return notes.length > 0 ? notes.join("\n") : undefined;
}

function memoryEntityToContactSeed(
  seed: MemoryContactSeed,
  memoryType: string,
): ContactSeed {
  const handles = normalizeEntityHandles(seed);
  const authoredTags = readStringArray(seed.tags);
  const isMerged = memoryType === "merged-entity";
  return {
    type: "contact",
    name:
      readNonEmptyString(seed.displayName) ??
      readNonEmptyString(seed.name) ??
      readNonEmptyString(seed.handle) ??
      readNonEmptyString(seed.telegramHandle) ??
      handles[0]?.identifier ??
      (isMerged ? "Merged entity" : "Rolodex entity"),
    notes: entityMemoryNotes(seed),
    categories: isMerged ? ["merged-entity"] : undefined,
    tags:
      authoredTags.length > 0
        ? authoredTags
        : isMerged
          ? ["merged-entity"]
          : undefined,
    handles,
    relationshipGoal: seed.relationshipGoal,
    followupThresholdDays: seed.followupThresholdDays,
    lastContactedAt: seed.lastContactedAt,
    relationshipStatus: seed.relationshipStatus,
  };
}

function normalizeRelationshipStatus(
  value: unknown,
): "active" | "dormant" | "archived" | "blocked" | "unknown" | undefined {
  const status = readNonEmptyString(value);
  if (
    status === "active" ||
    status === "dormant" ||
    status === "archived" ||
    status === "blocked" ||
    status === "unknown"
  ) {
    return status;
  }
  return undefined;
}

async function requireRelationshipsService(
  runtime: AgentRuntime,
): Promise<RelationshipsServiceLike> {
  const service = runtime.getService(
    "relationships",
  ) as RelationshipsServiceLike | null;
  if (!service) {
    throw new Error("relationships service not available for scenario seed");
  }
  return service;
}

function buildContactEntityId(runtime: AgentRuntime, name: string): UUID {
  return stringToUuid(`scenario-contact-${name}-${runtime.agentId}`) as UUID;
}

function normalizeScreenContextFocus(
  value: unknown,
): "work" | "leisure" | "transition" | "idle" | "unknown" | null {
  const focus = readNonEmptyString(value);
  if (
    focus === "work" ||
    focus === "leisure" ||
    focus === "transition" ||
    focus === "idle" ||
    focus === "unknown"
  ) {
    return focus;
  }
  return null;
}

function normalizeScheduledTaskPriority(
  value: unknown,
): "low" | "medium" | "high" {
  const text = readNonEmptyString(value);
  if (text === "low" || text === "medium" || text === "high") {
    return text;
  }
  if (text === "urgent") return "high";
  return "medium";
}

function normalizeIntentPriority(
  value: unknown,
): "low" | "medium" | "high" | "urgent" {
  const text = readNonEmptyString(value);
  if (
    text === "low" ||
    text === "medium" ||
    text === "high" ||
    text === "urgent"
  ) {
    return text;
  }
  return "medium";
}

function existingActivityProfile(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.ownerEntityId === "string" &&
    typeof record.analyzedAt === "number" &&
    typeof record.totalMessages === "number"
    ? record
    : null;
}

function seededActivityProfile(
  ctx: ScenarioContext,
  runtime: AgentRuntime,
  seed: UserStateMemorySeed,
  previous: Record<string, unknown> | null,
): Record<string, unknown> {
  const now = readScenarioNow(ctx);
  const nowMs = now.getTime();
  const primaryPlatform =
    readNonEmptyString(seed.primaryPlatform) ??
    readNonEmptyString(seed.lastSeenPlatform) ??
    (typeof previous?.primaryPlatform === "string"
      ? previous.primaryPlatform
      : "mobile");
  const lastSeenPlatform =
    readNonEmptyString(seed.lastSeenPlatform) ??
    (typeof previous?.lastSeenPlatform === "string"
      ? previous.lastSeenPlatform
      : primaryPlatform);
  const active =
    readOptionalBoolean(seed.isCurrentlyActive) ??
    (typeof previous?.isCurrentlyActive === "boolean"
      ? previous.isCurrentlyActive
      : true);
  const screenContextAvailable =
    readOptionalBoolean(seed.screenContextAvailable) ??
    (typeof previous?.screenContextAvailable === "boolean"
      ? previous.screenContextAvailable
      : false);
  const screenContextFocus =
    normalizeScreenContextFocus(seed.screenContextFocus) ??
    (typeof previous?.screenContextFocus === "string"
      ? normalizeScreenContextFocus(previous.screenContextFocus)
      : null);
  return {
    ownerEntityId:
      readNonEmptyString(ctx.primaryUserId) ?? String(runtime.agentId),
    analyzedAt: nowMs,
    analysisWindowDays:
      typeof previous?.analysisWindowDays === "number"
        ? previous.analysisWindowDays
        : 14,
    timezone:
      typeof previous?.timezone === "string" ? previous.timezone : "UTC",
    totalMessages:
      typeof previous?.totalMessages === "number" ? previous.totalMessages : 0,
    sustainedInactivityThresholdMinutes:
      typeof previous?.sustainedInactivityThresholdMinutes === "number"
        ? previous.sustainedInactivityThresholdMinutes
        : 60,
    platforms: Array.isArray(previous?.platforms) ? previous.platforms : [],
    primaryPlatform,
    secondaryPlatform:
      readNonEmptyString(seed.secondaryPlatform) ??
      (typeof previous?.secondaryPlatform === "string"
        ? previous.secondaryPlatform
        : null),
    bucketCounts:
      previous?.bucketCounts && typeof previous.bucketCounts === "object"
        ? previous.bucketCounts
        : {
            EARLY_MORNING: 0,
            MORNING: 0,
            MIDDAY: 0,
            AFTERNOON: 0,
            EVENING: 0,
            NIGHT: 0,
            LATE_NIGHT: 0,
          },
    hasCalendarData:
      readOptionalBoolean(seed.calendarBusy) !== undefined ||
      (typeof previous?.hasCalendarData === "boolean"
        ? previous.hasCalendarData
        : false),
    calendarBusy:
      readOptionalBoolean(seed.calendarBusy) ?? previous?.calendarBusy,
    typicalFirstEventHour: previous?.typicalFirstEventHour ?? null,
    typicalLastEventHour: previous?.typicalLastEventHour ?? null,
    avgWeekdayMeetings:
      typeof previous?.avgWeekdayMeetings === "number"
        ? previous.avgWeekdayMeetings
        : null,
    typicalFirstActiveHour: previous?.typicalFirstActiveHour ?? null,
    typicalLastActiveHour: previous?.typicalLastActiveHour ?? null,
    typicalWakeHour: previous?.typicalWakeHour ?? null,
    typicalSleepHour: previous?.typicalSleepHour ?? null,
    hasSleepData:
      typeof previous?.hasSleepData === "boolean"
        ? previous.hasSleepData
        : false,
    isCurrentlySleeping:
      typeof previous?.isCurrentlySleeping === "boolean"
        ? previous.isCurrentlySleeping
        : false,
    lastSleepSignalAt: previous?.lastSleepSignalAt ?? null,
    lastWakeSignalAt: previous?.lastWakeSignalAt ?? null,
    sleepSourcePlatform: previous?.sleepSourcePlatform ?? null,
    sleepSource: previous?.sleepSource ?? null,
    typicalSleepDurationMinutes: previous?.typicalSleepDurationMinutes ?? null,
    lastSeenAt:
      typeof previous?.lastSeenAt === "number" ? previous.lastSeenAt : nowMs,
    lastSeenPlatform,
    isCurrentlyActive: active,
    hasOpenActivityCycle:
      typeof previous?.hasOpenActivityCycle === "boolean"
        ? previous.hasOpenActivityCycle
        : active,
    currentActivityCycleStartedAt:
      typeof previous?.currentActivityCycleStartedAt === "number"
        ? previous.currentActivityCycleStartedAt
        : active
          ? nowMs
          : null,
    currentActivityCycleLocalDate:
      typeof previous?.currentActivityCycleLocalDate === "string"
        ? previous.currentActivityCycleLocalDate
        : now.toISOString().slice(0, 10),
    effectiveDayKey:
      typeof previous?.effectiveDayKey === "string"
        ? previous.effectiveDayKey
        : now.toISOString().slice(0, 10),
    screenContextFocus,
    screenContextSource: previous?.screenContextSource ?? null,
    screenContextSampledAt:
      typeof previous?.screenContextSampledAt === "number"
        ? previous.screenContextSampledAt
        : screenContextAvailable
          ? nowMs
          : null,
    screenContextConfidence:
      typeof previous?.screenContextConfidence === "number"
        ? previous.screenContextConfidence
        : screenContextAvailable
          ? 0.8
          : null,
    screenContextBusy:
      readOptionalBoolean(seed.screenContextBusy) ??
      (typeof previous?.screenContextBusy === "boolean"
        ? previous.screenContextBusy
        : false),
    screenContextAvailable,
    screenContextStale:
      typeof previous?.screenContextStale === "boolean"
        ? previous.screenContextStale
        : false,
    dndActive:
      readOptionalBoolean(seed.dndActive) ??
      readOptionalBoolean(seed.doNotDisturb) ??
      previous?.dndActive === true,
    metadata: {
      ...(previous?.metadata &&
      typeof previous.metadata === "object" &&
      !Array.isArray(previous.metadata)
        ? (previous.metadata as Record<string, unknown>)
        : {}),
      ...(seed.metadata &&
      typeof seed.metadata === "object" &&
      !Array.isArray(seed.metadata)
        ? (seed.metadata as Record<string, unknown>)
        : {}),
      source: "scenario-seed",
      ...(ctx.scenarioId ? { scenarioId: ctx.scenarioId } : {}),
    },
  };
}

async function seedUserStateMemory(
  ctx: ScenarioContext,
  seed: UserStateMemorySeed,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const tasks = await runtime.getTasks({ tags: PROACTIVE_TASK_TAGS });
  const existingTask = tasks.find((task) => task.name === PROACTIVE_TASK_NAME);
  const metadata =
    existingTask?.metadata &&
    typeof existingTask.metadata === "object" &&
    !Array.isArray(existingTask.metadata)
      ? existingTask.metadata
      : {};
  const previous = existingActivityProfile(metadata.activityProfile);
  const activityProfile = seededActivityProfile(ctx, runtime, seed, previous);
  const nextMetadata = {
    ...metadata,
    proactiveAgent:
      metadata.proactiveAgent &&
      typeof metadata.proactiveAgent === "object" &&
      !Array.isArray(metadata.proactiveAgent)
        ? metadata.proactiveAgent
        : { kind: "runtime_runner" },
    activityProfile,
  };
  if (existingTask?.id) {
    await runtime.updateTask(existingTask.id, { metadata: nextMetadata });
    return undefined;
  }
  await runtime.createTask({
    id: stringToUuid(`scenario-user-state:${ctx.scenarioId ?? "unknown"}`),
    name: PROACTIVE_TASK_NAME,
    agentId: runtime.agentId,
    tags: PROACTIVE_TASK_TAGS,
    metadata: nextMetadata,
  });
  return undefined;
}

function focusWindowToUserStateSeed(
  ctx: ScenarioContext,
  seed: FocusWindowMemorySeed,
): UserStateMemorySeed | string {
  const startAt = readIsoDate(seed.startAt);
  const endAt = readIsoDate(seed.endAt);
  if (!startAt || !endAt) {
    return "focus-window-active seed requires valid ISO startAt/endAt";
  }
  if (endAt.getTime() <= startAt.getTime()) {
    return "focus-window-active seed endAt must be after startAt";
  }
  const now = readScenarioNow(ctx);
  if (now.getTime() < startAt.getTime() || now.getTime() >= endAt.getTime()) {
    return "focus-window-active seed window must contain ctx.now";
  }
  return {
    kind: "user-state",
    isCurrentlyActive: true,
    lastSeenPlatform: "desktop",
    primaryPlatform: "desktop",
    screenContextBusy: true,
    screenContextAvailable: true,
    screenContextFocus: "work",
    dndActive: false,
    metadata: {
      focusWindow: {
        title: readNonEmptyString(seed.title) ?? "Focus window",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      },
    },
  };
}

async function seedQueuedPushMemory(
  ctx: ScenarioContext,
  seed: QueuedPushMemorySeed,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const title = readNonEmptyString(seed.title);
  if (!title) {
    return "queued-push seed requires a title";
  }
  const dueAt = readIsoDate(seed.dueAt) ?? readScenarioNow(ctx);
  const { LifeOpsRepository } = await loadLifeOps();
  await LifeOpsRepository.bootstrapSchema(runtime);
  const repository = new LifeOpsRepository(runtime);
  const channel = readNonEmptyString(seed.channel) ?? "push";
  const urgency = readNonEmptyString(seed.urgency) ?? "medium";
  const taskId = `scenario-queued-push:${ctx.scenarioId ?? "unknown"}:${title}`;
  await repository.upsertScheduledTask(
    String(runtime.agentId),
    {
      taskId,
      kind: "reminder",
      promptInstructions: `Queued push: ${title}`,
      trigger: { kind: "once", atIso: dueAt.toISOString() },
      priority: normalizeScheduledTaskPriority(urgency),
      respectsGlobalPause: true,
      state: { status: "scheduled", followupCount: 0 },
      source: "user_chat",
      createdBy: String(runtime.agentId),
      ownerVisible: true,
      metadata: {
        source: "scenario-seed",
        scenarioId: ctx.scenarioId ?? null,
        push: {
          title,
          urgency,
          channel,
        },
      },
    },
    { nextFireAtIso: dueAt.toISOString() },
  );
  return undefined;
}

function normalizeDeviceIntentTargets(value: unknown): string[] {
  const targets = readStringArray(value);
  return targets.length > 0 ? targets : ["all"];
}

function deviceIntentTarget(device: string): {
  target: "all" | "desktop" | "mobile" | "specific";
  targetDeviceId: string | null;
} {
  if (device === "all") return { target: "all", targetDeviceId: null };
  if (device === "desktop") return { target: "desktop", targetDeviceId: null };
  if (device === "mobile" || device === "phone") {
    return { target: "mobile", targetDeviceId: null };
  }
  return { target: "specific", targetDeviceId: device };
}

async function seedDeviceIntentMemory(
  ctx: ScenarioContext,
  seed: DeviceIntentMemorySeed,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const title = readNonEmptyString(seed.title);
  if (!title) {
    return "device-intent seed requires a title";
  }
  const intentGroupId =
    readNonEmptyString(seed.id) ??
    `scenario-device-intent:${ctx.scenarioId ?? "unknown"}:${title}`;
  const createdAt = readScenarioNow(ctx).toISOString();
  const expiresAt = readIsoDate(seed.expiresAt)?.toISOString() ?? null;
  const body = readNonEmptyString(seed.body) ?? title;
  const actionUrl = readNonEmptyString(seed.actionUrl);
  const priority = normalizeIntentPriority(seed.priority);
  const dispatchedTo = normalizeDeviceIntentTargets(seed.dispatchedTo);
  const { LifeOpsRepository } = await loadLifeOps();
  await LifeOpsRepository.bootstrapSchema(runtime);
  const { executeRawSql, sqlText } = (await import(
    new URL(
      "../../../plugins/plugin-personal-assistant/src/lifeops/sql.ts",
      import.meta.url,
    ).href
  )) as {
    executeRawSql: (
      runtime: AgentRuntime,
      sql: string,
    ) => Promise<Record<string, unknown>[]>;
    sqlText: (value: unknown) => string;
  };
  for (const device of dispatchedTo) {
    const { target, targetDeviceId } = deviceIntentTarget(device);
    const metadata = {
      source: "scenario-seed",
      scenarioId: ctx.scenarioId ?? null,
      deviceIntentId: intentGroupId,
      syncGroupId: intentGroupId,
      dispatchedTo,
      device,
    };
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_intents (
        id, agent_id, kind, target, target_device_id,
        title, body, action_url, priority,
        created_at, expires_at, acknowledged_at, acknowledged_by, metadata_json
      ) VALUES (
        ${sqlText(`${intentGroupId}:${device}`)},
        ${sqlText(runtime.agentId)},
        ${sqlText("attention_request")},
        ${sqlText(target)},
        ${sqlText(targetDeviceId)},
        ${sqlText(title)},
        ${sqlText(body)},
        ${sqlText(actionUrl)},
        ${sqlText(priority)},
        ${sqlText(createdAt)},
        ${sqlText(expiresAt)},
        NULL,
        NULL,
        ${sqlText(JSON.stringify(metadata))}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = excluded.title,
        body = excluded.body,
        action_url = excluded.action_url,
        priority = excluded.priority,
        expires_at = excluded.expires_at,
        metadata_json = excluded.metadata_json,
        acknowledged_at = NULL,
        acknowledged_by = NULL`,
    );
  }
  return undefined;
}

function normalizeReminderAttemptChannel(value: unknown): string {
  const channel = readNonEmptyString(value)?.toLowerCase();
  if (
    channel === "desktop" ||
    channel === "mobile" ||
    channel === "sms" ||
    channel === "voice" ||
    channel === "phone_call" ||
    channel === "ntfy" ||
    channel === "in_app"
  ) {
    return channel === "phone_call" ? "voice" : channel;
  }
  return "in_app";
}

function normalizeReminderAttemptOutcome(
  seed: ReminderAttemptMemorySeed,
): string {
  const result = readNonEmptyString(seed.result)?.toLowerCase();
  if (result === "failed" || result === "blocked") {
    return "blocked_connector";
  }
  if (readNonEmptyString(seed.readAt)) {
    return "delivered_read";
  }
  if ("readAt" in seed && seed.readAt === null) {
    return "delivered_unread";
  }
  return "delivered";
}

async function seedReminderAttemptMemory(
  ctx: ScenarioContext,
  seed: ReminderAttemptMemorySeed,
  index = 0,
  planIdOverride?: string,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const channel = normalizeReminderAttemptChannel(seed.channel);
  const attemptedAt =
    readIsoDate(seed.attemptedAt) ??
    readIsoDate(seed.sentAt) ??
    readScenarioNow(ctx);
  const scheduledFor = (
    readIsoDate(seed.scheduledFor) ?? attemptedAt
  ).toISOString();
  const title =
    readNonEmptyString(seed.title) ??
    (channel === "ntfy" ? "ntfy push" : "Scenario push attempt");
  const planId =
    planIdOverride ??
    `scenario-reminder-plan:${ctx.scenarioId ?? "unknown"}:${title}`;
  const outcome = normalizeReminderAttemptOutcome(seed);
  const urgency =
    readNonEmptyString(seed.urgency) ??
    readNonEmptyString(seed.priority) ??
    "medium";
  const reviewAt =
    outcome === "delivered_unread" || outcome === "delivered"
      ? readScenarioNow(ctx).toISOString()
      : null;
  const { LifeOpsRepository } = await loadLifeOps();
  await LifeOpsRepository.bootstrapSchema(runtime);
  const repository = new LifeOpsRepository(runtime);
  await repository.createReminderAttempt({
    id:
      readNonEmptyString(seed.id) ??
      `${planId}:attempt:${index}:${channel}:${attemptedAt.toISOString()}`,
    agentId: String(runtime.agentId),
    planId,
    ownerType: "occurrence",
    ownerId: planId,
    occurrenceId: null,
    channel,
    stepIndex: index,
    scheduledFor,
    attemptedAt: attemptedAt.toISOString(),
    outcome,
    connectorRef: readNonEmptyString(seed.topic)
      ? `${channel}:${readNonEmptyString(seed.topic)}`
      : null,
    deliveryMetadata: {
      source: "scenario-seed",
      scenarioId: ctx.scenarioId ?? null,
      title,
      urgency,
      priority: readNonEmptyString(seed.priority) ?? urgency,
      readAt: readNonEmptyString(seed.readAt),
      statusCode: readOptionalNumber(seed.statusCode),
      result: readNonEmptyString(seed.result),
      topic: readNonEmptyString(seed.topic),
    },
    reviewAt,
    reviewStatus: reviewAt ? "no_response" : null,
  });
  return undefined;
}

async function seedLadderStateMemory(
  ctx: ScenarioContext,
  seed: LadderStateMemorySeed,
): Promise<string | undefined> {
  if (!Array.isArray(seed.history) || seed.history.length === 0) {
    return "ladder-state seed requires a non-empty history array";
  }
  const planId = `scenario-ladder:${ctx.scenarioId ?? "unknown"}`;
  for (const [index, entry] of seed.history.entries()) {
    const record =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as LadderHistoryEntry)
        : null;
    if (!record) {
      return "ladder-state history entries must be objects";
    }
    const result = await seedReminderAttemptMemory(
      ctx,
      {
        kind: "push-delivery-attempt",
        title: `Ladder rung ${index + 1}`,
        channel: record.channel,
        attemptedAt: record.at,
        readAt: record.ackedAt ?? null,
        urgency: seed.urgency,
      },
      index,
      planId,
    );
    if (typeof result === "string") return result;
  }
  return undefined;
}

function normalizeCalendarProvider(
  value: unknown,
): LifeOpsCalendarEventSeedInput["provider"] | null {
  const provider = readNonEmptyString(value);
  if (provider === "google" || provider === "apple_calendar") {
    return provider;
  }
  return provider ? null : "google";
}

function normalizeCalendarSide(
  value: unknown,
): LifeOpsCalendarEventSeedInput["side"] | null {
  const side = readNonEmptyString(value);
  if (side === "owner" || side === "agent") {
    return side;
  }
  return side ? null : "owner";
}

function normalizeIsoDate(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeCalendarAttendees(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    return [entry as Record<string, unknown>];
  });
}

function calendarEventMetadata(
  ctx: ScenarioContext,
  seed: CalendarEventMemorySeed,
): Record<string, unknown> {
  const authored = readOptionalRecord(seed.metadata);
  const joinLink =
    readNonEmptyString(seed.joinLink) ??
    readNonEmptyString(seed.conferenceLink);
  const cancelledAt =
    normalizeIsoDate(seed.cancelledAt) ?? normalizeIsoDate(seed.canceledAt);
  return {
    ...(authored ?? {}),
    source: "scenario-seed",
    kind: "calendar-event",
    ...(ctx.scenarioId ? { scenarioId: ctx.scenarioId } : {}),
    ...(joinLink ? { joinLink } : {}),
    ...(cancelledAt ? { cancelledAt } : {}),
  };
}

function normalizeCalendarEventSeed(
  ctx: ScenarioContext,
  runtime: AgentRuntime,
  seed: CalendarEventMemorySeed,
): LifeOpsCalendarEventSeedInput | string {
  const provider = normalizeCalendarProvider(seed.provider);
  if (!provider) {
    return "calendar-event memory seed provider must be google or apple_calendar";
  }
  const side = normalizeCalendarSide(seed.side);
  if (!side) {
    return "calendar-event memory seed side must be owner or agent";
  }
  const title = readNonEmptyString(seed.title);
  if (!title) {
    return "calendar-event memory seed requires a title";
  }
  const startAt = normalizeIsoDate(seed.startAt);
  if (!startAt) {
    return "calendar-event memory seed requires a valid startAt timestamp";
  }
  const durationMinutes = readPositiveInteger(seed.durationMinutes) ?? 30;
  const endAt =
    normalizeIsoDate(seed.endAt) ??
    new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString();
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    return "calendar-event memory seed endAt must be after startAt";
  }

  const id =
    readNonEmptyString(seed.id) ??
    stringToUuid(
      `scenario-calendar-event:${ctx.scenarioId ?? "unknown"}:${title}:${startAt}`,
    );
  const externalId = readNonEmptyString(seed.externalId) ?? id;
  const cancelled =
    readOptionalBoolean(seed.cancelled) ?? readOptionalBoolean(seed.canceled);
  const status =
    readNonEmptyString(seed.status) ?? (cancelled ? "cancelled" : "confirmed");
  const conferenceLink =
    readNonEmptyString(seed.conferenceLink) ??
    readNonEmptyString(seed.joinLink);
  const connectorAccountId = readNonEmptyString(seed.connectorAccountId);
  const grantId = readNonEmptyString(seed.grantId);
  const accountEmail = readNonEmptyString(seed.accountEmail);
  const nowIso = readScenarioNow(ctx).toISOString();
  return {
    id,
    externalId,
    agentId: String(runtime.agentId),
    provider,
    side,
    calendarId: readNonEmptyString(seed.calendarId) ?? "primary",
    title,
    description: readNonEmptyString(seed.description) ?? "",
    location: readNonEmptyString(seed.location) ?? "",
    status,
    startAt,
    endAt,
    isAllDay: readOptionalBoolean(seed.isAllDay) ?? false,
    timezone:
      readNonEmptyString(seed.timezone) ??
      readNonEmptyString(seed.timeZone) ??
      null,
    htmlLink: readNonEmptyString(seed.htmlLink) ?? readNonEmptyString(seed.url),
    conferenceLink,
    organizer: readOptionalRecord(seed.organizer),
    attendees: normalizeCalendarAttendees(seed.attendees),
    metadata: calendarEventMetadata(ctx, seed),
    syncedAt: nowIso,
    updatedAt: nowIso,
    ...(connectorAccountId ? { connectorAccountId } : {}),
    ...(grantId ? { grantId } : {}),
    ...(accountEmail ? { accountEmail } : {}),
  };
}

async function seedCalendarEventMemory(
  ctx: ScenarioContext,
  seed: CalendarEventMemorySeed,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const { LifeOpsRepository } = await loadLifeOps();
  await LifeOpsRepository.bootstrapSchema(runtime);
  const event = normalizeCalendarEventSeed(ctx, runtime, seed);
  if (typeof event === "string") {
    return event;
  }
  const repository = new LifeOpsRepository(runtime);
  await repository.upsertCalendarEvent(event, event.side);
  return undefined;
}

function inboundMessageSenderName(seed: InboundMessageMemorySeed): string {
  return (
    readNonEmptyString(seed.displayName) ??
    readNonEmptyString(seed.from) ??
    readNonEmptyString(seed.handle) ??
    "Scenario sender"
  );
}

function inboundMessageSenderEntityId(
  ctx: ScenarioContext,
  seed: InboundMessageMemorySeed,
): UUID {
  const platform = readNonEmptyString(seed.platform) ?? "scenario";
  const identity =
    readNonEmptyString(seed.platformUserId) ??
    readNonEmptyString(seed.handle) ??
    inboundMessageSenderName(seed);
  return stringToUuid(
    `scenario-inbound-message-sender:${ctx.scenarioId ?? "unknown"}:${platform}:${identity}`,
  ) as UUID;
}

function inboundMessageTimestamp(
  ctx: ScenarioContext,
  seed: InboundMessageMemorySeed,
): number {
  const occurredAt = readNonEmptyString(seed.occurredAt);
  if (occurredAt) {
    const parsed = Date.parse(occurredAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return readScenarioNow(ctx).getTime();
}

async function seedInboundMessageMemory(
  ctx: ScenarioContext,
  seed: InboundMessageMemorySeed,
): Promise<string | undefined> {
  const text = readNonEmptyString(seed.text);
  if (!text) {
    return "inbound-message memory seed requires non-empty text";
  }
  const runtime = requireRuntime(ctx);
  const roomId = readNonEmptyString(ctx.primaryRoomId);
  if (!roomId) {
    return "inbound-message memory seed requires ctx.primaryRoomId (set by the executor before seeds run)";
  }

  const senderName = inboundMessageSenderName(seed);
  const senderEntityId = inboundMessageSenderEntityId(ctx, seed);
  const existingEntity = await runtime.getEntityById(senderEntityId);
  if (!existingEntity) {
    await runtime.createEntity({
      id: senderEntityId,
      names: [senderName],
      agentId: runtime.agentId,
    });
  }

  const timestamp = inboundMessageTimestamp(ctx, seed);
  const platform = readNonEmptyString(seed.platform) ?? "scenario";
  const handle = readNonEmptyString(seed.handle);
  const platformUserId = readNonEmptyString(seed.platformUserId);
  const url = readNonEmptyString(seed.url);
  const relationship = readNonEmptyString(seed.relationship);
  const priority = readNonEmptyString(seed.priority);
  const threadId = readNonEmptyString(seed.threadId);
  const messageId =
    readNonEmptyString(seed.messageId) ??
    `${ctx.scenarioId ?? "scenario"}:${roomId}:${senderEntityId}:${timestamp}`;
  const source = readNonEmptyString(seed.source) ?? platform;
  const memory = createMessageMemory({
    id: stringToUuid(`scenario-inbound-message:${messageId}`),
    entityId: senderEntityId,
    roomId: roomId as UUID,
    content: {
      text,
      source,
      ...(url ? { url } : {}),
      ...(handle ? { username: handle } : {}),
      displayName: senderName,
      senderName,
      from: readNonEmptyString(seed.from) ?? senderName,
      ...(platform ? { platform } : {}),
      ...(platformUserId ? { platformUserId } : {}),
      ...(relationship ? { relationship } : {}),
      ...(priority ? { priority } : {}),
    },
  });
  memory.createdAt = timestamp;
  memory.metadata = {
    ...memory.metadata,
    source: "scenario-seed",
    sourceId: messageId,
    timestamp,
    scenarioId: ctx.scenarioId,
    kind: "inbound-message",
    entityName: senderName,
    sender: {
      name: senderName,
      ...(handle ? { username: handle } : {}),
      ...(platformUserId ? { id: platformUserId } : {}),
    },
    provider: platform,
    ...(handle ? { username: handle } : {}),
    ...(platformUserId ? { fromId: platformUserId, platformUserId } : {}),
    ...(relationship ? { relationship } : {}),
    ...(priority ? { priority } : {}),
    ...(threadId ? { thread: { id: threadId } } : {}),
    ...(platform === "telegram" && platformUserId
      ? { telegram: { userId: platformUserId, id: platformUserId, messageId } }
      : {}),
  };
  await runtime.createMemory(memory, "messages");
  return undefined;
}

async function seedContact(
  ctx: ScenarioContext,
  seed: ContactSeed,
): Promise<string | undefined> {
  const runtime = requireRuntime(ctx);
  const service = await requireRelationshipsService(runtime);
  const name = readNonEmptyString(seed.name);
  if (!name) {
    return "contact seed requires a name";
  }

  const entityId = buildContactEntityId(runtime, name);
  const existingEntity = await runtime.getEntityById(entityId);
  if (!existingEntity) {
    await runtime.createEntity({
      id: entityId,
      names: [name],
      agentId: runtime.agentId,
    });
  }

  const categories = readStringArray(seed.categories);
  const notes = readNonEmptyString(seed.notes);
  const existing = await service.getContact(entityId);
  if (!existing) {
    await service.addContact(
      entityId,
      categories.length > 0 ? categories : ["acquaintance"],
      notes ? { notes } : {},
      { displayName: name },
    );
  }

  const handles = normalizeContactHandles(seed.handles);
  for (const handle of handles) {
    await service.addHandle?.(entityId, handle);
  }

  const followupThresholdDays = readOptionalNumber(seed.followupThresholdDays);
  const relationshipGoal = readNonEmptyString(seed.relationshipGoal);
  const relationshipStatus =
    normalizeRelationshipStatus(seed.relationshipStatus) ?? "active";
  const tags = readStringArray(seed.tags);

  const patch: Parameters<RelationshipsServiceLike["updateContact"]>[1] = {
    ...(notes ? { preferences: { notes } } : {}),
    ...(followupThresholdDays !== undefined ? { followupThresholdDays } : {}),
    relationshipStatus,
    ...(tags.length > 0 ? { tags } : {}),
  };
  await service.updateContact(entityId, patch);

  if (relationshipGoal) {
    await service.setRelationshipGoal?.(entityId, {
      goalText: relationshipGoal,
      targetCadenceDays: followupThresholdDays,
    });
  }

  const lastContactedAt = readNonEmptyString(seed.lastContactedAt);
  if (lastContactedAt) {
    await service.recordInteraction?.({
      contactId: entityId,
      platform: handles[0]?.platform ?? "scenario",
      direction: "outbound",
      occurredAt: lastContactedAt,
      summary: "Scenario-seeded interaction",
    });
  }

  return undefined;
}

async function seedMemory(
  ctx: ScenarioContext,
  seed: MemorySeed,
): Promise<string | undefined> {
  const content = seed.content as MemoryContactSeed | undefined;
  if (!content || typeof content !== "object") {
    return "memory seed requires a content object";
  }
  const memoryType =
    readNonEmptyString(content.kind) ?? readNonEmptyString(content.type);
  if (
    memoryType === "contact" ||
    memoryType === "rolodex-entity" ||
    memoryType === "merged-entity"
  ) {
    return seedContact(ctx, memoryEntityToContactSeed(content, memoryType));
  }
  if (memoryType === "user-state") {
    return seedUserStateMemory(ctx, content as UserStateMemorySeed);
  }
  if (memoryType === "focus-window-active") {
    const userStateSeed = focusWindowToUserStateSeed(
      ctx,
      content as FocusWindowMemorySeed,
    );
    if (typeof userStateSeed === "string") return userStateSeed;
    return seedUserStateMemory(ctx, userStateSeed);
  }
  if (memoryType === "queued-push") {
    return seedQueuedPushMemory(ctx, content as QueuedPushMemorySeed);
  }
  if (memoryType === "device-intent") {
    return seedDeviceIntentMemory(ctx, content as DeviceIntentMemorySeed);
  }
  if (
    memoryType === "push-delivery-attempt" ||
    memoryType === "outbound-push-attempt"
  ) {
    return seedReminderAttemptMemory(ctx, content as ReminderAttemptMemorySeed);
  }
  if (memoryType === "ladder-state") {
    return seedLadderStateMemory(ctx, content as LadderStateMemorySeed);
  }
  if (memoryType && TRAVEL_FACT_MEMORY_KINDS.has(memoryType)) {
    const text = formatStructuredMemoryFact(memoryType, content);
    return writeDurableFact(ctx, text, { seedKind: memoryType });
  }
  if (memoryType === "calendar-event") {
    return seedCalendarEventMemory(ctx, content as CalendarEventMemorySeed);
  }
  if (memoryType === "inbound-message") {
    return seedInboundMessageMemory(ctx, content as InboundMessageMemorySeed);
  }
  if (memoryType !== null) {
    // A seed the runner cannot land must fail the scenario, never no-op:
    // a silently dropped seed fabricates the premise the checks grade
    // against (#14631 — the "seeded VIP fact" the model never received).
    return `unsupported memory seed kind "${memoryType}" — supported: contact/rolodex-entity/merged-entity/calendar-event/inbound-message/user-state/focus-window-active/queued-push/device-intent/push-delivery-attempt/outbound-push-attempt/ladder-state, travel profile/trip/booking/upgrade-offer/calendar-focus-window, or plain { text } for a durable owner fact`;
  }
  const text = readNonEmptyString((content as { text?: unknown }).text);
  if (!text) {
    return "memory seed content must carry non-empty text or a contact-like kind";
  }
  return writeDurableFact(ctx, text);
}

function formatStructuredMemoryFact(
  memoryType: string,
  content: Record<string, unknown>,
): string {
  return [
    `Scenario-seeded travel ${memoryType} context:`,
    JSON.stringify(content, null, 2),
  ].join("\n");
}

async function writeDurableFact(
  ctx: ScenarioContext,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<string | undefined> {
  // Plain-text memory seeds are owner facts: write a real durable row in the
  // `facts` table, attributed to the primary room + simulated owner entity,
  // in the exact shape the fact extractor persists — so the core FACTS
  // provider retrieves and renders it during turns (durable facts fall back
  // to highest-prior when keyword relevance misses, so seeded facts surface
  // even without lexical overlap with the turn text).
  const runtime = requireRuntime(ctx);
  const roomId = readNonEmptyString(ctx.primaryRoomId);
  const entityId = readNonEmptyString(ctx.primaryUserId);
  if (!roomId || !entityId) {
    return "memory seed requires ctx.primaryRoomId/primaryUserId (set by the executor before seeds run)";
  }
  await runtime.createMemory(
    {
      id: stringToUuid(`scenario-fact:${ctx.scenarioId ?? "unknown"}:${text}`),
      entityId: entityId as UUID,
      agentId: runtime.agentId,
      roomId: roomId as UUID,
      content: { text },
      metadata: {
        type: MemoryType.CUSTOM,
        source: "scenario-seed",
        confidence: 0.95,
        kind: "durable",
        category: "seeded",
        keywords: [],
        ...metadata,
      },
      createdAt: Date.now(),
    },
    "facts",
    true,
  );
  return undefined;
}

const GMAIL_FIXTURE_MESSAGE_IDS: Readonly<Record<string, readonly string[]>> = {
  default: ["msg-finance", "msg-sarah", "msg-newsletter"],
  "unread-inbox.eml": ["msg-finance", "msg-sarah"],
  "sarah-product-brief.eml": ["msg-sarah"],
  "high-priority-client.eml": ["msg-sarah"],
  "alice-recent.eml": ["msg-sarah"],
  "followup-14-days-ago.eml": [
    "msg-unresponded-inbound",
    "msg-unresponded-sent",
  ],
  // Forwarded-email prompt-injection trap (comms-flood pack, #12283 D1); the
  // message body carries a fake wire-transfer "owner instruction" the model
  // must flag, never execute.
  "injection-fake-wire-instruction": ["msg-injection-wire"],
};

function gmailSeedFixtureNames(seed: GmailInboxSeed): string[] {
  const explicit = readNonEmptyString(seed.fixture);
  const multiple = readStringArray(seed.fixtures);
  const names = [...(explicit ? [explicit] : []), ...multiple];
  return names.length > 0 ? names : ["default"];
}

async function clearGmailMockLedger(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/__mock/requests`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(
      `Gmail mock ledger clear failed with HTTP ${response.status}`,
    );
  }
}

async function clearGmailMockFault(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/__mock/google/gmail/fault`, {
    method: "DELETE",
  });
  if (response.ok || response.status === 404) {
    return;
  }
  throw new Error(`Gmail mock fault reset failed with HTTP ${response.status}`);
}

function normalizeGmailFaultMode(
  value: unknown,
): GmailFaultInjectionConfig["mode"] | null {
  const mode = readNonEmptyString(value);
  if (
    mode === "auth_expired" ||
    mode === "rate_limit" ||
    mode === "server_error" ||
    mode === "partial_failure"
  ) {
    return mode;
  }
  return null;
}

function defaultGmailFaultPath(
  mode: GmailFaultInjectionConfig["mode"],
): string {
  return mode === "partial_failure"
    ? "/gmail/v1/users/me/messages/batchModify"
    : "/gmail/v1/users/me/messages";
}

function normalizeGmailFaultInjection(
  value: unknown,
): GmailFaultInjectionConfig | string | null {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  if (!value || typeof value !== "object") {
    return "gmailInbox faultInjection must be an object";
  }
  const seed = value as GmailFaultInjectionSeed;
  const mode = normalizeGmailFaultMode(seed.mode);
  if (!mode) {
    return "gmailInbox faultInjection.mode must be auth_expired, rate_limit, server_error, or partial_failure";
  }
  const rawMethod = readNonEmptyString(seed.method);
  const rawPath =
    readNonEmptyString(seed.path) ?? readNonEmptyString(seed.endpoint);
  const path = rawPath
    ? rawPath.startsWith("/")
      ? rawPath
      : `/${rawPath}`
    : defaultGmailFaultPath(mode);
  let remaining: number | undefined;
  if (seed.limit !== undefined && seed.limit !== null) {
    if (
      typeof seed.limit !== "number" ||
      !Number.isFinite(seed.limit) ||
      seed.limit < 0
    ) {
      return "gmailInbox faultInjection.limit must be a non-negative number";
    }
    remaining = Math.floor(seed.limit);
  }
  return {
    mode,
    method: (
      rawMethod ?? (mode === "partial_failure" ? "POST" : "GET")
    ).toUpperCase(),
    path,
    ...(remaining !== undefined ? { remaining } : {}),
  };
}

async function configureGmailMockFault(
  baseUrl: string,
  fault: GmailFaultInjectionConfig,
): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}/__mock/google/gmail/fault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fault),
  });
  if (response.ok) {
    return undefined;
  }
  return `Gmail mock faultInjection setup failed with HTTP ${response.status}`;
}

async function requireMockGmailMessage(
  baseUrl: string,
  messageId: string,
): Promise<string | undefined> {
  const response = await fetch(
    `${baseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
  );
  if (response.ok) {
    return undefined;
  }
  return `Gmail mock fixture message ${messageId} unavailable (HTTP ${response.status})`;
}

async function seedGmailInbox(
  seed: GmailInboxSeed,
): Promise<string | undefined> {
  const baseUrl = process.env.ELIZA_MOCK_GOOGLE_BASE;
  if (typeof baseUrl !== "string" || !isLoopbackUrl(baseUrl)) {
    return "gmailInbox seed requires ELIZA_MOCK_GOOGLE_BASE to point at the loopback Google mock";
  }
  const mockBaseUrl = baseUrl;
  const faultInjection = normalizeGmailFaultInjection(seed.faultInjection);
  if (typeof faultInjection === "string") {
    return faultInjection;
  }

  await clearGmailMockFault(mockBaseUrl);

  const requiredIds = new Set(readStringArray(seed.requiredMessageIds));
  for (const fixture of gmailSeedFixtureNames(seed)) {
    const fixtureIds = GMAIL_FIXTURE_MESSAGE_IDS[fixture];
    if (!fixtureIds) {
      return `unsupported gmailInbox fixture "${fixture}"`;
    }
    for (const messageId of fixtureIds) {
      requiredIds.add(messageId);
    }
  }

  for (const messageId of requiredIds) {
    const failure = await requireMockGmailMessage(mockBaseUrl, messageId);
    if (failure) {
      return failure;
    }
  }

  if (seed.clearLedger !== false) {
    await clearGmailMockLedger(mockBaseUrl);
  }

  if (faultInjection) {
    return configureGmailMockFault(mockBaseUrl, faultInjection);
  }

  return undefined;
}

function normalizeConnectorKind(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  return raw ? raw.toLowerCase().replace(/[\s_]+/g, "-") : null;
}

function connectorStateText(seed: ConnectorSeed): string {
  return readNonEmptyString(seed.state)?.replace(/[-_]+/g, " ") ?? "degraded";
}

function connectorLabel(seed: ConnectorSeed, connector: string): string {
  return readNonEmptyString(seed.provider) ?? connector;
}

function connectorStatusFromSeed(
  seed: ConnectorSeed,
  connector: string,
): ConnectorStatusLike {
  const state = readNonEmptyString(seed.state);
  const disconnected =
    seed.type === "connectorAuthSession" ||
    state === "auth-expired" ||
    state === "session-revoked" ||
    state === "disconnected" ||
    state === "helper-disconnected";
  return {
    state: disconnected ? "disconnected" : "degraded",
    message: `${connectorLabel(seed, connector)} seeded ${connectorStateText(seed)}`,
    observedAt: new Date().toISOString(),
  };
}

function dispatchFailureFromSeed(seed: ConnectorSeed): DispatchResultLike {
  const state = readNonEmptyString(seed.state);
  const message = `${connectorLabel(
    seed,
    readNonEmptyString(seed.connector) ?? "connector",
  )} seeded ${connectorStateText(seed)}`;
  if (state === "rate-limited") {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 5,
      userActionable: false,
      message,
    };
  }
  if (
    seed.type === "connectorAuthSession" ||
    state === "auth-expired" ||
    state === "session-revoked" ||
    state === "missing-scope"
  ) {
    return {
      ok: false,
      reason: "auth_expired",
      userActionable: true,
      message,
    };
  }
  if (
    state === "disconnected" ||
    state === "helper-disconnected" ||
    state === "transport-offline" ||
    state === "blocked-resume"
  ) {
    return {
      ok: false,
      reason: "disconnected",
      userActionable: true,
      message,
    };
  }
  return {
    ok: false,
    reason: "transport_error",
    userActionable: state === "hold-expired",
    message,
  };
}

function connectorMatchesFilter(
  contribution: ConnectorContributionLike,
  filter?: ConnectorRegistryFilterLike,
): boolean {
  if (!filter) {
    return true;
  }
  if (
    filter.capability &&
    !contribution.capabilities.includes(filter.capability)
  ) {
    return false;
  }
  if (filter.mode && !contribution.modes.includes(filter.mode)) {
    return false;
  }
  return true;
}

function seededConnectorContribution(
  seed: ConnectorSeed,
  connector: string,
  base: ConnectorContributionLike | null,
): ConnectorContributionLike {
  const capabilities = readStringArray(seed.capabilities);
  const scopedCapabilities = readStringArray(seed.scopes);
  const allCapabilities =
    capabilities.length > 0 || scopedCapabilities.length > 0
      ? [...capabilities, ...scopedCapabilities]
      : (base?.capabilities ?? [`${connector}.scenario-seeded`]);
  const limit = readPositiveInteger(seed.limit);
  let failuresRemaining =
    seed.type === "transportFault"
      ? (limit ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
  const failure = () => dispatchFailureFromSeed(seed);

  return {
    ...(base ?? {}),
    kind: base?.kind ?? connector,
    capabilities: allCapabilities,
    modes: base?.modes ?? ["local"],
    describe: base?.describe ?? { label: connectorLabel(seed, connector) },
    start: base?.start ?? (async () => undefined),
    disconnect: base?.disconnect ?? (async () => undefined),
    verify: async () => false,
    status: async () => connectorStatusFromSeed(seed, connector),
    ...(base?.read ? { read: base.read.bind(base) } : {}),
    ...(base?.requiresApproval !== undefined
      ? { requiresApproval: base.requiresApproval }
      : {}),
    ...(base?.oauth ? { oauth: base.oauth } : {}),
    ...(base?.apiBaseUrl ? { apiBaseUrl: base.apiBaseUrl } : {}),
    send: async (payload: unknown) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return failure();
      }
      if (base?.send) {
        return base.send(payload);
      }
      return failure();
    },
  };
}

function createSeededConnectorRegistry(
  base: ConnectorRegistryLike,
  seed: ConnectorSeed,
  connector: string,
): ConnectorRegistryLike {
  const getSeeded = (): ConnectorContributionLike =>
    seededConnectorContribution(seed, connector, base.get(connector));

  return {
    register(contribution) {
      base.register(contribution);
    },
    get(kind) {
      return kind === connector ? getSeeded() : base.get(kind);
    },
    list(filter) {
      const listed = base.list(filter).flatMap((contribution) => {
        if (contribution.kind !== connector) {
          return [contribution];
        }
        const seeded = getSeeded();
        return connectorMatchesFilter(seeded, filter) ? [seeded] : [];
      });
      if (!listed.some((contribution) => contribution.kind === connector)) {
        const seeded = getSeeded();
        if (connectorMatchesFilter(seeded, filter)) {
          listed.push(seeded);
        }
      }
      return listed;
    },
    byCapability(capability) {
      return this.list({ capability });
    },
  };
}

async function seedConnector(
  ctx: ScenarioContext,
  seed: ConnectorSeed,
): Promise<string | undefined> {
  const connector = normalizeConnectorKind(seed.connector);
  if (!connector) {
    return `${seed.type} seed requires a connector`;
  }
  const runtime = requireRuntime(ctx);
  const {
    createConnectorRegistry,
    getConnectorRegistry,
    registerConnectorRegistry,
  } = await loadConnectorRegistry();
  const currentRegistry =
    getConnectorRegistry(runtime) ?? createConnectorRegistry();
  registerConnectorRegistry(
    runtime,
    createSeededConnectorRegistry(currentRegistry, seed, connector),
  );
  return undefined;
}

export async function applyScenarioSeedStep(
  ctx: ScenarioContext,
  seed: ScenarioSeedStep,
): Promise<string | undefined> {
  if (!seed || typeof seed !== "object") {
    return undefined;
  }

  if (seed.type === "todo") {
    return seedTodo(ctx, seed as TodoSeed);
  }
  if (seed.type === "contact") {
    return seedContact(ctx, seed as ContactSeed);
  }
  if (seed.type === "memory") {
    return seedMemory(ctx, seed as MemorySeed);
  }
  if (seed.type === "gmailInbox") {
    return seedGmailInbox(seed as GmailInboxSeed);
  }
  if (
    seed.type === "connectorStatus" ||
    seed.type === "connectorAuthSession" ||
    seed.type === "transportFault"
  ) {
    return seedConnector(ctx, seed as ConnectorSeed);
  }

  return undefined;
}

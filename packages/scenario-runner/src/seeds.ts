/**
 * Applies a scenario's `seed` steps to a live runtime before turns execute,
 * standing up the domain state a scenario assumes: todos, contacts, memories,
 * LifeOps task definitions/occurrences, and Gmail inbox fixtures. `applyScenarioSeedStep`
 * dispatches on the seed step's type and writes directly through the runtime's
 * stores so scenarios start from a known, deterministic world. Consumed by the
 * executor between setup and the first turn.
 */
import type { AgentRuntime, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
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

type LifeOpsRepositoryInstance = {
  createDefinition: (definition: LifeOpsTaskDefinition) => Promise<unknown>;
  upsertOccurrence: (occurrence: LifeOpsOccurrence) => Promise<unknown>;
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
  const defaultsSpecifier: string =
    "../../../plugins/plugin-personal-assistant/src/lifeops/defaults.ts";
  const engineSpecifier: string =
    "../../../plugins/plugin-personal-assistant/src/lifeops/engine.ts";
  const repositorySpecifier: string =
    "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts";
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
    return undefined;
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

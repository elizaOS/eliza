import type { AgentRuntime, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { isLoopbackUrl } from "./utils.js";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-schema";

// Loaded lazily so this module can be built without pulling app-lifeops into the
// scenario-runner rootDir (app-lifeops is only available at runtime).
async function loadLifeOps() {
  // Cast to `string` so TypeScript does not statically resolve these paths for
  // rootDir validation — they live outside this package's src/ rootDir.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic imports outside rootDir
  const [
    { resolveDefaultWindowPolicy },
    { materializeDefinitionOccurrences },
    repo,
  ] = await Promise.all([
    import(
      "../../../plugins/app-lifeops/src/lifeops/defaults.ts" as string
    ) as any,
    import(
      "../../../plugins/app-lifeops/src/lifeops/engine.ts" as string
    ) as any,
    import(
      "../../../plugins/app-lifeops/src/lifeops/repository.ts" as string
    ) as any,
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
  displayLabel?: unknown;
  isPrimary?: unknown;
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
};

type MemoryContactSeed = {
  kind?: unknown;
  type?: unknown;
  name?: unknown;
  notes?: unknown;
  relationshipGoal?: unknown;
  followupThresholdDays?: unknown;
  lastContactedAt?: unknown;
  relationshipStatus?: unknown;
};

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

function normalizeContactHandles(value: unknown): Array<{
  platform: string;
  identifier: string;
  displayLabel?: string;
  isPrimary?: boolean;
}> {
  if (!Array.isArray(value)) return [];
  const handles: Array<{
    platform: string;
    identifier: string;
    displayLabel?: string;
    isPrimary?: boolean;
  }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const handle = entry as ContactSeedHandle;
    const platform = readNonEmptyString(handle.platform);
    const identifier = readNonEmptyString(handle.identifier);
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
  if (memoryType !== "contact") {
    return undefined;
  }
  return seedContact(ctx, {
    type: "contact",
    name: content.name,
    notes: content.notes,
    relationshipGoal: content.relationshipGoal,
    followupThresholdDays: content.followupThresholdDays,
    lastContactedAt: content.lastContactedAt,
    relationshipStatus: content.relationshipStatus,
  });
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

async function requireMockGmailMessage(
  baseUrl: string,
  messageId: string,
): Promise<string | undefined> {
  // @duplicate-component-audit-allow: Gmail mock `/messages` fixture lookup, not model generation.
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

  return undefined;
}

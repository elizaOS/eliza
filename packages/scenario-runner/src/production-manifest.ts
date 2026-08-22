/**
 * Applies versioned synthetic-world manifests through `AgentRuntime`'s
 * production persistence boundaries and projects canonical readback artifacts
 * from those same stores. The serialized receipt is the only reset input, so a
 * later process can remove exactly the records created by an earlier process.
 */
import { createHash } from "node:crypto";
import {
  type AgentNotification,
  ChannelType,
  ElizaError,
  type IAgentRuntime,
  type JsonValue,
  type Metadata,
  NotificationService,
  ServiceType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  type ApprovalAction,
  type ApprovalChannel,
  type ApprovalPayload,
  type ApprovalQueue,
  type ApprovalRequest,
  resolveApprovalService,
} from "@elizaos/agent";
import {
  getScheduledTaskRunner,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRunner,
  scheduledTaskInputSchema,
} from "@elizaos/plugin-scheduling";

const MANIFEST_VERSION = 1 as const;
const CHANNEL_TYPES = new Set<string>(Object.values(ChannelType));
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MEMORY_TABLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const MANIFEST_MAX_DEPTH = 32;
const MANIFEST_MAX_NODES = 20_000;
const MANIFEST_MAX_CONTAINER_WIDTH = 2_000;
const MANIFEST_MAX_TOP_LEVEL_ROWS = 1_000;
const MANIFEST_MAX_STRING_BYTES = 65_536;
const MANIFEST_MAX_TOTAL_STRING_BYTES = 1_048_576;
const NOTIFICATION_CATEGORIES = new Set<AgentNotification["category"]>([
  "reminder",
  "task",
  "workflow",
  "agent",
  "approval",
  "message",
  "health",
  "system",
  "general",
]);
const NOTIFICATION_PRIORITIES = new Set<AgentNotification["priority"]>([
  "low",
  "normal",
  "high",
  "urgent",
]);
const APPROVAL_CHANNELS = new Set<ApprovalChannel>([
  "telegram",
  "discord",
  "signal",
  "whatsapp",
  "slack",
  "imessage",
  "sms",
  "x_dm",
  "email",
  "google_calendar",
  "microsoft_calendar",
  "apple_calendar",
  "ics_calendar",
  "browser",
  "phone",
  "internal",
]);

export interface ProductionManifestEntity {
  id: string;
  names: string[];
  metadata?: Metadata;
}

export interface ProductionManifestRoom {
  id: string;
  name: string;
  source: string;
  type: (typeof ChannelType)[keyof typeof ChannelType];
  participantEntityIds?: string[];
}

export interface ProductionManifestMemory {
  id: string;
  roomId: string;
  entityId: string;
  text: string;
  tableName?: string;
  metadata?: Metadata;
}

export interface ProductionManifestSchedule {
  id: string;
  task: ScheduledTaskInput;
}

export interface ProductionManifestNotification {
  id: string;
  title: string;
  body?: string;
  category?: AgentNotification["category"];
  priority?: AgentNotification["priority"];
  source?: string;
  deepLink?: string;
  icon?: string;
  groupKey?: string;
  data?: Record<string, JsonValue>;
  expiresAt?: number | null;
}

/**
 * A deliberately closed approval seed. `execute_workflow` exercises the real
 * durable approval queue without letting an untrusted manifest smuggle one of
 * the many connector-specific payload dialects past preflight validation.
 */
export interface ProductionManifestApproval {
  id: string;
  subjectEntityId: string;
  workflowId: string;
  input: Record<string, string | number | boolean>;
  channel?: ApprovalChannel;
  reason: string;
  expiresAt: number;
}

export interface ProductionManifestProviderState {
  id: string;
  /** Production cache key template; must contain the literal `{{namespace}}`. */
  key: string;
  value: JsonValue;
}

export interface ProductionManifestRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  tags?: string[];
  metadata?: Metadata;
}

export interface ProductionManifestTask {
  id: string;
  name: string;
  description?: string;
  roomId?: string;
  entityId?: string;
  tags?: string[];
  dueAt?: number;
  metadata?: Metadata;
}

export interface ProductionManifestV1 {
  version: typeof MANIFEST_VERSION;
  namespace: string;
  ownerAgentId: UUID;
  entities?: ProductionManifestEntity[];
  rooms?: ProductionManifestRoom[];
  memories?: ProductionManifestMemory[];
  relationships?: ProductionManifestRelationship[];
  tasks?: ProductionManifestTask[];
  schedules?: ProductionManifestSchedule[];
  notifications?: ProductionManifestNotification[];
  approvals?: ProductionManifestApproval[];
  providerState?: ProductionManifestProviderState[];
}

export interface ProductionManifestReceipt {
  version: typeof MANIFEST_VERSION;
  namespace: string;
  ownerAgentId: UUID;
  manifestSha256: string;
  worldId: UUID;
  entityIds: UUID[];
  roomIds: UUID[];
  participantPairs: Array<{ entityId: UUID; roomId: UUID }>;
  memoryIds: UUID[];
  memoryTableNames: string[];
  relationshipIds: UUID[];
  taskIds: UUID[];
  scheduleIds: string[];
  notificationIds: UUID[];
  approvalRecords: Array<{ id: string; subjectUserId: string }>;
  providerStateKeys: string[];
}

export interface ProductionManifestSnapshot {
  version: typeof MANIFEST_VERSION;
  namespace: string;
  ownerAgentId: UUID;
  world: { id: UUID; name: string | null };
  entities: Array<{ id: UUID; names: string[]; metadata: JsonValue | null }>;
  rooms: Array<{
    id: UUID;
    name: string | null;
    source: string;
    type: string;
    worldId: UUID;
    participantEntityIds: UUID[];
  }>;
  memories: Array<{
    id: UUID;
    roomId: UUID;
    entityId: UUID;
    text: string;
    tableName: string;
    metadata: JsonValue | null;
  }>;
  relationships: Array<{
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags: string[];
    metadata: JsonValue | null;
  }>;
  tasks: Array<{
    id: UUID;
    name: string;
    description: string | null;
    roomId: UUID | null;
    entityId: UUID | null;
    worldId: UUID | null;
    tags: string[];
    dueAt: number | null;
    metadata: JsonValue | null;
  }>;
  schedules: Array<{
    logicalId: string;
    task: JsonValue;
  }>;
  notifications: Array<{
    logicalId: string;
    title: string;
    body: string | null;
    category: string;
    priority: string;
    source: string;
    deepLink: string | null;
    icon: string | null;
    groupKey: string | null;
    data: JsonValue | null;
    expiresAt: number | null;
  }>;
  approvals: Array<{
    logicalId: string;
    subjectUserId: string;
    action: string;
    payload: JsonValue;
    channel: string;
    reason: string;
    expiresAt: number;
    state: string;
  }>;
  providerState: Array<{
    key: string;
    value: JsonValue;
  }>;
}

export interface ProductionManifestResetArtifact {
  version: typeof MANIFEST_VERSION;
  namespace: string;
  removed: ProductionManifestReceipt;
  absentAfterReset: {
    world: boolean;
    entities: UUID[];
    rooms: UUID[];
    memories: UUID[];
    relationships: UUID[];
    tasks: UUID[];
    schedules: string[];
    notifications: UUID[];
    approvals: string[];
    providerState: string[];
  };
}

export interface ProductionManifestResidueEvidence {
  worlds: UUID[];
  entities: UUID[];
  rooms: UUID[];
  memories: UUID[];
  relationships: UUID[];
  tasks: UUID[];
  schedules: string[];
  notifications: UUID[];
  approvals: string[];
  providerState: string[];
}

export interface ProductionManifestCycleArtifact {
  receipt: ProductionManifestReceipt;
  initial: ProductionManifestSnapshot;
  reset: ProductionManifestResetArtifact;
  reseedReceipt: ProductionManifestReceipt;
  final: ProductionManifestSnapshot;
  byteEquivalent: true;
}

export class ProductionManifestApplyError extends ElizaError {
  readonly dirtyReceipt?: ProductionManifestReceipt;
  readonly residue?: ProductionManifestResidueEvidence;

  constructor(
    message: string,
    code: string,
    options?: {
      cause?: unknown;
      dirtyReceipt?: ProductionManifestReceipt;
      residue?: ProductionManifestResidueEvidence;
    },
  ) {
    super(message, {
      code,
      context: options?.dirtyReceipt
        ? {
            namespace: options.dirtyReceipt.namespace,
            ...(options.residue ? { residue: options.residue } : {}),
          }
        : undefined,
      cause: options?.cause,
    });
    this.dirtyReceipt = options?.dirtyReceipt;
    this.residue = options?.residue;
  }
}

function fail(path: string, message: string): never {
  throw new ProductionManifestApplyError(
    `[production-manifest] ${path} ${message}`,
    "SCENARIO_MANIFEST_INVALID",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertDenseArrayShape(value: unknown[], path: string): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail(path, "must be a plain JSON array");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
      fail(path, "must not contain non-index array properties");
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= value.length) {
      fail(`${path}.${key}`, "is not a valid array index");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor)
      fail(`${path}[${index}]`, "must not be a sparse array slot");
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}[${index}]`, "must be an enumerable JSON data property");
    }
  }
}

function assertJsonValue(
  value: unknown,
  path: string,
  active: Set<object> = new Set(),
  budget = { nodes: 0, stringBytes: 0 },
  depth = 0,
): void {
  budget.nodes += 1;
  if (budget.nodes > MANIFEST_MAX_NODES) {
    fail(path, `exceeds the ${MANIFEST_MAX_NODES}-node JSON budget`);
  }
  if (depth > MANIFEST_MAX_DEPTH) {
    fail(path, `exceeds the maximum JSON depth of ${MANIFEST_MAX_DEPTH}`);
  }
  if (typeof value === "string") {
    const byteLength = new TextEncoder().encode(value).byteLength;
    if (byteLength > MANIFEST_MAX_STRING_BYTES) {
      fail(path, `exceeds the ${MANIFEST_MAX_STRING_BYTES}-byte string budget`);
    }
    budget.stringBytes += byteLength;
    if (budget.stringBytes > MANIFEST_MAX_TOTAL_STRING_BYTES) {
      fail(
        path,
        `exceeds the ${MANIFEST_MAX_TOTAL_STRING_BYTES}-byte total string budget`,
      );
    }
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite numbers");
    return;
  }
  if (typeof value !== "object") {
    fail(path, `contains non-JSON value of type ${typeof value}`);
  }
  if (active.has(value)) fail(path, "must not contain a cycle");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArrayShape(value, path);
      if (value.length > MANIFEST_MAX_CONTAINER_WIDTH) {
        fail(path, `exceeds the ${MANIFEST_MAX_CONTAINER_WIDTH}-item array budget`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        assertJsonValue(
          descriptor?.value,
          `${path}[${index}]`,
          active,
          budget,
          depth + 1,
        );
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, "must contain only plain JSON objects");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MANIFEST_MAX_CONTAINER_WIDTH) {
      fail(
        path,
        `exceeds the ${MANIFEST_MAX_CONTAINER_WIDTH}-key object budget`,
      );
    }
    for (const key of ownKeys) {
      if (typeof key !== "string") {
        fail(path, "must not contain symbol keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        fail(`${path}.${key}`, "must be an enumerable JSON data property");
      }
      const keyBytes = new TextEncoder().encode(key).byteLength;
      if (keyBytes > MANIFEST_MAX_STRING_BYTES) {
        fail(`${path}.${key}`, "object key exceeds the string byte budget");
      }
      budget.stringBytes += keyBytes;
      if (budget.stringBytes > MANIFEST_MAX_TOTAL_STRING_BYTES) {
        fail(path, "exceeds the total string byte budget");
      }
      assertJsonValue(
        descriptor.value,
        `${path}.${key}`,
        active,
        budget,
        depth + 1,
      );
    }
  } finally {
    active.delete(value);
  }
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  const allowedSet = new Set(allowed);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail(path, "must not contain symbol keys");
  }
  const keys = ownKeys as string[];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be an enumerable JSON data property");
    }
  }
  const unexpected = keys.find((key) => !allowedSet.has(key));
  if (unexpected) fail(`${path}.${unexpected}`, "is not supported");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  const ownKeys = Reflect.ownKeys(value);
  const symbolKey = ownKeys.find((key) => typeof key !== "string");
  if (symbolKey) fail(path, "must not contain symbol keys");
  const stringKeys = ownKeys as string[];
  const expectedSet = new Set(expected);
  const unexpected = stringKeys.find((key) => !expectedSet.has(key));
  if (unexpected) fail(`${path}.${unexpected}`, "is not supported");
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing) fail(`${path}.${missing}`, "is required");
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be an enumerable data property");
    }
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "must be a non-empty string");
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  assertDenseArrayShape(value, path);
  return value.map((entry, index) =>
    requiredString(entry, `${path}[${index}]`),
  );
}

function optionalMetadata(value: unknown, path: string): Metadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail(path, "must be a JSON object");
  assertJsonValue(value, path);
  return value as Metadata;
}

function optionalNullableSafeInteger(
  value: unknown,
  path: string,
): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value)) fail(path, "must be a safe integer or null");
  return value as number;
}

function jsonRecord(
  value: unknown,
  path: string,
): Record<string, JsonValue> {
  if (!isRecord(value)) fail(path, "must be a JSON object");
  assertJsonValue(value, path);
  return value as Record<string, JsonValue>;
}

function optionalJsonRecord(
  value: unknown,
  path: string,
): Record<string, JsonValue> | undefined {
  return value === undefined ? undefined : jsonRecord(value, path);
}

function parseArray<T>(
  value: unknown,
  path: string,
  parse: (entry: Record<string, unknown>, path: string) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(path, "must be an array");
  assertDenseArrayShape(value, path);
  if (value.length > MANIFEST_MAX_TOP_LEVEL_ROWS) {
    fail(path, `exceeds the ${MANIFEST_MAX_TOP_LEVEL_ROWS}-row budget`);
  }
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) fail(entryPath, "must be an object");
    return parse(entry, entryPath);
  });
}

function assertUniqueIds(
  groups: Array<{ path: string; entries: Array<{ id: string }> }>,
): void {
  const seen = new Map<string, string>();
  for (const group of groups) {
    for (const [index, entry] of group.entries.entries()) {
      const previous = seen.get(entry.id);
      if (previous) {
        fail(`${group.path}[${index}].id`, `duplicates ${previous}`);
      }
      seen.set(entry.id, `${group.path}[${index}].id`);
    }
  }
}

/** Validates a manifest completely before any production store is mutated. */
export function parseProductionManifest(input: unknown): ProductionManifestV1 {
  if (!isRecord(input)) fail("manifest", "must be an object");
  assertJsonValue(input, "manifest");
  assertKeys(
    input,
    [
      "version",
      "namespace",
      "ownerAgentId",
      "entities",
      "rooms",
      "memories",
      "relationships",
      "tasks",
      "schedules",
      "notifications",
      "approvals",
      "providerState",
    ],
    "manifest",
  );
  if (input.version !== MANIFEST_VERSION) {
    fail("manifest.version", `must equal ${MANIFEST_VERSION}`);
  }
  const namespace = requiredString(input.namespace, "manifest.namespace");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(namespace)) {
    fail("manifest.namespace", "contains unsupported characters");
  }
  const ownerAgentId = requiredString(
    input.ownerAgentId,
    "manifest.ownerAgentId",
  ) as UUID;
  const entities = parseArray(
    input.entities,
    "manifest.entities",
    (entry, path) => {
      assertKeys(entry, ["id", "names", "metadata"], path);
      const names = stringArray(entry.names, `${path}.names`);
      if (names.length === 0) fail(`${path}.names`, "must not be empty");
      return {
        id: requiredString(entry.id, `${path}.id`),
        names,
        metadata: optionalMetadata(entry.metadata, `${path}.metadata`),
      };
    },
  );
  const rooms = parseArray(input.rooms, "manifest.rooms", (entry, path) => {
    assertKeys(
      entry,
      ["id", "name", "source", "type", "participantEntityIds"],
      path,
    );
    const type = requiredString(entry.type, `${path}.type`);
    if (!CHANNEL_TYPES.has(type)) fail(`${path}.type`, "is not a channel type");
    return {
      id: requiredString(entry.id, `${path}.id`),
      name: requiredString(entry.name, `${path}.name`),
      source: requiredString(entry.source, `${path}.source`),
      type: type as ProductionManifestRoom["type"],
      participantEntityIds:
        entry.participantEntityIds === undefined
          ? undefined
          : stringArray(
              entry.participantEntityIds,
              `${path}.participantEntityIds`,
            ),
    };
  });
  const memories = parseArray(
    input.memories,
    "manifest.memories",
    (entry, path) => {
      assertKeys(
        entry,
        ["id", "roomId", "entityId", "text", "tableName", "metadata"],
        path,
      );
      const tableName = optionalString(entry.tableName, `${path}.tableName`);
      if (tableName !== undefined && !MEMORY_TABLE_PATTERN.test(tableName)) {
        fail(`${path}.tableName`, "must be a safe logical memory table name");
      }
      return {
        id: requiredString(entry.id, `${path}.id`),
        roomId: requiredString(entry.roomId, `${path}.roomId`),
        entityId: requiredString(entry.entityId, `${path}.entityId`),
        text: requiredString(entry.text, `${path}.text`),
        tableName,
        metadata: optionalMetadata(entry.metadata, `${path}.metadata`),
      };
    },
  );
  const relationships = parseArray(
    input.relationships,
    "manifest.relationships",
    (entry, path) => {
      assertKeys(
        entry,
        ["id", "sourceEntityId", "targetEntityId", "tags", "metadata"],
        path,
      );
      return {
        id: requiredString(entry.id, `${path}.id`),
        sourceEntityId: requiredString(
          entry.sourceEntityId,
          `${path}.sourceEntityId`,
        ),
        targetEntityId: requiredString(
          entry.targetEntityId,
          `${path}.targetEntityId`,
        ),
        tags:
          entry.tags === undefined
            ? undefined
            : stringArray(entry.tags, `${path}.tags`),
        metadata: optionalMetadata(entry.metadata, `${path}.metadata`),
      };
    },
  );
  const tasks = parseArray(input.tasks, "manifest.tasks", (entry, path) => {
    assertKeys(
      entry,
      [
        "id",
        "name",
        "description",
        "roomId",
        "entityId",
        "tags",
        "dueAt",
        "metadata",
      ],
      path,
    );
    if (
      entry.dueAt !== undefined &&
      (typeof entry.dueAt !== "number" || !Number.isSafeInteger(entry.dueAt))
    ) {
      fail(`${path}.dueAt`, "must be a safe integer epoch-millisecond value");
    }
    return {
      id: requiredString(entry.id, `${path}.id`),
      name: requiredString(entry.name, `${path}.name`),
      description: optionalString(entry.description, `${path}.description`),
      roomId: optionalString(entry.roomId, `${path}.roomId`),
      entityId: optionalString(entry.entityId, `${path}.entityId`),
      tags:
        entry.tags === undefined
          ? undefined
          : stringArray(entry.tags, `${path}.tags`),
      dueAt: entry.dueAt as number | undefined,
      metadata: optionalMetadata(entry.metadata, `${path}.metadata`),
    };
  });
  const schedules = parseArray(
    input.schedules,
    "manifest.schedules",
    (entry, path) => {
      assertKeys(entry, ["id", "task"], path);
      const id = requiredString(entry.id, `${path}.id`);
      if (!isRecord(entry.task)) fail(`${path}.task`, "must be an object");
      assertJsonValue(entry.task, `${path}.task`);
      if (Object.hasOwn(entry.task, "idempotencyKey")) {
        fail(
          `${path}.task.idempotencyKey`,
          "is reserved for namespace ownership",
        );
      }
      const parsed = scheduledTaskInputSchema.safeParse(entry.task);
      if (!parsed.success) {
        fail(
          `${path}.task`,
          `is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      for (const reservedKey of [
        "scenarioManifest",
        "schedulingCreationReceipt",
        "createdAtIso",
      ]) {
        if (
          parsed.data.metadata &&
          Object.hasOwn(parsed.data.metadata, reservedKey)
        ) {
          fail(
            `${path}.task.metadata.${reservedKey}`,
            "is reserved for production scheduling provenance",
          );
        }
      }
      return { id, task: parsed.data as ScheduledTaskInput };
    },
  );
  const notifications = parseArray(
    input.notifications,
    "manifest.notifications",
    (entry, path) => {
      assertKeys(
        entry,
        [
          "id",
          "title",
          "body",
          "category",
          "priority",
          "source",
          "deepLink",
          "icon",
          "groupKey",
          "data",
          "expiresAt",
        ],
        path,
      );
      const category = optionalString(entry.category, `${path}.category`);
      if (
        category !== undefined &&
        !NOTIFICATION_CATEGORIES.has(category as AgentNotification["category"])
      ) {
        fail(`${path}.category`, "is not a notification category");
      }
      const priority = optionalString(entry.priority, `${path}.priority`);
      if (
        priority !== undefined &&
        !NOTIFICATION_PRIORITIES.has(priority as AgentNotification["priority"])
      ) {
        fail(`${path}.priority`, "is not a notification priority");
      }
      return {
        id: requiredString(entry.id, `${path}.id`),
        title: requiredString(entry.title, `${path}.title`),
        body: optionalString(entry.body, `${path}.body`),
        category: category as AgentNotification["category"] | undefined,
        priority: priority as AgentNotification["priority"] | undefined,
        source: optionalString(entry.source, `${path}.source`),
        deepLink: optionalString(entry.deepLink, `${path}.deepLink`),
        icon: optionalString(entry.icon, `${path}.icon`),
        groupKey: optionalString(entry.groupKey, `${path}.groupKey`),
        data: optionalJsonRecord(entry.data, `${path}.data`),
        expiresAt: optionalNullableSafeInteger(
          entry.expiresAt,
          `${path}.expiresAt`,
        ),
      };
    },
  );
  const effectiveNotificationGroups = new Set<string>();
  notifications.forEach((entry, index) => {
    const group = entry.groupKey ?? entry.id;
    if (effectiveNotificationGroups.has(group)) {
      fail(
        `manifest.notifications[${index}].groupKey`,
        `duplicates effective notification group ${group}`,
      );
    }
    effectiveNotificationGroups.add(group);
    const effectivePriority =
      entry.priority ?? (entry.category === "system" ? "low" : "normal");
    if (effectivePriority === "low" && entry.expiresAt === undefined) {
      fail(
        `manifest.notifications[${index}].expiresAt`,
        "is required for low-priority deterministic seed replay",
      );
    }
  });
  const approvals = parseArray(
    input.approvals,
    "manifest.approvals",
    (entry, path) => {
      assertKeys(
        entry,
        [
          "id",
          "subjectEntityId",
          "workflowId",
          "input",
          "channel",
          "reason",
          "expiresAt",
        ],
        path,
      );
      const channel = optionalString(entry.channel, `${path}.channel`);
      if (
        channel !== undefined &&
        !APPROVAL_CHANNELS.has(channel as ApprovalChannel)
      ) {
        fail(`${path}.channel`, "is not an approval channel");
      }
      const approvalInput = jsonRecord(entry.input, `${path}.input`);
      for (const [key, value] of Object.entries(approvalInput)) {
        if (
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          fail(`${path}.input.${key}`, "must be string, number, or boolean");
        }
      }
      if (!Number.isSafeInteger(entry.expiresAt)) {
        fail(`${path}.expiresAt`, "must be a safe integer epoch-millisecond value");
      }
      return {
        id: requiredString(entry.id, `${path}.id`),
        subjectEntityId: requiredString(
          entry.subjectEntityId,
          `${path}.subjectEntityId`,
        ),
        workflowId: requiredString(entry.workflowId, `${path}.workflowId`),
        input: approvalInput as Record<string, string | number | boolean>,
        channel: (channel ?? "internal") as ApprovalChannel,
        reason: requiredString(entry.reason, `${path}.reason`),
        expiresAt: entry.expiresAt as number,
      };
    },
  );
  const providerState = parseArray(
    input.providerState,
    "manifest.providerState",
    (entry, path) => {
      assertKeys(entry, ["id", "key", "value"], path);
      const key = requiredString(entry.key, `${path}.key`);
      if (!key.includes("{{namespace}}")) {
        fail(`${path}.key`, "must contain the literal {{namespace}} token");
      }
      assertJsonValue(entry.value, `${path}.value`);
      return {
        id: requiredString(entry.id, `${path}.id`),
        key,
        value: entry.value as JsonValue,
      };
    },
  );

  assertUniqueIds([
    { path: "manifest.entities", entries: entities },
    { path: "manifest.rooms", entries: rooms },
    { path: "manifest.memories", entries: memories },
    { path: "manifest.relationships", entries: relationships },
    { path: "manifest.tasks", entries: tasks },
    { path: "manifest.schedules", entries: schedules },
    { path: "manifest.notifications", entries: notifications },
    { path: "manifest.approvals", entries: approvals },
    { path: "manifest.providerState", entries: providerState },
  ]);
  const entityIds = new Set(entities.map((entry) => entry.id));
  const roomIds = new Set(rooms.map((entry) => entry.id));
  const requireEntity = (id: string, path: string) => {
    if (!entityIds.has(id)) fail(path, `references unknown entity ${id}`);
  };
  const requireRoom = (id: string, path: string) => {
    if (!roomIds.has(id)) fail(path, `references unknown room ${id}`);
  };
  rooms.forEach((room, roomIndex) => {
    const participantIds = new Set<string>();
    room.participantEntityIds?.forEach((id, participantIndex) => {
      if (participantIds.has(id)) {
        fail(
          `manifest.rooms[${roomIndex}].participantEntityIds[${participantIndex}]`,
          `duplicates participant entity ${id}`,
        );
      }
      participantIds.add(id);
      requireEntity(
        id,
        `manifest.rooms[${roomIndex}].participantEntityIds[${participantIndex}]`,
      );
    });
  });
  memories.forEach((memory, index) => {
    requireRoom(memory.roomId, `manifest.memories[${index}].roomId`);
    requireEntity(memory.entityId, `manifest.memories[${index}].entityId`);
  });
  const pairs = new Set<string>();
  relationships.forEach((relationship, index) => {
    requireEntity(
      relationship.sourceEntityId,
      `manifest.relationships[${index}].sourceEntityId`,
    );
    requireEntity(
      relationship.targetEntityId,
      `manifest.relationships[${index}].targetEntityId`,
    );
    const pair = `${relationship.sourceEntityId}\0${relationship.targetEntityId}`;
    if (pairs.has(pair)) {
      fail(`manifest.relationships[${index}]`, "duplicates an entity pair");
    }
    pairs.add(pair);
  });
  const relationshipIds = new Set(
    relationships.map((relationship) => relationship.id),
  );
  tasks.forEach((task, index) => {
    if (task.roomId)
      requireRoom(task.roomId, `manifest.tasks[${index}].roomId`);
    if (task.entityId) {
      requireEntity(task.entityId, `manifest.tasks[${index}].entityId`);
    }
  });
  approvals.forEach((approval, index) => {
    requireEntity(
      approval.subjectEntityId,
      `manifest.approvals[${index}].subjectEntityId`,
    );
  });
  const earlierScheduleIds = new Set<string>();
  schedules.forEach((schedule, index) => {
    const { task } = schedule;
    if (task.trigger.kind === "after_task") {
      if (!earlierScheduleIds.has(task.trigger.taskId)) {
        fail(
          `manifest.schedules[${index}].task.trigger.taskId`,
          "must reference an earlier manifest schedule logical id",
        );
      }
    }
    for (const [pipelineName, refs] of Object.entries(task.pipeline ?? {})) {
      if (refs && refs.length > 0) {
        fail(
          `manifest.schedules[${index}].task.pipeline.${pipelineName}`,
          "is not supported until pipeline references have an exact receipt contract",
        );
      }
    }
    if (task.subject) {
      if (task.subject.kind === "entity") {
        requireEntity(
          task.subject.id,
          `manifest.schedules[${index}].task.subject.id`,
        );
      } else if (task.subject.kind === "relationship") {
        if (!relationshipIds.has(task.subject.id)) {
          fail(
            `manifest.schedules[${index}].task.subject.id`,
            `references unknown relationship ${task.subject.id}`,
          );
        }
      } else if (task.subject.kind === "self") {
        if (task.subject.id !== "self") {
          fail(
            `manifest.schedules[${index}].task.subject.id`,
            "must equal self for a self subject",
          );
        }
      } else {
        fail(
          `manifest.schedules[${index}].task.subject.kind`,
          "requires an external production-id contract not supported by manifest version 1",
        );
      }
    }
    task.contextRequest?.includeEntities?.entityIds.forEach(
      (id, entityIndex) =>
        requireEntity(
          id,
          `manifest.schedules[${index}].task.contextRequest.includeEntities.entityIds[${entityIndex}]`,
        ),
    );
    task.contextRequest?.includeRelationships?.relationshipIds?.forEach(
      (id, relationshipIndex) => {
        if (!relationshipIds.has(id)) {
          fail(
            `manifest.schedules[${index}].task.contextRequest.includeRelationships.relationshipIds[${relationshipIndex}]`,
            `references unknown relationship ${id}`,
          );
        }
      },
    );
    task.contextRequest?.includeRelationships?.forEntityIds?.forEach(
      (id, entityIndex) =>
        requireEntity(
          id,
          `manifest.schedules[${index}].task.contextRequest.includeRelationships.forEntityIds[${entityIndex}]`,
        ),
    );
    earlierScheduleIds.add(schedule.id);
  });
  const expandedProviderKeys = new Set<string>();
  providerState.forEach((entry, index) => {
    const expanded = entry.key.replaceAll("{{namespace}}", namespace);
    if (expandedProviderKeys.has(expanded)) {
      fail(`manifest.providerState[${index}].key`, "duplicates an expanded key");
    }
    expandedProviderKeys.add(expanded);
  });

  return {
    version: MANIFEST_VERSION,
    namespace,
    ownerAgentId,
    entities,
    rooms,
    memories,
    relationships,
    tasks,
    schedules,
    notifications,
    approvals,
    providerState,
  };
}

function manifestId(namespace: string, kind: string, logicalId: string): UUID {
  return stringToUuid(`scenario-manifest:${namespace}:${kind}:${logicalId}`);
}

function stableValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  throw new Error("value is not JSON serializable");
}

/** Returns stable bytes for hashing and byte-equivalent reset comparisons. */
export function serializeProductionManifestArtifact(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function canonicalDifferencePaths(
  left: unknown,
  right: unknown,
  path = "$",
  differences: string[] = [],
): string[] {
  if (differences.length >= 20) return differences;
  if (Object.is(left, right)) return differences;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) differences.push(`${path}.length`);
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      canonicalDifferencePaths(left[index], right[index], `${path}[${index}]`, differences);
    }
    return differences;
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
        differences.push(`${path}.${key}`);
      } else {
        canonicalDifferencePaths(left[key], right[key], `${path}.${key}`, differences);
      }
    }
    return differences;
  }
  differences.push(path);
  return differences;
}

function hashManifest(manifest: ProductionManifestV1): string {
  return createHash("sha256")
    .update(serializeProductionManifestArtifact(manifest))
    .digest("hex");
}

function hashReceipt(receipt: ProductionManifestReceipt): string {
  return createHash("sha256")
    .update(serializeProductionManifestArtifact(receipt))
    .digest("hex");
}

function emptyReceipt(
  manifest: ProductionManifestV1,
): ProductionManifestReceipt {
  return {
    version: MANIFEST_VERSION,
    namespace: manifest.namespace,
    ownerAgentId: manifest.ownerAgentId,
    manifestSha256: hashManifest(manifest),
    worldId: manifestId(manifest.namespace, "world", manifest.namespace),
    entityIds: [],
    roomIds: [],
    participantPairs: [],
    memoryIds: [],
    memoryTableNames: [],
    relationshipIds: [],
    taskIds: [],
    scheduleIds: [],
    notificationIds: [],
    approvalRecords: [],
    providerStateKeys: [],
  };
}

function requiredUuid(value: unknown, path: string): UUID {
  const parsed = requiredString(value, path);
  if (!UUID_PATTERN.test(parsed)) fail(path, "must be a UUID");
  return parsed.toLowerCase() as UUID;
}

function uuidArray(value: unknown, path: string): UUID[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  assertDenseArrayShape(value, path);
  const parsed: UUID[] = [];
  for (let index = 0; index < value.length; index += 1) {
    parsed.push(requiredUuid(value[index], `${path}[${index}]`));
  }
  const seen = new Set<UUID>();
  parsed.forEach((id, index) => {
    if (seen.has(id)) fail(`${path}[${index}]`, `duplicates UUID ${id}`);
    seen.add(id);
  });
  return parsed;
}

function uniqueStringArray(value: unknown, path: string): string[] {
  const parsed = stringArray(value, path);
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    if (seen.has(entry)) fail(`${path}[${index}]`, `duplicates ${entry}`);
    seen.add(entry);
  });
  return parsed;
}

/** Parses an untrusted serialized reset receipt without preserving aliases. */
export function parseProductionManifestReceipt(
  input: unknown,
): ProductionManifestReceipt {
  if (!isRecord(input)) fail("receipt", "must be an object");
  assertExactKeys(
    input,
    [
      "version",
      "namespace",
      "ownerAgentId",
      "manifestSha256",
      "worldId",
      "entityIds",
      "roomIds",
      "participantPairs",
      "memoryIds",
      "memoryTableNames",
      "relationshipIds",
      "taskIds",
      "scheduleIds",
      "notificationIds",
      "approvalRecords",
      "providerStateKeys",
    ],
    "receipt",
  );
  if (input.version !== MANIFEST_VERSION) {
    fail("receipt.version", `must equal ${MANIFEST_VERSION}`);
  }
  const namespace = requiredString(input.namespace, "receipt.namespace");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(namespace)) {
    fail("receipt.namespace", "contains unsupported characters");
  }
  const manifestSha256 = requiredString(
    input.manifestSha256,
    "receipt.manifestSha256",
  );
  if (!SHA256_PATTERN.test(manifestSha256)) {
    fail("receipt.manifestSha256", "must be a 64-character hexadecimal hash");
  }
  const ownerAgentId = requiredUuid(input.ownerAgentId, "receipt.ownerAgentId");
  const worldId = requiredUuid(input.worldId, "receipt.worldId");
  const entityIds = uuidArray(input.entityIds, "receipt.entityIds");
  const roomIds = uuidArray(input.roomIds, "receipt.roomIds");
  const memoryIds = uuidArray(input.memoryIds, "receipt.memoryIds");
  const memoryTableNames = stringArray(
    input.memoryTableNames,
    "receipt.memoryTableNames",
  );
  if (memoryTableNames.length !== memoryIds.length) {
    fail("receipt.memoryTableNames", "must align one-for-one with memoryIds");
  }
  memoryTableNames.forEach((tableName, index) => {
    if (!MEMORY_TABLE_PATTERN.test(tableName)) {
      fail(`receipt.memoryTableNames[${index}]`, "is not a safe memory table name");
    }
  });
  const relationshipIds = uuidArray(
    input.relationshipIds,
    "receipt.relationshipIds",
  );
  const taskIds = uuidArray(input.taskIds, "receipt.taskIds");
  const scheduleIds = uniqueStringArray(input.scheduleIds, "receipt.scheduleIds");
  const notificationIds = uuidArray(
    input.notificationIds,
    "receipt.notificationIds",
  );
  const providerStateKeys = uniqueStringArray(
    input.providerStateKeys,
    "receipt.providerStateKeys",
  );
  if (!Array.isArray(input.approvalRecords)) {
    fail("receipt.approvalRecords", "must be an array");
  }
  assertDenseArrayShape(input.approvalRecords, "receipt.approvalRecords");
  const approvalIds = new Set<string>();
  const approvalRecords: Array<{ id: string; subjectUserId: string }> = [];
  input.approvalRecords.forEach((entry, index) => {
    const path = `receipt.approvalRecords[${index}]`;
    if (!isRecord(entry)) fail(path, "must be an object");
    assertExactKeys(entry, ["id", "subjectUserId"], path);
    const id = requiredString(entry.id, `${path}.id`);
    if (approvalIds.has(id)) fail(`${path}.id`, `duplicates ${id}`);
    approvalIds.add(id);
    approvalRecords.push({
      id,
      subjectUserId: requiredString(
        entry.subjectUserId,
        `${path}.subjectUserId`,
      ),
    });
  });
  if (!Array.isArray(input.participantPairs)) {
    fail("receipt.participantPairs", "must be an array");
  }
  assertDenseArrayShape(input.participantPairs, "receipt.participantPairs");
  const entityIdSet = new Set(entityIds);
  const roomIdSet = new Set(roomIds);
  const pairKeys = new Set<string>();
  const participantPairs: Array<{ entityId: UUID; roomId: UUID }> = [];
  for (let index = 0; index < input.participantPairs.length; index += 1) {
    const path = `receipt.participantPairs[${index}]`;
    const entry = input.participantPairs[index];
    if (!isRecord(entry)) fail(path, "must be an object");
    assertExactKeys(entry, ["entityId", "roomId"], path);
    const entityId = requiredUuid(entry.entityId, `${path}.entityId`);
    const roomId = requiredUuid(entry.roomId, `${path}.roomId`);
    if (!entityIdSet.has(entityId)) {
      fail(`${path}.entityId`, "must be contained in receipt.entityIds");
    }
    if (!roomIdSet.has(roomId)) {
      fail(`${path}.roomId`, "must be contained in receipt.roomIds");
    }
    const pairKey = `${entityId}\0${roomId}`;
    if (pairKeys.has(pairKey)) fail(path, "duplicates a participant pair");
    pairKeys.add(pairKey);
    participantPairs.push({ entityId, roomId });
  }
  const allRecordIds = [
    worldId,
    ...entityIds,
    ...roomIds,
    ...memoryIds,
    ...relationshipIds,
    ...taskIds,
    ...notificationIds,
  ];
  if (new Set(allRecordIds).size !== allRecordIds.length) {
    fail("receipt", "must not repeat UUIDs across record categories");
  }
  return {
    version: MANIFEST_VERSION,
    namespace,
    ownerAgentId,
    manifestSha256: manifestSha256.toLowerCase(),
    worldId,
    entityIds,
    roomIds,
    participantPairs,
    memoryIds,
    memoryTableNames,
    relationshipIds,
    taskIds,
    scheduleIds,
    notificationIds,
    approvalRecords,
    providerStateKeys,
  };
}

function assertReceiptOwner(
  runtime: IAgentRuntime,
  receipt: ProductionManifestReceipt,
): void {
  if (receipt.ownerAgentId !== runtime.agentId.toLowerCase()) {
    throw new ProductionManifestApplyError(
      "[production-manifest] receipt owner does not match runtime agent",
      "SCENARIO_MANIFEST_WRONG_OWNER",
    );
  }
}

function notificationService(runtime: IAgentRuntime): NotificationService {
  const service = runtime.getService(ServiceType.NOTIFICATION);
  if (!(service instanceof NotificationService)) {
    throw new ProductionManifestApplyError(
      "[production-manifest] NotificationService is not registered",
      "SCENARIO_MANIFEST_SERVICE_UNAVAILABLE",
    );
  }
  return service;
}

function approvalQueue(runtime: IAgentRuntime): ApprovalQueue {
  const service = resolveApprovalService(runtime);
  if (!service) {
    throw new ProductionManifestApplyError(
      "[production-manifest] durable ApprovalService is not registered",
      "SCENARIO_MANIFEST_SERVICE_UNAVAILABLE",
    );
  }
  return service.getQueue(runtime.agentId);
}

function providerStateKey(namespace: string, template: string): string {
  return template.replaceAll("{{namespace}}", namespace);
}

function scheduleIdempotencyKey(namespace: string, logicalId: string): string {
  return `scenario-manifest:${namespace}:schedule:${logicalId}`;
}

function approvalIdempotencyKey(namespace: string, logicalId: string): string {
  return `scenario-manifest:${namespace}:approval:${logicalId}`;
}

function approvalRequestedBy(namespace: string, logicalId: string): string {
  return `scenario-manifest:${namespace}:${logicalId}`;
}

function requiredLogicalReference(
  references: ReadonlyMap<string, string>,
  logicalId: string,
  kind: string,
): string {
  const productionId = references.get(logicalId);
  if (!productionId) {
    throw new Error(`validated ${kind} ${logicalId} was not resolved`);
  }
  return productionId;
}

function materializeScheduledTask(
  task: ScheduledTaskInput,
  entityIds: ReadonlyMap<string, UUID>,
  relationshipIds: ReadonlyMap<string, UUID>,
  scheduleIds: ReadonlyMap<string, string>,
): ScheduledTaskInput {
  const trigger =
    task.trigger.kind === "after_task"
      ? {
          ...task.trigger,
          taskId: requiredLogicalReference(
            scheduleIds,
            task.trigger.taskId,
            "earlier schedule",
          ),
        }
      : task.trigger;
  const subject = task.subject
    ? task.subject.kind === "entity"
      ? {
          ...task.subject,
          id: requiredLogicalReference(entityIds, task.subject.id, "entity"),
        }
      : task.subject.kind === "relationship"
        ? {
            ...task.subject,
            id: requiredLogicalReference(
              relationshipIds,
              task.subject.id,
              "relationship",
            ),
          }
        : task.subject
    : undefined;
  const contextRequest = task.contextRequest
    ? {
        ...task.contextRequest,
        includeEntities: task.contextRequest.includeEntities
          ? {
              ...task.contextRequest.includeEntities,
              entityIds: task.contextRequest.includeEntities.entityIds.map(
                (id) => requiredLogicalReference(entityIds, id, "entity"),
              ),
            }
          : undefined,
        includeRelationships: task.contextRequest.includeRelationships
          ? {
              ...task.contextRequest.includeRelationships,
              relationshipIds:
                task.contextRequest.includeRelationships.relationshipIds?.map(
                  (id) =>
                    requiredLogicalReference(
                      relationshipIds,
                      id,
                      "relationship",
                    ),
                ),
              forEntityIds:
                task.contextRequest.includeRelationships.forEntityIds?.map(
                  (id) => requiredLogicalReference(entityIds, id, "entity"),
                ),
            }
          : undefined,
      }
    : undefined;
  return { ...task, trigger, subject, contextRequest };
}

function materializeScheduleTask(
  task: ScheduledTaskInput,
  entityIds: ReadonlyMap<string, UUID>,
  relationshipIds: ReadonlyMap<string, UUID>,
  scheduleIds: ReadonlyMap<string, string>,
): ScheduledTaskInput {
  const trigger =
    task.trigger.kind === "after_task"
      ? {
          ...task.trigger,
          taskId: scheduleIds.get(task.trigger.taskId) as string,
        }
      : task.trigger;
  const subject = task.subject
    ? task.subject.kind === "entity"
      ? { ...task.subject, id: entityIds.get(task.subject.id) as UUID }
      : task.subject.kind === "relationship"
        ? {
            ...task.subject,
            id: relationshipIds.get(task.subject.id) as UUID,
          }
        : task.subject
    : undefined;
  const contextRequest = task.contextRequest
    ? {
        ...task.contextRequest,
        includeEntities: task.contextRequest.includeEntities
          ? {
              ...task.contextRequest.includeEntities,
              entityIds: task.contextRequest.includeEntities.entityIds.map(
                (id) => entityIds.get(id) as UUID,
              ),
            }
          : undefined,
        includeRelationships: task.contextRequest.includeRelationships
          ? {
              ...task.contextRequest.includeRelationships,
              relationshipIds:
                task.contextRequest.includeRelationships.relationshipIds?.map(
                  (id) => relationshipIds.get(id) as UUID,
                ),
            }
          : undefined,
      }
    : undefined;
  return { ...task, trigger, subject, contextRequest };
}

async function assertTargetsAbsent(
  runtime: IAgentRuntime,
  receipt: ProductionManifestReceipt,
): Promise<void> {
  const [worlds, entities, rooms, memories, tasks] = await Promise.all([
    runtime.getWorldsByIds([receipt.worldId]),
    runtime.getEntitiesByIds(receipt.entityIds),
    runtime.getRoomsByIds(receipt.roomIds),
    runtime.getMemoriesByIds(receipt.memoryIds),
    runtime.getTasksByIds(receipt.taskIds),
  ]);
  const existing = [
    ...worlds.map((entry) => `world:${entry.id}`),
    ...entities.map((entry) => `entity:${entry.id ?? "unknown"}`),
    ...rooms.map((entry) => `room:${entry.id}`),
    ...memories.map((entry) => `memory:${entry.id ?? "unknown"}`),
    ...tasks.map((entry) => `task:${entry.id ?? "unknown"}`),
  ];
  if (existing.length > 0) {
    throw new ProductionManifestApplyError(
      `[production-manifest] namespace ${receipt.namespace} is not empty: ${existing.join(", ")}`,
      "SCENARIO_MANIFEST_NAMESPACE_NOT_EMPTY",
    );
  }
  for (const key of receipt.providerStateKeys) {
    if ((await runtime.getCache<JsonValue>(key)) !== undefined) {
      throw new ProductionManifestApplyError(
        `[production-manifest] provider state key is not empty: ${key}`,
        "SCENARIO_MANIFEST_NAMESPACE_NOT_EMPTY",
      );
    }
  }
}

async function discoverManifestSideEffects(
  runtime: IAgentRuntime,
  manifest: ProductionManifestV1,
  receipt: ProductionManifestReceipt,
  scheduledRunner: ScheduledTaskRunner | null,
  notifications: NotificationService | null,
  approvals: ApprovalQueue | null,
): Promise<void> {
  const relationshipEntries = manifest.relationships ?? [];
  if (relationshipEntries.length > 0) {
    const rows = await runtime.getRelationshipsByPairs(
      relationshipEntries.map((entry) => ({
        sourceEntityId: manifestId(
          manifest.namespace,
          "entity",
          entry.sourceEntityId,
        ),
        targetEntityId: manifestId(
          manifest.namespace,
          "entity",
          entry.targetEntityId,
        ),
      })),
    );
    for (const [index, row] of rows.entries()) {
      if (!row) continue;
      const expected = relationshipEntries[index];
      const logicalId = logicalIdFromScenarioMarker(
        row.metadata,
        manifest.namespace,
      );
      if (!expected || logicalId !== expected.id) {
        throw new Error(
          `relationship pair ${index} is occupied without exact manifest provenance`,
        );
      }
      if (!receipt.relationshipIds.includes(row.id)) {
        receipt.relationshipIds.push(row.id);
      }
    }
  }
  if (scheduledRunner) {
    const rows = await scheduledRunner.list({});
    for (const entry of manifest.schedules ?? []) {
      const key = scheduleIdempotencyKey(manifest.namespace, entry.id);
      const matches = rows.filter((row) => row.idempotencyKey === key);
      if (matches.length > 1) {
        throw new Error(`multiple scheduled rows discovered for ${entry.id}`);
      }
      const discovered = matches[0];
      if (discovered && !receipt.scheduleIds.includes(discovered.taskId)) {
        receipt.scheduleIds.push(discovered.taskId);
      }
    }
  }

  if (approvals) {
    for (const entry of manifest.approvals ?? []) {
      const subjectUserId = manifestId(
        manifest.namespace,
        "entity",
        entry.subjectEntityId,
      );
      const discovered = await approvals.byIdempotencyKey(
        approvalIdempotencyKey(manifest.namespace, entry.id),
        subjectUserId,
      );
      if (
        discovered &&
        !receipt.approvalRecords.some((record) => record.id === discovered.id)
      ) {
        receipt.approvalRecords.push({ id: discovered.id, subjectUserId });
      }
    }
  }

  if (notifications) {
    const rows = notifications.listIncludingExpired();
    const expectedGroups = [
      ...(manifest.notifications ?? []).map(
        (entry) =>
          `scenario-manifest:${manifest.namespace}:${entry.groupKey ?? entry.id}`,
      ),
      ...receipt.approvalRecords.map((record) => `approval:${record.id}`),
    ];
    for (const groupKey of expectedGroups) {
      const matches = rows.filter((row) => row.groupKey === groupKey);
      if (matches.length > 1) {
        throw new Error(
          `multiple notification rows discovered for group ${groupKey}`,
        );
      }
      const discovered = matches[0];
      if (discovered && !receipt.notificationIds.includes(discovered.id)) {
        receipt.notificationIds.push(discovered.id);
      }
    }
  }
}

/** Applies a validated plan only through the runtime's production stores. */
export async function applyProductionManifest(
  runtime: IAgentRuntime,
  input: unknown,
): Promise<ProductionManifestReceipt> {
  const manifest = parseProductionManifest(input);
  if (manifest.ownerAgentId !== runtime.agentId) {
    throw new ProductionManifestApplyError(
      `[production-manifest] owner ${manifest.ownerAgentId} does not match runtime agent ${runtime.agentId}`,
      "SCENARIO_MANIFEST_WRONG_OWNER",
    );
  }
  const applyNow = Date.now();
  for (const [index, entry] of (manifest.notifications ?? []).entries()) {
    if (entry.expiresAt !== null && entry.expiresAt !== undefined && entry.expiresAt <= applyNow) {
      fail(
        `manifest.notifications[${index}].expiresAt`,
        "must be later than the captured apply time",
      );
    }
  }
  for (const [index, entry] of (manifest.approvals ?? []).entries()) {
    if (entry.expiresAt <= applyNow) {
      fail(
        `manifest.approvals[${index}].expiresAt`,
        "must be later than the captured apply time",
      );
    }
  }
  const receipt = emptyReceipt(manifest);
  receipt.entityIds =
    manifest.entities?.map((entry) =>
      manifestId(manifest.namespace, "entity", entry.id),
    ) ?? [];
  receipt.roomIds =
    manifest.rooms?.map((entry) =>
      manifestId(manifest.namespace, "room", entry.id),
    ) ?? [];
  receipt.memoryIds =
    manifest.memories?.map((entry) =>
      manifestId(manifest.namespace, "memory", entry.id),
    ) ?? [];
  receipt.memoryTableNames = (manifest.memories ?? []).map(
    (entry) => entry.tableName ?? "messages",
  );
  receipt.taskIds =
    manifest.tasks?.map((entry) =>
      manifestId(manifest.namespace, "task", entry.id),
    ) ?? [];
  receipt.providerStateKeys = (manifest.providerState ?? []).map((entry) =>
    providerStateKey(manifest.namespace, entry.key),
  );
  await assertTargetsAbsent(runtime, receipt);
  const existingRelationshipPairs = await runtime.getRelationshipsByPairs(
    (manifest.relationships ?? []).map((entry) => ({
      sourceEntityId: manifestId(
        manifest.namespace,
        "entity",
        entry.sourceEntityId,
      ),
      targetEntityId: manifestId(
        manifest.namespace,
        "entity",
        entry.targetEntityId,
      ),
    })),
  );
  if (existingRelationshipPairs.some((entry) => entry !== null)) {
    throw new ProductionManifestApplyError(
      `[production-manifest] namespace ${receipt.namespace} has an occupied relationship pair`,
      "SCENARIO_MANIFEST_NAMESPACE_NOT_EMPTY",
    );
  }

  const scheduledRunner =
    (manifest.schedules?.length ?? 0) > 0
      ? getScheduledTaskRunner(runtime, { agentId: runtime.agentId })
      : null;
  const notifications =
    (manifest.notifications?.length ?? 0) > 0 ||
    (manifest.approvals?.length ?? 0) > 0
      ? notificationService(runtime)
      : null;
  const approvals =
    (manifest.approvals?.length ?? 0) > 0 ? approvalQueue(runtime) : null;
  if (scheduledRunner) {
    const existingSchedules = await scheduledRunner.list({});
    const requestedKeys = new Set(
      (manifest.schedules ?? []).map((entry) =>
        scheduleIdempotencyKey(manifest.namespace, entry.id),
      ),
    );
    if (
      existingSchedules.some(
        (task) =>
          task.idempotencyKey && requestedKeys.has(task.idempotencyKey),
      )
    ) {
      throw new ProductionManifestApplyError(
        `[production-manifest] namespace ${manifest.namespace} already has scheduled items`,
        "SCENARIO_MANIFEST_NAMESPACE_NOT_EMPTY",
      );
    }
  }
  if (notifications) {
    const namespacePrefix = `scenario-manifest:${manifest.namespace}:`;
    if (
      notifications
        .list()
        .some((entry) => entry.groupKey?.startsWith(namespacePrefix))
    ) {
      throw new ProductionManifestApplyError(
        `[production-manifest] namespace ${manifest.namespace} already has notifications`,
        "SCENARIO_MANIFEST_NAMESPACE_NOT_EMPTY",
      );
    }
  }
  if (approvals) {
    for (const entry of manifest.approvals ?? []) {
      const subjectUserId = manifestId(
        manifest.namespace,
        "entity",
        entry.subjectEntityId,
      );
      const existing = await approvals.byIdempotencyKey(
        approvalIdempotencyKey(manifest.namespace, entry.id),
        subjectUserId,
      );
      if (existing) {
        throw new ProductionManifestApplyError(
          `[production-manifest] namespace ${manifest.namespace} already has approval ${entry.id}`,
          "SCENARIO_MANIFEST_NAMESPACE_NOT_EMPTY",
        );
      }
    }
  }

  const entityIds = new Map(
    (manifest.entities ?? []).map((entry, index) => [
      entry.id,
      receipt.entityIds[index],
    ]),
  );
  const roomIds = new Map(
    (manifest.rooms ?? []).map((entry, index) => [
      entry.id,
      receipt.roomIds[index],
    ]),
  );
  const world = {
    id: receipt.worldId,
    name: `Scenario ${manifest.namespace}`,
    agentId: runtime.agentId,
    metadata: {
      type: "scenario-manifest",
      ownership: { ownerId: runtime.agentId },
      extra: {
        namespace: manifest.namespace,
        manifestSha256: receipt.manifestSha256,
      },
    },
  };
  try {
    await runtime.createWorld(world);
    await runtime.createEntities(
      (manifest.entities ?? []).map((entry, index) => ({
        id: receipt.entityIds[index],
        names: entry.names,
        metadata: {
          ...entry.metadata,
          scenarioManifest: {
            namespace: manifest.namespace,
            logicalId: entry.id,
          },
        },
        agentId: runtime.agentId,
      })),
    );
    await runtime.createRooms(
      (manifest.rooms ?? []).map((entry, index) => ({
        id: receipt.roomIds[index],
        name: entry.name,
        source: entry.source,
        type: entry.type,
        worldId: receipt.worldId,
        agentId: runtime.agentId,
        metadata: {
          scenarioManifest: {
            namespace: manifest.namespace,
            logicalId: entry.id,
          },
        },
      })),
    );
    for (const room of manifest.rooms ?? []) {
      const roomId = roomIds.get(room.id);
      if (!roomId)
        throw new Error(`validated room ${room.id} was not resolved`);
      for (const logicalEntityId of room.participantEntityIds ?? []) {
        const entityId = entityIds.get(logicalEntityId);
        if (!entityId)
          throw new Error(
            `validated entity ${logicalEntityId} was not resolved`,
          );
        await runtime.addParticipant(entityId, roomId);
        receipt.participantPairs.push({ entityId, roomId });
      }
    }
    await runtime.createMemories(
      (manifest.memories ?? []).map((entry, index) => ({
        memory: {
          id: receipt.memoryIds[index],
          roomId: roomIds.get(entry.roomId) as UUID,
          entityId: entityIds.get(entry.entityId) as UUID,
          agentId: runtime.agentId,
          worldId: receipt.worldId,
          content: { text: entry.text },
          metadata: {
            ...entry.metadata,
            scenarioManifest: {
              namespace: manifest.namespace,
              logicalId: entry.id,
              tableName: entry.tableName ?? "messages",
            },
          },
        },
        tableName: entry.tableName ?? "messages",
      })),
    );
    const relationshipWrites = (manifest.relationships ?? []).map((entry) => ({
      sourceEntityId: entityIds.get(entry.sourceEntityId) as UUID,
      targetEntityId: entityIds.get(entry.targetEntityId) as UUID,
      tags: entry.tags,
      metadata: {
        ...entry.metadata,
        scenarioManifest: {
          namespace: manifest.namespace,
          logicalId: entry.id,
        },
      },
    }));
    receipt.relationshipIds = await runtime.createRelationships(
      relationshipWrites,
    );
    if (receipt.relationshipIds.length !== relationshipWrites.length) {
      throw new Error(
        "relationship write did not return one production ID per requested pair",
      );
    }
    const relationshipReadback = await runtime.getRelationshipsByPairs(
      relationshipWrites.map(({ sourceEntityId, targetEntityId }) => ({
        sourceEntityId,
        targetEntityId,
      })),
    );
    if (relationshipReadback.some((entry) => entry === null)) {
      throw new Error(
        "relationship write was not visible on authoritative readback",
      );
    }
    const readbackIds = relationshipReadback.map(
      (entry) => (entry as NonNullable<typeof entry>).id,
    );
    if (
      readbackIds.some(
        (id, index) => id !== receipt.relationshipIds[index],
      )
    ) {
      throw new Error(
        "relationship write IDs did not match authoritative pair readback",
      );
    }
    const relationshipIds = new Map(
      (manifest.relationships ?? []).map((entry, index) => [
        entry.id,
        receipt.relationshipIds[index],
      ]),
    );
    await runtime.createTasks(
      (manifest.tasks ?? []).map((entry, index) => ({
        id: receipt.taskIds[index],
        name: entry.name,
        description: entry.description,
        roomId: entry.roomId ? roomIds.get(entry.roomId) : undefined,
        entityId: entry.entityId ? entityIds.get(entry.entityId) : undefined,
        worldId: receipt.worldId,
        agentId: runtime.agentId,
        tags: entry.tags,
        dueAt: entry.dueAt,
        metadata: {
          ...entry.metadata,
          scenarioManifest: {
            namespace: manifest.namespace,
            logicalId: entry.id,
          },
        },
      })),
    );
    const scheduleIds = new Map<string, string>();
    for (const entry of manifest.schedules ?? []) {
      if (!scheduledRunner) throw new Error("scheduled runner was not resolved");
      const materializedTask = materializeScheduleTask(
        entry.task,
        entityIds,
        relationshipIds,
        scheduleIds,
      );
      const result = await scheduledRunner.scheduleWithResult({
        ...materializedTask,
        idempotencyKey: scheduleIdempotencyKey(manifest.namespace, entry.id),
        metadata: {
          ...(materializedTask.metadata ?? {}),
          scenarioManifest: {
            namespace: manifest.namespace,
            logicalId: entry.id,
          },
        },
      });
      if (result.replayed) {
        throw new Error(`scheduled item ${entry.id} unexpectedly replayed`);
      }
      receipt.scheduleIds.push(result.task.taskId);
      scheduleIds.set(entry.id, result.task.taskId);
    }
    for (const entry of manifest.approvals ?? []) {
      if (!approvals || !notifications) {
        throw new Error("approval services were not resolved");
      }
      const subjectUserId = entityIds.get(entry.subjectEntityId);
      if (!subjectUserId) {
        throw new Error(`validated entity ${entry.subjectEntityId} was not resolved`);
      }
      const payload: ApprovalPayload = {
        action: "execute_workflow",
        workflowId: entry.workflowId,
        input: entry.input,
      };
      if (!approvals.enqueueWithResultAndNotification) {
        throw new Error(
          "approval queue lacks the awaited notification projection boundary",
        );
      }
      const result = await approvals.enqueueWithResultAndNotification({
        requestedBy: approvalRequestedBy(manifest.namespace, entry.id),
        subjectUserId,
        action: "execute_workflow" satisfies ApprovalAction,
        payload,
        channel: entry.channel ?? "internal",
        reason: entry.reason,
        idempotencyKey: approvalIdempotencyKey(manifest.namespace, entry.id),
        expiresAt: new Date(entry.expiresAt),
      });
      if (result.reused) {
        throw new Error(`approval ${entry.id} unexpectedly replayed`);
      }
      receipt.approvalRecords.push({ id: result.request.id, subjectUserId });
      const approvalNotification = notifications
        .list()
        .find((item) => item.groupKey === `approval:${result.request.id}`);
      if (!approvalNotification) {
        throw new Error(
          `approval ${entry.id} notification was not visible on authoritative readback`,
        );
      }
      receipt.notificationIds.push(approvalNotification.id);
    }
    for (const entry of manifest.notifications ?? []) {
      if (!notifications) throw new Error("notification service was not resolved");
      if (
        entry.expiresAt !== null &&
        entry.expiresAt !== undefined &&
        entry.expiresAt <= Date.now()
      ) {
        throw new Error(`notification ${entry.id} expired before persistence`);
      }
      const notification = await notifications.notify({
        title: entry.title,
        body: entry.body,
        category: entry.category,
        priority: entry.priority,
        source: entry.source,
        deepLink: entry.deepLink,
        icon: entry.icon,
        groupKey: `scenario-manifest:${manifest.namespace}:${entry.groupKey ?? entry.id}`,
        data: {
          ...(entry.data ?? {}),
          scenarioManifest: {
            namespace: manifest.namespace,
            logicalId: entry.id,
          },
        },
        expiresAt: entry.expiresAt,
        agentId: runtime.agentId,
      });
      receipt.notificationIds.push(notification.id);
    }
    for (const [index, entry] of (manifest.providerState ?? []).entries()) {
      const key = receipt.providerStateKeys[index];
      if (!key) throw new Error(`provider state ${entry.id} key was not resolved`);
      const written = await runtime.setCache(key, entry.value);
      if (!written) throw new Error(`provider state ${entry.id} was not persisted`);
    }
    await runtime.updateWorld({
      ...world,
      metadata: {
        ...world.metadata,
        extra: {
          ...world.metadata.extra,
          receiptSha256: hashReceipt(receipt),
        },
      },
    });
    return receipt;
  } catch (cause) {
    try {
      await discoverManifestSideEffects(
        runtime,
        manifest,
        receipt,
        scheduledRunner,
        notifications,
        approvals,
      );
    } catch (discoveryCause) {
      let rollbackCause: unknown;
      try {
        await resetRecordedManifestWrites(runtime, receipt);
      } catch (error) {
        rollbackCause = error;
      }
      throw new ProductionManifestApplyError(
        "[production-manifest] apply outcome is ambiguous and namespace side effects could not be enumerated",
        "SCENARIO_MANIFEST_DIRTY",
        {
          cause: new AggregateError(
            rollbackCause
              ? [cause, discoveryCause, rollbackCause]
              : [cause, discoveryCause],
          ),
          dirtyReceipt: receipt,
        },
      );
    }
    try {
      await resetRecordedManifestWrites(runtime, receipt);
    } catch (rollbackCause) {
      throw new ProductionManifestApplyError(
        "[production-manifest] apply failed and compensation could not prove a clean namespace",
        "SCENARIO_MANIFEST_DIRTY",
        {
          cause: new AggregateError([cause, rollbackCause]),
          dirtyReceipt: receipt,
        },
      );
    }
    throw new ProductionManifestApplyError(
      "[production-manifest] apply failed; all recorded writes were compensated",
      "SCENARIO_MANIFEST_APPLY_FAILED",
      { cause },
    );
  }
}

function metadataWithoutScenarioMarker(value: unknown): JsonValue | null {
  if (!isRecord(value)) return null;
  const { scenarioManifest: _scenarioManifest, ...rest } = value;
  return Object.keys(rest).length === 0 ? null : stableValue(rest);
}

function logicalIdFromScenarioMarker(
  value: unknown,
  namespace: string,
): string | null {
  if (!isRecord(value) || !isRecord(value.scenarioManifest)) return null;
  return value.scenarioManifest.namespace === namespace &&
    typeof value.scenarioManifest.logicalId === "string"
    ? value.scenarioManifest.logicalId
    : null;
}

function approvalLogicalId(request: ApprovalRequest, namespace: string): string | null {
  const prefix = `scenario-manifest:${namespace}:`;
  return request.requestedBy.startsWith(prefix)
    ? request.requestedBy.slice(prefix.length)
    : null;
}

/** Reads only authoritative records named by a serialized apply receipt. */
export async function readProductionManifestSnapshot(
  runtime: IAgentRuntime,
  input: unknown,
): Promise<ProductionManifestSnapshot> {
  const receipt = parseProductionManifestReceipt(input);
  assertReceiptOwner(runtime, receipt);
  await assertReceiptProvenance(runtime, receipt);
  const [
    worlds,
    entities,
    rooms,
    memories,
    relationships,
    tasks,
    participants,
    scheduleRows,
    notificationRows,
    approvalRows,
    providerStateRows,
  ] = await Promise.all([
    runtime.getWorldsByIds([receipt.worldId]),
    runtime.getEntitiesByIds(receipt.entityIds),
    runtime.getRoomsByIds(receipt.roomIds),
    runtime.getMemoriesByIds(receipt.memoryIds),
    runtime.getRelationshipsByIds(receipt.relationshipIds),
    runtime.getTasksByIds(receipt.taskIds),
    runtime.getParticipantsForRooms(receipt.roomIds),
    receipt.scheduleIds.length > 0
      ? getScheduledTaskRunner(runtime, { agentId: runtime.agentId }).list({})
      : Promise.resolve([] as ScheduledTask[]),
    receipt.notificationIds.length > 0
      ? Promise.resolve(notificationService(runtime).listIncludingExpired())
      : Promise.resolve([] as AgentNotification[]),
    receipt.approvalRecords.length > 0
      ? Promise.all(
          receipt.approvalRecords.map((record) =>
            approvalQueue(runtime).byId(record.id, record.subjectUserId),
          ),
        )
      : Promise.resolve([] as Array<ApprovalRequest | null>),
    Promise.all(
      receipt.providerStateKeys.map((key) => runtime.getCache<JsonValue>(key)),
    ),
  ]);
  const schedules = scheduleRows.filter((entry) =>
    receipt.scheduleIds.includes(entry.taskId),
  );
  const notifications = notificationRows.filter((entry) =>
    receipt.notificationIds.includes(entry.id),
  );
  const approvals = approvalRows.filter(
    (entry): entry is ApprovalRequest => entry !== null,
  );
  if (
    worlds.length !== 1 ||
    entities.length !== receipt.entityIds.length ||
    rooms.length !== receipt.roomIds.length ||
    memories.length !== receipt.memoryIds.length ||
    relationships.length !== receipt.relationshipIds.length ||
    tasks.length !== receipt.taskIds.length
    || schedules.length !== receipt.scheduleIds.length
    || notifications.length !== receipt.notificationIds.length
    || approvals.length !== receipt.approvalRecords.length
    || providerStateRows.some((entry) => entry === undefined)
  ) {
    const counts = {
      worlds: `${worlds.length}/1`,
      entities: `${entities.length}/${receipt.entityIds.length}`,
      rooms: `${rooms.length}/${receipt.roomIds.length}`,
      memories: `${memories.length}/${receipt.memoryIds.length}`,
      relationships: `${relationships.length}/${receipt.relationshipIds.length}`,
      tasks: `${tasks.length}/${receipt.taskIds.length}`,
      schedules: `${schedules.length}/${receipt.scheduleIds.length}`,
      notifications: `${notifications.length}/${receipt.notificationIds.length}`,
      approvals: `${approvals.length}/${receipt.approvalRecords.length}`,
      providerState: `${providerStateRows.filter((entry) => entry !== undefined).length}/${receipt.providerStateKeys.length}`,
    };
    throw new ProductionManifestApplyError(
      `[production-manifest] authoritative readback is incomplete: ${JSON.stringify(counts)}`,
      "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
      { dirtyReceipt: receipt },
    );
  }
  const world = worlds[0];
  for (const memory of memories) {
    if (typeof memory.content.text !== "string") {
      throw new ProductionManifestApplyError(
        `[production-manifest] authoritative memory ${memory.id ?? "unknown"} is missing required text`,
        "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
        { dirtyReceipt: receipt },
      );
    }
  }
  const entityLogicalIds = new Map(
    entities.map((entry) => {
      const logicalId = logicalIdFromScenarioMarker(
        entry.metadata,
        receipt.namespace,
      );
      if (!logicalId) {
        throw new ProductionManifestApplyError(
          `[production-manifest] entity ${entry.id ?? "unknown"} lacks namespace provenance`,
          "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
          { dirtyReceipt: receipt },
        );
      }
      return [entry.id as string, logicalId] as const;
    }),
  );
  const relationshipLogicalIds = new Map(
    relationships.map((entry) => {
      const logicalId = logicalIdFromScenarioMarker(
        entry.metadata,
        receipt.namespace,
      );
      if (!logicalId) {
        throw new ProductionManifestApplyError(
          `[production-manifest] relationship ${entry.id} lacks namespace provenance`,
          "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
          { dirtyReceipt: receipt },
        );
      }
      return [entry.id, logicalId] as const;
    }),
  );
  const scheduleLogicalIds = new Map(
    schedules.map((entry) => {
      const logicalId = logicalIdFromScenarioMarker(
        entry.metadata,
        receipt.namespace,
      );
      if (!logicalId) {
        throw new ProductionManifestApplyError(
          `[production-manifest] scheduled item ${entry.taskId} lacks namespace provenance`,
          "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
          { dirtyReceipt: receipt },
        );
      }
      return [entry.taskId, logicalId] as const;
    }),
  );
  const canonicalReference = (
    references: ReadonlyMap<string, string>,
    productionId: string,
    kind: string,
  ): string => {
    const logicalId = references.get(productionId);
    if (!logicalId) {
      throw new ProductionManifestApplyError(
        `[production-manifest] scheduled ${kind} reference ${productionId} lacks namespace provenance`,
        "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
        { dirtyReceipt: receipt },
      );
    }
    return logicalId;
  };
  return {
    version: MANIFEST_VERSION,
    namespace: receipt.namespace,
    ownerAgentId: receipt.ownerAgentId,
    world: { id: world.id, name: world.name ?? null },
    entities: entities
      .map((entry) => ({
        id: entry.id as UUID,
        names: [...entry.names].sort(),
        metadata: metadataWithoutScenarioMarker(entry.metadata),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    rooms: rooms
      .map((entry) => ({
        id: entry.id,
        name: entry.name ?? null,
        source: entry.source,
        type: entry.type,
        worldId: entry.worldId as UUID,
        participantEntityIds: [
          ...(participants.find((item) => item.roomId === entry.id)
            ?.entityIds ?? []),
        ].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    memories: memories
      .map((entry) => {
        const index = receipt.memoryIds.indexOf(entry.id as UUID);
        return {
        id: entry.id as UUID,
        roomId: entry.roomId as UUID,
        entityId: entry.entityId as UUID,
        text: entry.content.text as string,
        tableName: receipt.memoryTableNames[index] as string,
        metadata: metadataWithoutScenarioMarker(entry.metadata),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
    relationships: relationships
      .map((entry) => ({
        sourceEntityId: entry.sourceEntityId,
        targetEntityId: entry.targetEntityId,
        tags: [...entry.tags].sort(),
        metadata: metadataWithoutScenarioMarker(entry.metadata),
      }))
      .sort((a, b) =>
        `${a.sourceEntityId}:${a.targetEntityId}`.localeCompare(
          `${b.sourceEntityId}:${b.targetEntityId}`,
        ),
      ),
    tasks: tasks
      .map((entry) => ({
        id: entry.id as UUID,
        name: entry.name,
        description: entry.description ?? null,
        roomId: entry.roomId ?? null,
        entityId: entry.entityId ?? null,
        worldId: entry.worldId ?? null,
        tags: [...(entry.tags ?? [])].sort(),
        dueAt: entry.dueAt === undefined ? null : Number(entry.dueAt),
        metadata: metadataWithoutScenarioMarker(entry.metadata),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    schedules: schedules
      .map((entry) => {
        const logicalId = logicalIdFromScenarioMarker(
          entry.metadata,
          receipt.namespace,
        );
        if (!logicalId) {
          throw new ProductionManifestApplyError(
            `[production-manifest] scheduled item ${entry.taskId} lacks namespace provenance`,
            "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
            { dirtyReceipt: receipt },
          );
        }
        const {
          taskId: _taskId,
          idempotencyKey: _idempotencyKey,
          metadata,
          ...task
        } = entry;
        const canonicalTask = {
          ...task,
          trigger:
            task.trigger.kind === "after_task"
              ? {
                  ...task.trigger,
                  taskId: canonicalReference(
                    scheduleLogicalIds,
                    task.trigger.taskId,
                    "after_task",
                  ),
                }
              : task.trigger,
          subject:
            task.subject?.kind === "entity"
              ? {
                  ...task.subject,
                  id: canonicalReference(
                    entityLogicalIds,
                    task.subject.id,
                    "entity subject",
                  ),
                }
              : task.subject?.kind === "relationship"
                ? {
                    ...task.subject,
                    id: canonicalReference(
                      relationshipLogicalIds,
                      task.subject.id,
                      "relationship subject",
                    ),
                  }
                : task.subject,
          contextRequest: task.contextRequest
            ? {
                ...task.contextRequest,
                includeEntities: task.contextRequest.includeEntities
                  ? {
                      ...task.contextRequest.includeEntities,
                      entityIds:
                        task.contextRequest.includeEntities.entityIds.map(
                          (id) =>
                            canonicalReference(
                              entityLogicalIds,
                              id,
                              "context entity",
                            ),
                        ),
                    }
                  : undefined,
                includeRelationships: task.contextRequest.includeRelationships
                  ? {
                      ...task.contextRequest.includeRelationships,
                      relationshipIds:
                        task.contextRequest.includeRelationships.relationshipIds?.map(
                          (id) =>
                            canonicalReference(
                              relationshipLogicalIds,
                              id,
                              "context relationship",
                            ),
                        ),
                      forEntityIds:
                        task.contextRequest.includeRelationships.forEntityIds?.map(
                          (id) =>
                            canonicalReference(
                              entityLogicalIds,
                              id,
                              "relationship context entity",
                            ),
                        ),
                    }
                  : undefined,
              }
            : undefined,
        };
        const canonicalMetadata = isRecord(metadata)
          ? Object.fromEntries(
              Object.entries(metadata).filter(
                ([key]) =>
                  key !== "scenarioManifest" &&
                  key !== "schedulingCreationReceipt" &&
                  key !== "createdAtIso",
              ),
            )
          : null;
        return {
          logicalId,
          task: stableValue({
            ...canonicalTask,
            metadata:
              canonicalMetadata && Object.keys(canonicalMetadata).length > 0
                ? canonicalMetadata
                : null,
          }),
        };
      })
      .sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
    notifications: notifications
      .map((entry) => {
        const approvalRecord = receipt.approvalRecords.find(
          (record) => entry.groupKey === `approval:${record.id}`,
        );
        const relatedApproval = approvalRecord
          ? approvals.find((approval) => approval.id === approvalRecord.id)
          : undefined;
        const logicalId =
          logicalIdFromScenarioMarker(entry.data, receipt.namespace) ??
          (relatedApproval
            ? `approval:${approvalLogicalId(relatedApproval, receipt.namespace)}`
            : null);
        if (!logicalId) {
          throw new ProductionManifestApplyError(
            `[production-manifest] notification ${entry.id} lacks namespace provenance`,
            "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
            { dirtyReceipt: receipt },
          );
        }
        const data = isRecord(entry.data)
          ? Object.fromEntries(
              Object.entries(entry.data).filter(
                ([key]) => key !== "scenarioManifest" && key !== "requestId",
              ),
            )
          : null;
        return {
          logicalId,
          title: entry.title,
          body: entry.body ?? null,
          category: entry.category,
          priority: entry.priority,
          source: entry.source,
          deepLink: entry.deepLink ?? null,
          icon: entry.icon ?? null,
          groupKey: relatedApproval
            ? `approval:${approvalLogicalId(relatedApproval, receipt.namespace)}`
            : (entry.groupKey?.replace(
                `scenario-manifest:${receipt.namespace}:`,
                "",
              ) ?? null),
          data:
            data && Object.keys(data).length > 0 ? stableValue(data) : null,
          expiresAt: entry.expiresAt ?? null,
        };
      })
      .sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
    approvals: approvals
      .map((entry) => {
        const logicalId = approvalLogicalId(entry, receipt.namespace);
        if (!logicalId) {
          throw new ProductionManifestApplyError(
            `[production-manifest] approval ${entry.id} lacks namespace provenance`,
            "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
            { dirtyReceipt: receipt },
          );
        }
        return {
          logicalId,
          subjectUserId: entry.subjectUserId,
          action: entry.action,
          payload: stableValue(entry.payload),
          channel: entry.channel,
          reason: entry.reason,
          expiresAt: entry.expiresAt.getTime(),
          state: entry.state,
        };
      })
      .sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
    providerState: receipt.providerStateKeys
      .map((key, index) => ({
        key,
        value: stableValue(providerStateRows[index]),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Removes exactly the receipt's records and proves each identifier is absent. */
export async function resetProductionManifest(
  runtime: IAgentRuntime,
  input: unknown,
): Promise<ProductionManifestResetArtifact> {
  const receipt = parseProductionManifestReceipt(input);
  assertReceiptOwner(runtime, receipt);
  await assertReceiptProvenance(runtime, receipt);
  await assertReceiptTargetsOwned(runtime, receipt);
  await resetRecordedManifestWrites(runtime, receipt);
  return resetArtifact(receipt);
}

function resetArtifact(
  receipt: ProductionManifestReceipt,
): ProductionManifestResetArtifact {
  return {
    version: MANIFEST_VERSION,
    namespace: receipt.namespace,
    removed: receipt,
    absentAfterReset: {
      world: true,
      entities: [...receipt.entityIds],
      rooms: [...receipt.roomIds],
      memories: [...receipt.memoryIds],
      relationships: [...receipt.relationshipIds],
      tasks: [...receipt.taskIds],
      schedules: [...receipt.scheduleIds],
      notifications: [...receipt.notificationIds],
      approvals: receipt.approvalRecords.map((entry) => entry.id),
      providerState: [...receipt.providerStateKeys],
    },
  };
}

async function readResidueEvidence(
  runtime: IAgentRuntime,
  receipt: ProductionManifestReceipt,
): Promise<ProductionManifestResidueEvidence> {
  const [
    worlds,
    entities,
    rooms,
    memories,
    relationships,
    tasks,
    scheduleRows,
    notificationRows,
    approvalRows,
    providerStateRows,
  ] =
    await Promise.all([
      runtime.getWorldsByIds([receipt.worldId]),
      runtime.getEntitiesByIds(receipt.entityIds),
      runtime.getRoomsByIds(receipt.roomIds),
      runtime.getMemoriesByIds(receipt.memoryIds),
      runtime.getRelationshipsByIds(receipt.relationshipIds),
      runtime.getTasksByIds(receipt.taskIds),
      receipt.scheduleIds.length > 0
        ? getScheduledTaskRunner(runtime, { agentId: runtime.agentId }).list({})
        : Promise.resolve([] as ScheduledTask[]),
      receipt.notificationIds.length > 0
        ? Promise.resolve(notificationService(runtime).listIncludingExpired())
        : Promise.resolve([] as AgentNotification[]),
      receipt.approvalRecords.length > 0
        ? Promise.all(
            receipt.approvalRecords.map((record) =>
              approvalQueue(runtime).byId(record.id, record.subjectUserId),
            ),
          )
        : Promise.resolve([] as Array<ApprovalRequest | null>),
      Promise.all(
        receipt.providerStateKeys.map((key) =>
          runtime.getCache<JsonValue>(key),
        ),
      ),
    ]);
  return {
    worlds: worlds.map((entry) => entry.id),
    entities: entities.map((entry) => entry.id as UUID),
    rooms: rooms.map((entry) => entry.id),
    memories: memories.map((entry) => entry.id as UUID),
    relationships: relationships.map((entry) => entry.id),
    tasks: tasks.map((entry) => entry.id as UUID),
    schedules: scheduleRows
      .filter((entry) => receipt.scheduleIds.includes(entry.taskId))
      .map((entry) => entry.taskId),
    notifications: notificationRows
      .filter((entry) => receipt.notificationIds.includes(entry.id))
      .map((entry) => entry.id),
    approvals: approvalRows
      .filter((entry): entry is ApprovalRequest => entry !== null)
      .map((entry) => entry.id),
    providerState: receipt.providerStateKeys.filter(
      (_key, index) => providerStateRows[index] !== undefined,
    ),
  };
}

async function resetRecordedManifestWrites(
  runtime: IAgentRuntime,
  receipt: ProductionManifestReceipt,
): Promise<void> {
  try {
    for (const key of receipt.providerStateKeys) {
      await runtime.deleteCache(key);
    }
    if (receipt.notificationIds.length > 0) {
      const service = notificationService(runtime);
      for (const id of receipt.notificationIds) {
        await service.remove(id);
      }
    }
    if (receipt.approvalRecords.length > 0) {
      const queue = approvalQueue(runtime);
      for (const record of receipt.approvalRecords) {
        await queue.removePending(record.id, record.subjectUserId);
      }
    }
    if (receipt.scheduleIds.length > 0) {
      const runner = getScheduledTaskRunner(runtime, {
        agentId: runtime.agentId,
      });
      if (!runner.remove) {
        throw new Error("scheduled runner does not expose durable removal");
      }
      for (const id of receipt.scheduleIds) {
        await runner.remove(id);
      }
    }
    await runtime.deleteRelationships(receipt.relationshipIds);
    await runtime.deleteTasks(receipt.taskIds);
    await runtime.deleteMemories(receipt.memoryIds);
    if (receipt.participantPairs.length > 0) {
      await runtime.deleteParticipants(receipt.participantPairs);
    }
    await runtime.deleteRooms(receipt.roomIds);
    await runtime.deleteEntities(receipt.entityIds);
    await runtime.deleteWorlds([receipt.worldId]);
  } catch (cause) {
    // error-policy:J2 Reset cannot report success after partial production mutation.
    let residue: ProductionManifestResidueEvidence | undefined;
    try {
      residue = await readResidueEvidence(runtime, receipt);
    } catch (evidenceCause) {
      throw new ProductionManifestApplyError(
        "[production-manifest] reset failed and residue readback also failed",
        "SCENARIO_MANIFEST_DIRTY",
        {
          cause: new AggregateError([cause, evidenceCause]),
          dirtyReceipt: receipt,
        },
      );
    }
    throw new ProductionManifestApplyError(
      "[production-manifest] reset failed after partial mutation",
      "SCENARIO_MANIFEST_DIRTY",
      { cause, dirtyReceipt: receipt, residue },
    );
  }

  let residue: ProductionManifestResidueEvidence;
  try {
    residue = await readResidueEvidence(runtime, receipt);
  } catch (cause) {
    // error-policy:J2 The deletes completed, but absence could not be proven.
    throw new ProductionManifestApplyError(
      "[production-manifest] reset completed deletes but residue readback failed",
      "SCENARIO_MANIFEST_DIRTY",
      { cause, dirtyReceipt: receipt },
    );
  }
  if (Object.values(residue).some((ids) => ids.length > 0)) {
    throw new ProductionManifestApplyError(
      "[production-manifest] reset left authoritative records behind",
      "SCENARIO_MANIFEST_DIRTY",
      { dirtyReceipt: receipt, residue },
    );
  }
}

function hasNamespaceMarker(value: unknown, namespace: string): boolean {
  return (
    isRecord(value) &&
    isRecord(value.scenarioManifest) &&
    value.scenarioManifest.namespace === namespace
  );
}

async function assertReceiptProvenance(
  runtime: IAgentRuntime,
  receipt: ProductionManifestReceipt,
): Promise<void> {
  const worlds = await runtime.getWorldsByIds([receipt.worldId]);
  if (worlds.length === 0) {
    throw new ProductionManifestApplyError(
      "[production-manifest] receipt has no authoritative finalized world",
      "SCENARIO_MANIFEST_RECEIPT_UNTRUSTED",
    );
  }
  if (worlds.length !== 1) {
    throw new ProductionManifestApplyError(
      "[production-manifest] receipt world readback is ambiguous",
      "SCENARIO_MANIFEST_DIRTY",
      { dirtyReceipt: receipt },
    );
  }
  const world = worlds[0];
  const extra = world.metadata?.extra;
  if (
    world.agentId !== runtime.agentId ||
    world.metadata?.ownership?.ownerId !== runtime.agentId ||
    !isRecord(extra) ||
    extra.namespace !== receipt.namespace ||
    extra.manifestSha256 !== receipt.manifestSha256 ||
    extra.receiptSha256 !== hashReceipt(receipt)
  ) {
    throw new ProductionManifestApplyError(
      "[production-manifest] receipt does not match its authoritative finalized world",
      "SCENARIO_MANIFEST_RECEIPT_UNTRUSTED",
    );
  }
}

async function assertReceiptTargetsOwned(
  runtime: IAgentRuntime,
  receipt: ProductionManifestReceipt,
): Promise<void> {
  const [
    worlds,
    entities,
    rooms,
    memories,
    relationships,
    tasks,
    schedules,
    notifications,
    approvals,
    providerState,
  ] =
    await Promise.all([
      runtime.getWorldsByIds([receipt.worldId]),
      runtime.getEntitiesByIds(receipt.entityIds),
      runtime.getRoomsByIds(receipt.roomIds),
      runtime.getMemoriesByIds(receipt.memoryIds),
      runtime.getRelationshipsByIds(receipt.relationshipIds),
      runtime.getTasksByIds(receipt.taskIds),
      receipt.scheduleIds.length > 0
        ? getScheduledTaskRunner(runtime, { agentId: runtime.agentId }).list({})
        : Promise.resolve([] as ScheduledTask[]),
      receipt.notificationIds.length > 0
        ? Promise.resolve(notificationService(runtime).listIncludingExpired())
        : Promise.resolve([] as AgentNotification[]),
      receipt.approvalRecords.length > 0
        ? Promise.all(
            receipt.approvalRecords.map((record) =>
              approvalQueue(runtime).byId(record.id, record.subjectUserId),
            ),
          )
        : Promise.resolve([] as Array<ApprovalRequest | null>),
      Promise.all(
        receipt.providerStateKeys.map((key) =>
          runtime.getCache<JsonValue>(key),
        ),
      ),
    ]);
  const worldOwned = worlds.every(
    (world) =>
      world.agentId === runtime.agentId &&
      world.metadata?.ownership?.ownerId === runtime.agentId &&
      isRecord(world.metadata?.extra) &&
      world.metadata.extra.namespace === receipt.namespace &&
      world.metadata.extra.manifestSha256 === receipt.manifestSha256,
  );
  const entitiesOwned = entities.every(
    (entity) =>
      entity.agentId === runtime.agentId &&
      hasNamespaceMarker(entity.metadata, receipt.namespace),
  );
  const roomsOwned = rooms.every(
    (room) =>
      room.worldId === receipt.worldId &&
      hasNamespaceMarker(room.metadata, receipt.namespace),
  );
  const memoriesOwned = memories.every(
    (memory) => {
      const index = receipt.memoryIds.indexOf(memory.id as UUID);
      const marker = isRecord(memory.metadata)
        ? memory.metadata.scenarioManifest
        : undefined;
      return (
        index >= 0 &&
        memory.agentId === runtime.agentId &&
        memory.worldId === receipt.worldId &&
        hasNamespaceMarker(memory.metadata, receipt.namespace) &&
        isRecord(marker) &&
        marker.tableName === receipt.memoryTableNames[index]
      );
    },
  );
  const relationshipsOwned = relationships.every(
    (relationship) =>
      relationship.agentId === runtime.agentId &&
      hasNamespaceMarker(relationship.metadata, receipt.namespace),
  );
  const tasksOwned = tasks.every(
    (task) =>
      task.agentId === runtime.agentId &&
      task.worldId === receipt.worldId &&
      hasNamespaceMarker(task.metadata, receipt.namespace),
  );
  const schedulesOwned = schedules
    .filter((entry) => receipt.scheduleIds.includes(entry.taskId))
    .every(
      (task) =>
      task.idempotencyKey?.startsWith(
        `scenario-manifest:${receipt.namespace}:schedule:`,
      ) === true &&
        hasNamespaceMarker(task.metadata, receipt.namespace),
    );
  const approvalById = new Map(
    approvals
      .filter((entry): entry is ApprovalRequest => entry !== null)
      .map((entry) => [entry.id, entry]),
  );
  const approvalsOwned = [...approvalById.values()].every((approval) => {
    const record = receipt.approvalRecords.find(
      (candidate) => candidate.id === approval.id,
    );
    return (
      record !== undefined &&
      approval.subjectUserId === record.subjectUserId &&
      approval.requestedBy.startsWith(
        `scenario-manifest:${receipt.namespace}:`,
      ) &&
      approval.idempotencyKey?.startsWith(
        `scenario-manifest:${receipt.namespace}:approval:`,
      ) === true
    );
  });
  const notificationById = new Map(
    notifications.map((entry) => [entry.id, entry]),
  );
  const notificationsOwned = [...notificationById.values()]
    .filter((notification) => receipt.notificationIds.includes(notification.id))
    .every((notification) => {
    if (logicalIdFromScenarioMarker(notification.data, receipt.namespace)) {
      return notification.agentId === runtime.agentId;
    }
    const approvalRecord = receipt.approvalRecords.find(
      (record) => notification.groupKey === `approval:${record.id}`,
    );
    return approvalRecord !== undefined && approvalById.has(approvalRecord.id);
    });
  const providerStateOwned =
    providerState.length === receipt.providerStateKeys.length;
  if (
    !worldOwned ||
    !entitiesOwned ||
    !roomsOwned ||
    !memoriesOwned ||
    !relationshipsOwned ||
    !tasksOwned
    || !schedulesOwned
    || !notificationsOwned
    || !approvalsOwned
    || !providerStateOwned
  ) {
    throw new ProductionManifestApplyError(
      "[production-manifest] reset receipt references records outside its owned namespace",
      "SCENARIO_MANIFEST_WRONG_OWNER",
    );
  }
}

/** Applies, reads, resets, reseeds, and proves canonical byte equivalence. */
export async function proveProductionManifestReset(
  runtime: IAgentRuntime,
  input: unknown,
): Promise<ProductionManifestCycleArtifact> {
  const receipt = await applyProductionManifest(runtime, input);
  const initial = await readProductionManifestSnapshot(runtime, receipt);
  const reset = await resetProductionManifest(runtime, receipt);
  const reseedReceipt = await applyProductionManifest(runtime, input);
  const final = await readProductionManifestSnapshot(runtime, reseedReceipt);
  if (
    serializeProductionManifestArtifact(initial) !==
    serializeProductionManifestArtifact(final)
  ) {
    const differencePaths = canonicalDifferencePaths(initial, final);
    throw new ProductionManifestApplyError(
      `[production-manifest] canonical readback changed after reset and reseed at ${differencePaths.join(", ")}`,
      "SCENARIO_MANIFEST_RESET_DRIFT",
      { dirtyReceipt: reseedReceipt },
    );
  }
  return {
    receipt,
    initial,
    reset,
    reseedReceipt,
    final,
    byteEquivalent: true,
  };
}

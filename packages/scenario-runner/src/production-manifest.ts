/**
 * Applies versioned synthetic-world manifests through `AgentRuntime`'s
 * production persistence boundaries and projects canonical readback artifacts
 * from those same stores. The serialized receipt is the only reset input, so a
 * later process can remove exactly the records created by an earlier process.
 */
import { createHash } from "node:crypto";
import {
  ChannelType,
  ElizaError,
  type IAgentRuntime,
  type JsonValue,
  type Metadata,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

const MANIFEST_VERSION = 1 as const;
const CHANNEL_TYPES = new Set<string>(Object.values(ChannelType));
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

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
  relationshipIds: UUID[];
  taskIds: UUID[];
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
  };
}

export interface ProductionManifestResidueEvidence {
  worlds: UUID[];
  entities: UUID[];
  rooms: UUID[];
  memories: UUID[];
  relationships: UUID[];
  tasks: UUID[];
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
): void {
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
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        assertJsonValue(descriptor?.value, `${path}[${index}]`, active);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, "must contain only plain JSON objects");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        fail(path, "must not contain symbol keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        fail(`${path}.${key}`, "must be an enumerable JSON data property");
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, active);
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
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
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

function parseArray<T>(
  value: unknown,
  path: string,
  parse: (entry: Record<string, unknown>, path: string) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(path, "must be an array");
  assertDenseArrayShape(value, path);
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
      if (tableName !== undefined && tableName !== "messages") {
        fail(`${path}.tableName`, "must equal messages in manifest version 1");
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

  assertUniqueIds([
    { path: "manifest.entities", entries: entities },
    { path: "manifest.rooms", entries: rooms },
    { path: "manifest.memories", entries: memories },
    { path: "manifest.relationships", entries: relationships },
    { path: "manifest.tasks", entries: tasks },
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
  tasks.forEach((task, index) => {
    if (task.roomId)
      requireRoom(task.roomId, `manifest.tasks[${index}].roomId`);
    if (task.entityId) {
      requireEntity(task.entityId, `manifest.tasks[${index}].entityId`);
    }
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
    relationshipIds: [],
    taskIds: [],
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
      "relationshipIds",
      "taskIds",
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
  const relationshipIds = uuidArray(
    input.relationshipIds,
    "receipt.relationshipIds",
  );
  const taskIds = uuidArray(input.taskIds, "receipt.taskIds");
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
    relationshipIds,
    taskIds,
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
  receipt.taskIds =
    manifest.tasks?.map((entry) =>
      manifestId(manifest.namespace, "task", entry.id),
    ) ?? [];
  await assertTargetsAbsent(runtime, receipt);

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
  let relationshipWriteAttempted = false;
  let relationshipReceiptComplete = (manifest.relationships?.length ?? 0) === 0;
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
    relationshipWriteAttempted = relationshipWrites.length > 0;
    await runtime.createRelationships(relationshipWrites);
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
    receipt.relationshipIds = relationshipReadback.map(
      (entry) => (entry as NonNullable<typeof entry>).id,
    );
    relationshipReceiptComplete = true;
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
    if (relationshipWriteAttempted && !relationshipReceiptComplete) {
      throw new ProductionManifestApplyError(
        "[production-manifest] relationship write outcome is ambiguous; exact compensation is not provable",
        "SCENARIO_MANIFEST_DIRTY",
        { cause, dirtyReceipt: receipt },
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
  ] = await Promise.all([
    runtime.getWorldsByIds([receipt.worldId]),
    runtime.getEntitiesByIds(receipt.entityIds),
    runtime.getRoomsByIds(receipt.roomIds),
    runtime.getMemoriesByIds(receipt.memoryIds),
    runtime.getRelationshipsByIds(receipt.relationshipIds),
    runtime.getTasksByIds(receipt.taskIds),
    runtime.getParticipantsForRooms(receipt.roomIds),
  ]);
  if (
    worlds.length !== 1 ||
    entities.length !== receipt.entityIds.length ||
    rooms.length !== receipt.roomIds.length ||
    memories.length !== receipt.memoryIds.length ||
    relationships.length !== receipt.relationshipIds.length ||
    tasks.length !== receipt.taskIds.length
  ) {
    const counts = {
      worlds: `${worlds.length}/1`,
      entities: `${entities.length}/${receipt.entityIds.length}`,
      rooms: `${rooms.length}/${receipt.roomIds.length}`,
      memories: `${memories.length}/${receipt.memoryIds.length}`,
      relationships: `${relationships.length}/${receipt.relationshipIds.length}`,
      tasks: `${tasks.length}/${receipt.taskIds.length}`,
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
      .map((entry) => ({
        id: entry.id as UUID,
        roomId: entry.roomId as UUID,
        entityId: entry.entityId as UUID,
        text: entry.content.text as string,
        metadata: metadataWithoutScenarioMarker(entry.metadata),
      }))
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
    },
  };
}

async function readResidueEvidence(
  runtime: IAgentRuntime,
  receipt: ProductionManifestReceipt,
): Promise<ProductionManifestResidueEvidence> {
  const [worlds, entities, rooms, memories, relationships, tasks] =
    await Promise.all([
      runtime.getWorldsByIds([receipt.worldId]),
      runtime.getEntitiesByIds(receipt.entityIds),
      runtime.getRoomsByIds(receipt.roomIds),
      runtime.getMemoriesByIds(receipt.memoryIds),
      runtime.getRelationshipsByIds(receipt.relationshipIds),
      runtime.getTasksByIds(receipt.taskIds),
    ]);
  return {
    worlds: worlds.map((entry) => entry.id),
    entities: entities.map((entry) => entry.id as UUID),
    rooms: rooms.map((entry) => entry.id),
    memories: memories.map((entry) => entry.id as UUID),
    relationships: relationships.map((entry) => entry.id),
    tasks: tasks.map((entry) => entry.id as UUID),
  };
}

async function resetRecordedManifestWrites(
  runtime: IAgentRuntime,
  receipt: ProductionManifestReceipt,
): Promise<void> {
  try {
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
  const [worlds, entities, rooms, memories, relationships, tasks] =
    await Promise.all([
      runtime.getWorldsByIds([receipt.worldId]),
      runtime.getEntitiesByIds(receipt.entityIds),
      runtime.getRoomsByIds(receipt.roomIds),
      runtime.getMemoriesByIds(receipt.memoryIds),
      runtime.getRelationshipsByIds(receipt.relationshipIds),
      runtime.getTasksByIds(receipt.taskIds),
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
    (memory) =>
      memory.agentId === runtime.agentId &&
      memory.worldId === receipt.worldId &&
      hasNamespaceMarker(memory.metadata, receipt.namespace),
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
  if (
    !worldOwned ||
    !entitiesOwned ||
    !roomsOwned ||
    !memoriesOwned ||
    !relationshipsOwned ||
    !tasksOwned
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
    throw new ProductionManifestApplyError(
      "[production-manifest] canonical readback changed after reset and reseed",
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

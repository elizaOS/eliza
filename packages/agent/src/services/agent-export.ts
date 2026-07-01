/**
 * Agent Export/Import Service
 *
 * Provides encrypted, portable agent archives for migrating agents between
 * machines. Captures all database state (character, memories, entities,
 * relationships, rooms, participants, worlds, tasks, and optionally logs)
 * into a single password-encrypted binary file (.eliza-agent).
 *
 * Encryption: PBKDF2-SHA256 key derivation + AES-256-GCM
 * Compression: gzip
 *
 * File format (binary):
 *   ELIZA_AGENT_V1\n   (15 bytes magic header)
 *   iterations           (4 bytes uint32 BE — PBKDF2 iteration count)
 *   salt                 (32 bytes — PBKDF2 salt)
 *   iv                   (12 bytes — AES-256-GCM nonce)
 *   tag                  (16 bytes — AES-GCM authentication tag)
 *   ciphertext           (variable — gzip-compressed JSON, encrypted)
 */

import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import type {
  Agent,
  AgentRuntime,
  Character,
  Component,
  Entity,
  Log,
  Memory,
  Relationship,
  Room,
  Task,
  UUID,
  World,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import * as zod from "zod";
import {
  isStoredMediaUrl,
  mediaFileNameFromUrl,
  readStoredMediaBytes,
  storedMediaContentMatchesName,
  writeStoredMediaFile,
} from "../api/media-store.ts";

const z = (zod as typeof zod & { z?: typeof zod }).z ?? zod;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAGIC_HEADER = "ELIZA_AGENT_V1\n";
const MAGIC_BYTES = Buffer.from(MAGIC_HEADER, "utf-8"); // 15 bytes
const PBKDF2_ITERATIONS = 600_000; // OWASP 2024 recommendation for SHA-256
const MAX_PBKDF2_ITERATIONS = 1_200_000; // 2× the default — reject anything higher on import
const SALT_LEN = 32;
const IV_LEN = 12; // AES-256-GCM standard nonce
const TAG_LEN = 16; // AES-GCM authentication tag
const KEY_LEN = 32; // AES-256
const MIN_PASSWORD_LENGTH = 4;
const HEADER_SIZE = MAGIC_BYTES.length + 4 + SALT_LEN + IV_LEN + TAG_LEN; // 15 + 4 + 32 + 12 + 16 = 79
const EXPORT_VERSION = 1;
const MAX_IMPORT_DECOMPRESSED_BYTES = 16 * 1024 * 1024; // 16 MiB safety cap

// Memory table names we need to export. The adapter's getMemories requires
// a tableName parameter. These are the known built-in table names used by
// elizaOS. We query each individually and merge the results.
const MEMORY_TABLES = [
  "messages",
  "facts",
  "documents",
  "fragments",
  "descriptions",
  "character_modifications",
  "custom",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentExportOptions {
  /** Include execution logs in the export. Can be large. Defaults to false. */
  includeLogs?: boolean;
}

export interface AgentExportPayload {
  version: number;
  exportedAt: string;
  sourceAgentId: string;
  agent: Partial<Agent>;
  /** Runtime character config (from buildCharacterFromConfig) — may contain
   *  fields not persisted to the DB agent record (style, topics, adjectives,
   *  messageExamples, postExamples, knowledge sources, etc.). On import, this
   *  is merged with the agent record to reconstruct the full character. */
  characterConfig?: Omit<Character, "secrets">;
  entities: Entity[];
  memories: Memory[];
  components: Component[];
  rooms: Room[];
  participants: Array<{
    entityId: string;
    roomId: string;
    userState: string | null;
  }>;
  relationships: Relationship[];
  worlds: World[];
  tasks: Task[];
  logs: Log[];
  /**
   * Content-addressed media bytes referenced by the exported memories (avatars,
   * attachments). Each entry is a `<sha256>.<ext>` file name + its base64 bytes,
   * so a restored agent's messages keep their images/files. Optional + additive:
   * an export without media (or an older reader) still round-trips the DB.
   */
  media?: Array<{ fileName: string; base64: string }>;
  /**
   * Per-component integrity manifest (#9963). A sha256 over the canonical JSON
   * of each exported collection plus its row count, computed at export time and
   * re-verified at import time *before* any DB write. The AES-256-GCM auth tag
   * already authenticates the whole ciphertext; this adds per-collection
   * granularity so a structural inconsistency (a hand-edited or truncated
   * payload, a partial merge) fails loudly and names the offending collection
   * rather than silently importing it. Optional + additive: an export without a
   * manifest (or an older reader) still round-trips — verification is simply
   * skipped, never a hard failure on absence.
   */
  manifest?: AgentExportManifest;
}

/** sha256 digest + row count for one exported collection. */
export interface AgentExportComponentDigest {
  sha256: string;
  count: number;
}

/** The set of collections covered by the integrity manifest (mirrors the
 *  `ImportResult.counts` collections — every array `restoreAgentData` writes). */
export const MANIFEST_COLLECTIONS = [
  "entities",
  "memories",
  "components",
  "rooms",
  "participants",
  "relationships",
  "worlds",
  "tasks",
  "logs",
  "media",
] as const;

export type ManifestCollection = (typeof MANIFEST_COLLECTIONS)[number];

export interface AgentExportManifest {
  algorithm: "sha256";
  components: Record<string, AgentExportComponentDigest>;
}

export interface ImportResult {
  success: boolean;
  agentId: string;
  agentName: string;
  counts: {
    memories: number;
    entities: number;
    components: number;
    rooms: number;
    participants: number;
    relationships: number;
    worlds: number;
    tasks: number;
    logs: number;
    media: number;
  };
}

export interface ExportSizeEstimate {
  estimatedBytes: number;
  memoriesCount: number;
  entitiesCount: number;
  roomsCount: number;
  worldsCount: number;
  tasksCount: number;
}

// ---------------------------------------------------------------------------
// Per-component integrity manifest (#9963)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization: object keys sorted recursively and
 * `undefined`-valued keys dropped (matching `JSON.stringify`). This makes a
 * collection's digest reproducible across the export → gzip → encrypt → decrypt
 * → gunzip → `JSON.parse` round-trip, regardless of in-memory key ordering, so
 * the digest computed at export equals the one recomputed at import.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

/** sha256 of a collection's canonical JSON, plus its length. */
export function digestCollection(items: unknown[]): AgentExportComponentDigest {
  const list = Array.isArray(items) ? items : [];
  return { sha256: sha256Hex(canonicalize(list)), count: list.length };
}

const EMPTY_MANIFEST_COLLECTION: unknown[] = [];

/** The collection arrays the manifest covers, read off a payload-like object. */
function manifestCollectionsOf(
  payload: Pick<AgentExportPayload, ManifestCollection>,
): Record<ManifestCollection, unknown[]> {
  return {
    entities: payload.entities ?? EMPTY_MANIFEST_COLLECTION,
    memories: payload.memories ?? EMPTY_MANIFEST_COLLECTION,
    components: payload.components ?? EMPTY_MANIFEST_COLLECTION,
    rooms: payload.rooms ?? EMPTY_MANIFEST_COLLECTION,
    participants: payload.participants ?? EMPTY_MANIFEST_COLLECTION,
    relationships: payload.relationships ?? EMPTY_MANIFEST_COLLECTION,
    worlds: payload.worlds ?? EMPTY_MANIFEST_COLLECTION,
    tasks: payload.tasks ?? EMPTY_MANIFEST_COLLECTION,
    logs: payload.logs ?? EMPTY_MANIFEST_COLLECTION,
    media: payload.media ?? EMPTY_MANIFEST_COLLECTION,
  };
}

/** Build the integrity manifest for the collections of `payload`. */
export function buildExportManifest(
  payload: Pick<AgentExportPayload, ManifestCollection>,
): AgentExportManifest {
  const collections = manifestCollectionsOf(payload);
  const components: Record<string, AgentExportComponentDigest> = {};
  for (const name of MANIFEST_COLLECTIONS) {
    components[name] = digestCollection(collections[name]);
  }
  return { algorithm: "sha256", components };
}

export interface ManifestMismatch {
  collection: string;
  expected: AgentExportComponentDigest;
  actual: AgentExportComponentDigest;
}

export interface ManifestVerification {
  /** True when the payload carried a manifest to check against. */
  present: boolean;
  /** True when no manifest was present, or every collection matched. */
  ok: boolean;
  mismatches: ManifestMismatch[];
}

/**
 * Recompute each collection's digest from `payload` and compare to the embedded
 * manifest. Absence of a manifest is `{ present: false, ok: true }` (additive
 * back-compat — older exports still import). A present-but-mismatching manifest
 * is `ok: false` with the offending collection(s) named.
 */
export function verifyExportManifest(
  payload: AgentExportPayload,
): ManifestVerification {
  const manifest = payload.manifest;
  if (manifest?.algorithm !== "sha256") {
    return { present: false, ok: true, mismatches: [] };
  }
  const collections = manifestCollectionsOf(payload);
  const mismatches: ManifestMismatch[] = [];
  for (const name of MANIFEST_COLLECTIONS) {
    const expected = manifest.components[name] ?? { sha256: "", count: 0 };
    const actual = digestCollection(collections[name]);
    if (expected.sha256 !== actual.sha256 || expected.count !== actual.count) {
      mismatches.push({ collection: name, expected, actual });
    }
  }
  return { present: true, ok: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Validation schema for the decrypted payload
// ---------------------------------------------------------------------------

function hasStringId(value: unknown): value is { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function typedIdRecordSchema<T>() {
  return z.custom<T>((value): value is T => hasStringId(value), {
    message: "Expected object with string id",
  });
}

const EntitySchema = typedIdRecordSchema<Entity>();
const MemorySchema = typedIdRecordSchema<Memory>();
const ComponentSchema = typedIdRecordSchema<Component>();
const RoomSchema = typedIdRecordSchema<Room>();
const RelationshipSchema = typedIdRecordSchema<Relationship>();
const WorldSchema = typedIdRecordSchema<World>();
const TaskSchema = typedIdRecordSchema<Task>();

// Logs don't need IDs (they're created fresh on import)
const LogSchema = z.custom<Log>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  { message: "Expected log object" },
);

const PayloadSchema = z.object({
  version: z.number().int().min(1),
  exportedAt: z.string(),
  sourceAgentId: z.string(),
  agent: z.custom<Partial<Agent>>(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    { message: "Expected agent object" },
  ),
  characterConfig: z
    .record(z.string(), z.unknown())
    .optional()
    .transform((v) => v as Omit<Character, "secrets"> | undefined),
  entities: z.array(EntitySchema),
  memories: z.array(MemorySchema),
  components: z.array(ComponentSchema),
  rooms: z.array(RoomSchema),
  participants: z.array(
    z.object({
      entityId: z.string(),
      roomId: z.string(),
      userState: z.string().nullable(),
    }),
  ),
  relationships: z.array(RelationshipSchema),
  worlds: z.array(WorldSchema),
  tasks: z.array(TaskSchema),
  logs: z.array(LogSchema),
  media: z
    .array(z.object({ fileName: z.string(), base64: z.string() }))
    .optional(),
  manifest: z
    .object({
      algorithm: z.literal("sha256"),
      components: z.record(
        z.string(),
        z.object({ sha256: z.string(), count: z.number().int().min(0) }),
      ),
    })
    .optional(),
});

type ValidatedAgentExportPayload = zod.infer<typeof PayloadSchema>;

function toAgentExportPayload(
  payload: ValidatedAgentExportPayload,
): AgentExportPayload {
  return {
    version: payload.version,
    exportedAt: payload.exportedAt,
    sourceAgentId: payload.sourceAgentId,
    agent: payload.agent,
    characterConfig: payload.characterConfig,
    entities: payload.entities,
    memories: payload.memories,
    components: payload.components,
    rooms: payload.rooms,
    participants: payload.participants.map((participant) => ({
      entityId: participant.entityId,
      roomId: participant.roomId,
      userState: participant.userState ?? null,
    })),
    relationships: payload.relationships,
    worlds: payload.worlds,
    tasks: payload.tasks,
    logs: payload.logs,
    media: payload.media,
    manifest: payload.manifest,
  };
}

// ---------------------------------------------------------------------------
// Media (content-addressed store) capture / restore
// ---------------------------------------------------------------------------

const MEDIA_URL_IN_TEXT_RE = /\/api\/media\/[a-f0-9]{64}\.[a-z0-9]+/gi;

/**
 * The set of `<sha256>.<ext>` media file names referenced by the exported
 * memories — from each message's `attachments[].url` and any media URL embedded
 * in its text. Pure (no fs) so it unit-tests in isolation.
 */
export function collectReferencedMediaFileNames(memories: Memory[]): string[] {
  const names = new Set<string>();
  const add = (url: string | undefined | null) => {
    if (!url || !isStoredMediaUrl(url)) return;
    const fileName = mediaFileNameFromUrl(url);
    if (fileName) names.add(fileName);
  };
  for (const mem of memories) {
    const { attachments, text } = mem.content;
    if (attachments) {
      for (const attachment of attachments) add(attachment.url);
    }
    if (typeof text === "string") {
      for (const match of text.matchAll(MEDIA_URL_IN_TEXT_RE)) {
        add(match[0]);
      }
    }
  }
  return [...names];
}

/** Read each referenced media file's bytes into the base64 export entries. */
function captureReferencedMedia(
  memories: Memory[],
): Array<{ fileName: string; base64: string }> {
  const out: Array<{ fileName: string; base64: string }> = [];
  for (const fileName of collectReferencedMediaFileNames(memories)) {
    const bytes = readStoredMediaBytes(fileName);
    if (bytes) out.push({ fileName, base64: bytes.toString("base64") });
  }
  return out;
}

/** Rehydrate the content-addressed store from the export's media entries. */
export function restoreMedia(
  media: Array<{ fileName: string; base64: string }> | undefined,
): number {
  let restored = 0;
  let rejected = 0;
  if (!media) return restored;
  for (const { fileName, base64 } of media) {
    const bytes = Buffer.from(base64, "base64");
    // Content-addressed integrity gate (#9963): the bytes MUST hash back to their
    // `<sha256>` name. A mismatch means a corrupt or tampered backup — skip it,
    // loudly, rather than poison the content-addressed store with bytes filed
    // under a hash that doesn't match their content (the dedup + unguessable-
    // capability invariant the store relies on).
    if (!storedMediaContentMatchesName(fileName, bytes)) {
      rejected++;
      logger.warn(
        `[agent-export] Skipping restored media ${fileName}: sha256 content-hash mismatch (corrupt or tampered backup)`,
      );
      continue;
    }
    if (writeStoredMediaFile(fileName, bytes)) {
      restored++;
    }
  }
  if (rejected > 0) {
    logger.warn(
      `[agent-export] Rejected ${rejected} media file(s) on restore for content-hash mismatch`,
    );
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function deriveKey(
  password: string,
  salt: Buffer,
  iterations: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, KEY_LEN, "sha256", (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function encrypt(
  plaintext: Buffer,
  password: string,
): Promise<{
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
  iterations: number;
}> {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { salt, iv, tag, ciphertext, iterations: PBKDF2_ITERATIONS };
}

async function decrypt(
  ciphertext: Buffer,
  password: string,
  salt: Buffer,
  iv: Buffer,
  tag: Buffer,
  iterations: number,
): Promise<Buffer> {
  const key = await deriveKey(password, salt, iterations);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext;
}

// ---------------------------------------------------------------------------
// Binary file packing / unpacking
// ---------------------------------------------------------------------------

function packFile(encrypted: {
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
  iterations: number;
}): Buffer {
  const iterBuf = Buffer.alloc(4);
  iterBuf.writeUInt32BE(encrypted.iterations, 0);

  return Buffer.concat([
    MAGIC_BYTES,
    iterBuf,
    encrypted.salt,
    encrypted.iv,
    encrypted.tag,
    encrypted.ciphertext,
  ]);
}

function unpackFile(fileBuffer: Buffer): {
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
  iterations: number;
} {
  if (fileBuffer.length < HEADER_SIZE) {
    throw new AgentExportError(
      "File is too small to be a valid .eliza-agent export.",
    );
  }

  const magic = fileBuffer.subarray(0, MAGIC_BYTES.length);
  if (!magic.equals(MAGIC_BYTES)) {
    throw new AgentExportError(
      "Invalid file format — this does not appear to be an .eliza-agent export file.",
    );
  }

  let offset = MAGIC_BYTES.length;

  const iterations = fileBuffer.readUInt32BE(offset);
  offset += 4;

  if (iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new AgentExportError(
      `Invalid PBKDF2 iteration count (${iterations}). ` +
        `Expected between 1 and ${MAX_PBKDF2_ITERATIONS.toLocaleString()}.`,
    );
  }

  const salt = fileBuffer.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;

  const iv = fileBuffer.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;

  const tag = fileBuffer.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;

  const ciphertext = fileBuffer.subarray(offset);

  if (ciphertext.length === 0) {
    throw new AgentExportError("Export file contains no encrypted data.");
  }

  return { salt, iv, tag, ciphertext, iterations };
}

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

export class AgentExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentExportError";
  }
}

async function gunzipWithSizeLimit(
  compressed: Buffer,
  maxBytes = MAX_IMPORT_DECOMPRESSED_BYTES,
): Promise<Buffer> {
  const source = Readable.from([compressed]);
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let total = 0;

  source.pipe(gunzip);

  for await (const chunk of gunzip) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      source.destroy();
      gunzip.destroy();
      throw new AgentExportError(
        `Decompressed payload exceeds import limit (${maxBytes} bytes).`,
      );
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks, total);
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

/** Read agentId from a Task, accounting for proto vs DB naming. */
function taskAgentId(t: Task): string | undefined {
  const rec = t as Task & { agent_id?: string };
  return (rec.agentId ?? rec.agent_id) as string | undefined;
}

async function extractAgentData(
  runtime: AgentRuntime,
  options: AgentExportOptions,
): Promise<AgentExportPayload> {
  const db = runtime.adapter;
  const agentId = runtime.agentId;

  logger.info(`[agent-export] Extracting data for agent ${agentId}`);

  // 1. Agent record
  const agents = await db.getAgentsByIds([agentId]);
  const agent = agents[0];
  if (!agent) {
    throw new AgentExportError(`Agent ${agentId} not found in database.`);
  }

  // 2. Worlds owned by this agent
  const allWorlds = await db.getAllWorlds();
  const agentWorlds = allWorlds.filter((w) => w.agentId === agentId);
  logger.info(`[agent-export] Found ${agentWorlds.length} worlds`);

  // 3. Rooms — gather from worlds and from participant list
  const roomMap = new Map<string, Room>();

  for (const world of agentWorlds) {
    if (!world.id) continue;
    const worldRooms = await db.getRoomsByWorlds([world.id]);
    for (const room of worldRooms) {
      if (room.id) roomMap.set(room.id, room);
    }
  }

  // Also get rooms the agent participates in directly
  const participantRoomIds = await db.getRoomsForParticipants([agentId]);
  if (participantRoomIds.length > 0) {
    const participantRooms = await db.getRoomsByIds(participantRoomIds);
    if (participantRooms) {
      for (const room of participantRooms) {
        if (room.id) roomMap.set(room.id, room);
      }
    }
  }

  const rooms = Array.from(roomMap.values());
  logger.info(`[agent-export] Found ${rooms.length} rooms`);

  // 4. Entities and participants for each room
  const entityMap = new Map<string, Entity>();
  const participantRecords: Array<{
    entityId: string;
    roomId: string;
    userState: string | null;
  }> = [];

  for (const room of rooms) {
    if (!room.id) continue;

    const entitiesResult = await db.getEntitiesForRooms([room.id], true);
    const roomEntities = entitiesResult[0]?.entities ?? [];
    for (const entity of roomEntities) {
      if (entity.id) entityMap.set(entity.id, entity);
    }

    const participantsResult = await db.getParticipantsForRooms([room.id]);
    const participantIds = participantsResult[0]?.entityIds ?? [];
    for (const entityId of participantIds) {
      const userStates = await db.getParticipantUserStates([
        { roomId: room.id, entityId },
      ]);
      const userState = userStates[0] ?? null;
      participantRecords.push({
        entityId,
        roomId: room.id,
        userState,
      });
    }
  }

  const entities = Array.from(entityMap.values());
  logger.info(
    `[agent-export] Found ${entities.length} entities, ${participantRecords.length} participant records`,
  );

  // 5. Components for all entities (deduplicated by ID)
  const componentIds = new Set<string>();
  const allComponents: Component[] = [];
  const addComponent = (c: Component) => {
    if (c.id && !componentIds.has(c.id)) {
      componentIds.add(c.id);
      allComponents.push(c);
    }
  };
  for (const entity of entities) {
    if (!entity.id) continue;
    for (const c of await db.getComponentsForEntities([entity.id]))
      addComponent(c);
    for (const world of agentWorlds) {
      if (!world.id) continue;
      for (const c of await db.getComponentsForEntities([entity.id], world.id))
        addComponent(c);
    }
  }
  logger.info(`[agent-export] Found ${allComponents.length} components`);

  // 6. Memories — query all known table names
  const allMemories: Memory[] = [];
  const memoryIdSet = new Set<string>();

  for (const tableName of MEMORY_TABLES) {
    const memories = await db.getMemories({
      agentId,
      tableName,
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const mem of memories) {
      if (mem.id && !memoryIdSet.has(mem.id)) {
        memoryIdSet.add(mem.id);
        // Strip embeddings to reduce file size — they can be regenerated
        allMemories.push({ ...mem, embedding: undefined });
      }
    }
  }

  // Also try querying memories by world
  for (const world of agentWorlds) {
    if (!world.id) continue;
    for (const tableName of MEMORY_TABLES) {
      const worldMemories = await db.getMemoriesByWorldId({
        worldIds: [world.id],
        limit: Number.MAX_SAFE_INTEGER,
        tableName,
      });
      for (const mem of worldMemories) {
        if (mem.id && !memoryIdSet.has(mem.id)) {
          memoryIdSet.add(mem.id);
          allMemories.push({ ...mem, embedding: undefined });
        }
      }
    }
  }

  logger.info(`[agent-export] Found ${allMemories.length} memories`);

  // 7. Relationships
  const relationships = await db.getRelationships({ entityIds: [agentId] });
  logger.info(`[agent-export] Found ${relationships.length} relationships`);

  // 8. Tasks
  // The Task proto type does not declare agentId, but the DB schema stores
  // agent_id. Filter using a dynamic property access to handle both shapes.
  const allTasks = await db.getTasks({ agentIds: [agentId] });
  const agentTasks = allTasks.filter((t) => taskAgentId(t) === agentId);
  logger.info(`[agent-export] Found ${agentTasks.length} tasks`);

  // 9. Logs (optional)
  let logs: Log[] = [];
  if (options.includeLogs) {
    logs = await db.getLogs({ limit: Number.MAX_SAFE_INTEGER });
    logger.info(`[agent-export] Found ${logs.length} logs`);
  }

  // 10. Runtime character config — captures fields from buildCharacterFromConfig
  // that may not be persisted in the DB agent record (style, topics, adjectives,
  // messageExamples, postExamples, knowledge sources, etc.)
  let characterConfig: Omit<Character, "secrets"> | undefined;
  if (runtime.character) {
    // Clone and strip secrets/sensitive fields
    const { secrets: _secrets, ...safeChar } = runtime.character;
    characterConfig = safeChar;
    logger.info(
      `[agent-export] Captured runtime character config (${Object.keys(safeChar).length} fields)`,
    );
  }

  const payload: AgentExportPayload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceAgentId: agentId,
    agent,
    characterConfig,
    entities,
    memories: allMemories,
    components: allComponents,
    rooms,
    participants: participantRecords,
    relationships,
    worlds: agentWorlds,
    tasks: agentTasks,
    logs,
    media: captureReferencedMedia(allMemories),
  };
  // Per-component integrity manifest (#9963): digest each collection so import
  // can re-verify structural consistency before writing anything to the DB.
  payload.manifest = buildExportManifest(payload);
  logger.info(
    `[agent-export] Integrity manifest: ${MANIFEST_COLLECTIONS.length} collections digested (sha256)`,
  );
  return payload;
}

// ---------------------------------------------------------------------------
// ID remapping for import
// ---------------------------------------------------------------------------

function createIdRemapper(
  fixed?: Map<string, string>,
): (oldId: string) => string {
  const map = new Map<string, string>(fixed);
  return (oldId: string): string => {
    if (!oldId) return oldId;
    const existing = map.get(oldId);
    if (existing) return existing;
    const newId = crypto.randomUUID();
    map.set(oldId, newId);
    return newId;
  };
}

// ---------------------------------------------------------------------------
// Data restoration
// ---------------------------------------------------------------------------

async function restoreAgentData(
  runtime: AgentRuntime,
  payload: AgentExportPayload,
): Promise<ImportResult> {
  const db = runtime.adapter;
  const newAgentId = crypto.randomUUID() as UUID;
  const remap = createIdRemapper(
    new Map([[payload.sourceAgentId, newAgentId]]),
  );

  logger.info(
    `[agent-import] Importing agent "${payload.agent.name}" as ${newAgentId}`,
  );

  // 1. Create agent — merge characterConfig (if present) as a base so
  //    style/topics/adjectives/messageExamples survive the round-trip even
  //    if the DB agent record didn't persist them.
  // Spread and explicitly exclude secrets. characterConfig is already typed as
  // Omit<Character, "secrets">, but strip the field defensively for runtime safety.
  const { secrets: _secrets, ...charBase } = payload.characterConfig
    ? ({ ...payload.characterConfig } as { secrets?: unknown } & Record<
        string,
        unknown
      >)
    : ({} as { secrets?: unknown } & Record<string, unknown>);

  const agentData = { ...charBase, ...payload.agent } as Partial<Agent>;
  agentData.id = newAgentId;
  agentData.enabled = true;
  agentData.createdAt = Date.now();
  agentData.updatedAt = Date.now();

  const agentCreatedIds = await db.createAgents([agentData]);
  if (!agentCreatedIds || agentCreatedIds.length === 0) {
    throw new AgentExportError("Failed to create agent in database.");
  }
  logger.info(
    `[agent-import] Created agent record${payload.characterConfig ? " (merged with characterConfig)" : ""}`,
  );

  // 2. Create worlds
  let worldsImported = 0;
  for (const world of payload.worlds) {
    const newWorld: World = {
      ...world,
      id: remap(world.id) as UUID,
      agentId: newAgentId as UUID,
    };
    await db.createWorlds([newWorld]);
    worldsImported++;
  }
  logger.info(`[agent-import] Imported ${worldsImported} worlds`);

  // 3. Create rooms
  let roomsImported = 0;
  const roomBatch: Room[] = [];
  for (const room of payload.rooms) {
    const newRoom: Room = {
      ...room,
      id: remap(room.id) as UUID,
      agentId: newAgentId as UUID,
      worldId: room.worldId ? (remap(room.worldId) as UUID) : undefined,
    };
    roomBatch.push(newRoom);
  }
  if (roomBatch.length > 0) {
    await db.createRooms(roomBatch);
    roomsImported = roomBatch.length;
  }
  logger.info(`[agent-import] Imported ${roomsImported} rooms`);

  // 4. Create entities
  let entitiesImported = 0;
  const entityBatch: Entity[] = [];
  for (const entity of payload.entities) {
    const newEntity: Entity = {
      ...entity,
      id: remap(entity.id ?? "") as UUID,
      agentId: newAgentId as UUID,
      // Strip components — we'll recreate them separately
      components: undefined,
    };
    entityBatch.push(newEntity);
  }
  if (entityBatch.length > 0) {
    await db.createEntities(entityBatch);
    entitiesImported = entityBatch.length;
  }
  logger.info(`[agent-import] Imported ${entitiesImported} entities`);

  // 5. Add participants to rooms
  let participantsImported = 0;
  for (const p of payload.participants) {
    const newEntityId = remap(p.entityId) as UUID;
    const newRoomId = remap(p.roomId) as UUID;
    await db.createRoomParticipants([newEntityId], newRoomId);
    if (p.userState === "FOLLOWED" || p.userState === "MUTED") {
      await db.updateParticipantUserStates([
        { roomId: newRoomId, entityId: newEntityId, state: p.userState },
      ]);
    }
    participantsImported++;
  }
  logger.info(`[agent-import] Imported ${participantsImported} participants`);

  // 6. Create components
  let componentsImported = 0;
  for (const comp of payload.components) {
    const newComp: Component = {
      ...comp,
      id: remap(comp.id) as UUID,
      ...(comp.entityId ? { entityId: remap(comp.entityId) as UUID } : {}),
      ...(comp.agentId ? { agentId: newAgentId as UUID } : {}),
      ...(comp.roomId ? { roomId: remap(comp.roomId) as UUID } : {}),
      ...(comp.worldId ? { worldId: remap(comp.worldId) as UUID } : {}),
      ...(comp.sourceEntityId
        ? { sourceEntityId: remap(comp.sourceEntityId) as UUID }
        : {}),
    };
    await db.createComponents([newComp]);
    componentsImported++;
  }
  logger.info(`[agent-import] Imported ${componentsImported} components`);

  // 7. Create memories
  let memoriesImported = 0;
  for (const mem of payload.memories) {
    const tableName = resolveMemoryTableName(mem);
    const newMem: Memory = {
      ...mem,
      id: remap(mem.id ?? "") as UUID,
      agentId: newAgentId as UUID,
      ...(mem.entityId ? { entityId: remap(mem.entityId) as UUID } : {}),
      ...(mem.roomId ? { roomId: remap(mem.roomId) as UUID } : {}),
      ...(mem.worldId ? { worldId: remap(mem.worldId) as UUID } : {}),
      // Embeddings are excluded — they will be regenerated
      embedding: undefined,
    };
    await db.createMemories([{ memory: newMem, tableName }]);
    memoriesImported++;
  }
  logger.info(`[agent-import] Imported ${memoriesImported} memories`);

  // 8. Create relationships
  let relationshipsImported = 0;
  for (const rel of payload.relationships) {
    await db.createRelationships([
      {
        sourceEntityId: remap(rel.sourceEntityId) as UUID,
        targetEntityId: remap(rel.targetEntityId) as UUID,
        tags: rel.tags,
        metadata: rel.metadata,
      },
    ]);
    relationshipsImported++;
  }
  logger.info(`[agent-import] Imported ${relationshipsImported} relationships`);

  // 9. Create tasks
  // The Task type doesn't declare agentId but the DB schema stores it.
  // We spread the original task and add agentId as a dynamic property
  // that the database adapter will persist.
  let tasksImported = 0;
  for (const task of payload.tasks) {
    const newTask = {
      ...task,
      id: remap(task.id ?? "") as UUID,
      agentId: newAgentId as UUID,
      roomId: task.roomId ? (remap(task.roomId) as UUID) : undefined,
      worldId: task.worldId ? (remap(task.worldId) as UUID) : undefined,
      entityId: task.entityId ? (remap(task.entityId) as UUID) : undefined,
    } as Task;
    await db.createTasks([newTask]);
    tasksImported++;
  }
  logger.info(`[agent-import] Imported ${tasksImported} tasks`);

  // 10. Create logs
  let logsImported = 0;
  for (const logEntry of payload.logs) {
    await db.createLogs([
      {
        body: logEntry.body,
        entityId: (logEntry.entityId
          ? (remap(logEntry.entityId) as UUID)
          : logEntry.entityId) as UUID,
        roomId: logEntry.roomId
          ? (remap(logEntry.roomId) as UUID)
          : (newAgentId as UUID),
        type: logEntry.type,
      },
    ]);
    logsImported++;
  }
  logger.info(`[agent-import] Imported ${logsImported} logs`);

  const mediaRestored = restoreMedia(payload.media);
  if (mediaRestored > 0) {
    logger.info(`[agent-import] Restored ${mediaRestored} media files`);
  }

  return {
    success: true,
    agentId: newAgentId,
    agentName: (payload.agent.name as string) ?? "Unknown",
    counts: {
      memories: memoriesImported,
      entities: entitiesImported,
      components: componentsImported,
      rooms: roomsImported,
      participants: participantsImported,
      relationships: relationshipsImported,
      worlds: worldsImported,
      tasks: tasksImported,
      logs: logsImported,
      media: mediaRestored,
    },
  };
}

/**
 * Resolve the memory table name from a memory record's metadata.
 * The elizaOS adapter requires a tableName for createMemory.
 */
function resolveMemoryTableName(mem: Memory): string {
  const metaType = mem.metadata?.type;
  if (metaType === "message") return "messages";
  if (metaType === "document") return "documents";
  if (metaType === "fragment") return "fragments";
  if (metaType === "description") return "descriptions";
  if (metaType === "custom") return "custom";

  // Fallback: use the "type" field on the memory itself (elizaOS stores it
  // as a top-level field in the DB row, which the proto Memory type inherits).
  const memType = (mem as Memory & { type?: string }).type;
  if (typeof memType === "string" && memType.length > 0) return memType;

  return "messages";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export the current agent's full state as a password-encrypted binary file.
 *
 * @param runtime - The running AgentRuntime with an active database adapter
 * @param password - User-provided password for encryption
 * @param options - Export options (e.g., whether to include logs)
 * @returns A Buffer containing the encrypted .eliza-agent file
 */
export async function exportAgent(
  runtime: AgentRuntime,
  password: string,
  options: AgentExportOptions = {},
): Promise<Buffer> {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new AgentExportError(
      `A password of at least ${MIN_PASSWORD_LENGTH} characters is required to encrypt the export.`,
    );
  }

  if (!runtime.adapter) {
    throw new AgentExportError("No database adapter available on the runtime.");
  }

  const payload = await extractAgentData(runtime, {
    includeLogs: options.includeLogs ?? false,
  });

  const jsonString = JSON.stringify(payload);
  const compressed = gzipSync(Buffer.from(jsonString, "utf-8"));

  logger.info(
    `[agent-export] Payload: ${jsonString.length} bytes JSON → ${compressed.length} bytes compressed`,
  );

  const encrypted = await encrypt(compressed, password);
  const fileBuffer = packFile(encrypted);

  logger.info(`[agent-export] Final file size: ${fileBuffer.length} bytes`);

  return fileBuffer;
}

/**
 * Import an agent from a password-encrypted .eliza-agent file.
 *
 * @param runtime - An AgentRuntime with an active database adapter (the agent
 *                  will be created in this database, not overwriting the current agent)
 * @param fileBuffer - The raw bytes of the .eliza-agent file
 * @param password - The password used when the file was exported
 * @returns An ImportResult describing what was imported
 */
export async function importAgent(
  runtime: AgentRuntime,
  fileBuffer: Buffer,
  password: string,
): Promise<ImportResult> {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new AgentExportError(
      `A password of at least ${MIN_PASSWORD_LENGTH} characters is required to decrypt the import.`,
    );
  }

  if (!runtime.adapter) {
    throw new AgentExportError("No database adapter available on the runtime.");
  }

  // 1. Unpack file structure
  const { salt, iv, tag, ciphertext, iterations } = unpackFile(fileBuffer);

  // 2. Decrypt
  let compressed: Buffer;
  try {
    compressed = await decrypt(ciphertext, password, salt, iv, tag, iterations);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Unsupported state") ||
        err.message.includes("unable to authenticate") ||
        err.message.includes("auth"))
    ) {
      throw new AgentExportError(
        "Incorrect password — decryption failed. Please check your password and try again.",
      );
    }
    throw new AgentExportError(`Decryption failed: ${String(err)}`);
  }

  // 3. Decompress
  let jsonString: string;
  try {
    const decompressed = await gunzipWithSizeLimit(compressed);
    jsonString = decompressed.toString("utf-8");
  } catch (err) {
    if (err instanceof AgentExportError) throw err;
    throw new AgentExportError(
      `Decompression failed — the file may be corrupt: ${String(err)}`,
    );
  }

  // 4. Parse JSON
  let rawPayload: Record<string, unknown>;
  try {
    rawPayload = JSON.parse(jsonString) as Record<string, unknown>;
  } catch (err) {
    throw new AgentExportError(
      `JSON parse failed — the export data is malformed: ${String(err)}`,
    );
  }

  // 5. Validate schema
  const parseResult = PayloadSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new AgentExportError(
      `Export file schema validation failed: ${issues}`,
    );
  }

  const payload = toAgentExportPayload(parseResult.data);

  if (payload.version > EXPORT_VERSION) {
    throw new AgentExportError(
      `Unsupported export version ${payload.version}. This build supports up to version ${EXPORT_VERSION}. ` +
        "Please update your software to import this file.",
    );
  }

  logger.info(
    `[agent-import] Importing agent "${payload.agent.name}" exported at ${payload.exportedAt}`,
  );

  // 6. Per-component integrity check (#9963). The AES-256-GCM auth tag already
  // authenticated the ciphertext; this re-verifies each collection's sha256 +
  // row count against the embedded manifest BEFORE any DB write, so a
  // structurally-inconsistent payload (truncated, hand-edited, partially merged)
  // fails loudly and names the offending collection instead of half-importing.
  const integrity = verifyExportManifest(payload);
  if (!integrity.ok) {
    const detail = integrity.mismatches
      .map(
        (m) =>
          `${m.collection} (manifest ${m.expected.count} rows/${m.expected.sha256.slice(0, 12)}…, payload ${m.actual.count}/${m.actual.sha256.slice(0, 12)}…)`,
      )
      .join("; ");
    throw new AgentExportError(
      `Integrity check failed — export payload is inconsistent with its manifest: ${detail}. The file may be corrupt or was modified after export; nothing was imported.`,
    );
  }
  if (integrity.present) {
    logger.info(
      "[agent-import] Integrity manifest verified — all collections match",
    );
  } else {
    logger.debug(
      "[agent-import] No integrity manifest (older export); skipping per-component verification",
    );
  }

  // 7. Restore data
  return restoreAgentData(runtime, payload);
}

/**
 * Estimate the size of an agent export without actually creating it.
 * Useful for showing the user how large the export will be.
 */
export async function estimateExportSize(
  runtime: AgentRuntime,
): Promise<ExportSizeEstimate> {
  const db = runtime.adapter;
  const agentId = runtime.agentId;

  let memoriesCount = 0;
  for (const tableName of MEMORY_TABLES) {
    const mems = await db.getMemories({
      agentId,
      tableName,
      limit: Number.MAX_SAFE_INTEGER,
    });
    memoriesCount += mems.length;
  }

  const allWorlds = await db.getAllWorlds();
  const agentWorlds = allWorlds.filter((w) => w.agentId === agentId);

  const roomIds = await db.getRoomsForParticipants([agentId]);
  const entityIdSet = new Set<string>();
  if (roomIds.length > 0) {
    const entitiesResult = await db.getEntitiesForRooms(
      roomIds as UUID[],
      true,
    );
    for (const result of entitiesResult) {
      for (const e of result.entities) {
        if (e.id) entityIdSet.add(e.id);
      }
    }
  }

  const tasks = await db.getTasks({ agentIds: [agentId] });
  const agentTasks = tasks.filter((t) => taskAgentId(t) === agentId);

  // Rough estimate: ~500 bytes per memory, ~200 bytes per entity, ~300 per room
  const estimatedBytes =
    memoriesCount * 500 +
    entityIdSet.size * 200 +
    roomIds.length * 300 +
    agentWorlds.length * 200 +
    agentTasks.length * 400 +
    2000; // base overhead

  return {
    estimatedBytes,
    memoriesCount,
    entitiesCount: entityIdSet.size,
    roomsCount: roomIds.length,
    worldsCount: agentWorlds.length,
    tasksCount: agentTasks.length,
  };
}

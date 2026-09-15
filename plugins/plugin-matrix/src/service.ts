/**
 * Matrix service implementation for ElizaOS.
 *
 * This service provides Matrix messaging capabilities using matrix-js-sdk.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deserialize as v8Deserialize, serialize as v8Serialize } from "node:v8";
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type EventPayload,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  lifeOpsPassiveConnectorsEnabled,
  logger,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorTarget,
  resolveAliasedEnvValue,
  Service,
  type TargetInfo,
  toWellFormedUnicode,
  truncateWellFormed,
  type UUID,
} from "@elizaos/core";
import * as sdk from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import {
  CryptoEvent,
  canAcceptVerificationRequest,
  type ShowSasCallbacks,
  VerificationPhase,
  type VerificationRequest,
  VerificationRequestEvent,
  type Verifier,
  VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api";
import {
  DEFAULT_MATRIX_ACCOUNT_ID,
  listMatrixAccountIds,
  normalizeMatrixAccountId,
  readMatrixAccountId,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccountSettings,
} from "./accounts.js";
import { waitForMatrixPrepared } from "./matrix-sync.js";
import {
  classifyMatrixTransition,
  type MatrixMembershipAuthority,
  matrixMemberRoles,
  matrixObservedAt,
} from "./membership.js";
import { createMatrixMembershipGate, MatrixMembershipMessageGate } from "./membership-gate.js";
import {
  getMatrixLocalpart,
  type IMatrixService,
  isValidMatrixRoomAlias,
  isValidMatrixRoomId,
  MATRIX_SERVICE_NAME,
  MatrixConfigurationError,
  MatrixEventTypes,
  type MatrixMessage,
  type MatrixMessageSendOptions,
  MatrixNotConnectedError,
  type MatrixRoom,
  type MatrixSendResult,
  type MatrixSettings,
  type MatrixUserInfo,
} from "./types.js";

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Deterministic, authority-compatible UUID for Matrix-derived rows. Core's
 * createUniqueUuid stamps a custom version nibble of 0, which the canonical
 * membership authority's UUID validation (version nibble [1-8]) rejects — so
 * every id that flows into a MembershipService command (principal entities,
 * scope worlds/rooms, gate lookups) must carry RFC 4122 version/variant bits
 * instead. Re-stamping only those two nibbles keeps the id deterministic per
 * (agent, seed); the scoped space is disjoint from the base scheme (base
 * always carries version nibble 0, scoped always 5) and 2 bits narrower than
 * the base scheme within it (variant nibble collapse), still 120 bits.
 */
function matrixScopedUuid(runtime: IAgentRuntime, seed: string): UUID {
  const base = createUniqueUuid(runtime, seed);
  return `${base.slice(0, 14)}5${base.slice(15, 19)}8${base.slice(20)}` as UUID;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matrixRoomSearchText(room: MatrixRoom): string {
  return [room.roomId, room.name, room.topic, room.canonicalAlias]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function scoreMatrixRoom(room: MatrixRoom, query: string): number {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) {
    return 0.4;
  }

  const candidates = [room.roomId, room.canonicalAlias, room.name].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (candidates.some((candidate) => candidate.toLowerCase() === normalized)) {
    return 1;
  }
  if (candidates.some((candidate) => candidate.toLowerCase().includes(normalized))) {
    return 0.85;
  }
  return matrixRoomSearchText(room).includes(normalized) ? 0.65 : 0;
}

function matrixRoomToConnectorTarget(
  room: MatrixRoom,
  score = 0.5,
  accountId = DEFAULT_MATRIX_ACCOUNT_ID
): MessageConnectorTarget {
  const label = room.name || room.canonicalAlias || room.roomId;
  return {
    target: {
      source: MATRIX_SERVICE_NAME,
      accountId,
      channelId: room.roomId,
    },
    label,
    kind: room.isDirect ? "user" : "room",
    description:
      room.topic || `${room.memberCount} Matrix member${room.memberCount === 1 ? "" : "s"}`,
    score,
    contexts: ["social", "connectors"],
    metadata: {
      accountId,
      roomId: room.roomId,
      canonicalAlias: room.canonicalAlias,
      isEncrypted: room.isEncrypted,
      isDirect: room.isDirect,
      memberCount: room.memberCount,
    },
  };
}

type ConnectorHookContext = {
  runtime: IAgentRuntime;
  roomId?: UUID;
  target?: TargetInfo;
};

type ConnectorReadParams = {
  target?: TargetInfo;
  limit?: number;
  query?: string;
};

type ConnectorMutationParams = {
  target?: TargetInfo;
  messageId?: string;
  eventId?: string;
  emoji?: string;
};

type ConnectorRoomMembershipParams = {
  target?: TargetInfo;
  roomId?: string;
  roomIdOrAlias?: string;
  alias?: string;
  invite?: string;
  channelId?: string;
};

type AdditiveMessageConnectorHooks = {
  fetchMessages?: (
    context: ConnectorHookContext,
    params?: ConnectorReadParams
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: ConnectorHookContext,
    params: ConnectorReadParams & { query: string }
  ) => Promise<Memory[]>;
  reactHandler?: (runtime: IAgentRuntime, params: ConnectorMutationParams) => Promise<void>;
  joinHandler?: (runtime: IAgentRuntime, params: ConnectorRoomMembershipParams) => Promise<void>;
  leaveHandler?: (runtime: IAgentRuntime, params: ConnectorRoomMembershipParams) => Promise<void>;
};

type ExtendedMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] &
  AdditiveMessageConnectorHooks;

type MatrixAccountState = {
  accountId: string;
  settings: MatrixSettings;
  client: sdk.MatrixClient;
  connected: boolean;
  syncing: boolean;
  cryptoSnapshotTimer?: ReturnType<typeof setInterval>;
  /** Membership-authority gate for this account; null when absent/failed. */
  membershipGate?: MatrixMembershipMessageGate;
  /** Authority handle for evidence publication; null when absent. */
  membershipAuthority?: MatrixMembershipAuthority;
  /**
   * Snapshot evidence identity: a per-STATE instance token (rotates whenever
   * account state is constructed) plus a monotonically increasing observation
   * counter. Together they make every snapshot idempotency key unique to one
   * observation by one state instance, so restarts, resyncs, and in-process
   * state reconstruction never reuse keys.
   */
  membershipSnapshotToken: string;
  membershipSnapshotCounter: number;
};

/**
 * Serialized form of an IndexedDB database: object-store schemas plus their
 * records. v8.serialize handles the structured-clone values (typed arrays,
 * Maps, etc.) the rust-crypto store writes, so this shape round-trips losslessly.
 */
export type CryptoStoreSnapshot = {
  version: number;
  stores: Record<
    string,
    {
      schema: {
        keyPath: IDBObjectStore["keyPath"];
        autoIncrement: boolean;
        indexes: {
          name: string;
          keyPath: IDBIndex["keyPath"];
          unique: boolean;
          multiEntry: boolean;
        }[];
      };
      records: { key: IDBValidKey; value: unknown }[];
    }
  >;
};

// The matrix-js-sdk rust-crypto backend persists its entire state — device
// identity, cross-signing, and inbound megolm sessions — in an IndexedDB
// database named `${prefix}::matrix-sdk-crypto` when initRustCrypto({
// useIndexedDB: true }) is used. With multiple encrypted accounts in one
// process the prefix MUST differ per account or they collide on one store; the
// default account keeps the SDK's default prefix so its existing persisted
// device is unaffected.
const DEFAULT_CRYPTO_DB_PREFIX = "matrix-js-sdk";

function cryptoDbPrefix(accountId: string): string {
  if (!accountId || accountId === DEFAULT_MATRIX_ACCOUNT_ID) {
    return DEFAULT_CRYPTO_DB_PREFIX;
  }
  const safeId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_") || "account";
  return `${DEFAULT_CRYPTO_DB_PREFIX}-${safeId}`;
}

function cryptoDbName(accountId: string): string {
  return `${cryptoDbPrefix(accountId)}::matrix-sdk-crypto`;
}

const CRYPTO_SNAPSHOT_INTERVAL_MS = 60 * 1000;
// Grace period before the bot starts SAS itself, letting the initiator's start
// win the race so the two sides don't compute the SAS over different events.
const VERIFICATION_START_FALLBACK_MS = 4000;
const ROOM_KEY_SCRYPT_SALT = "matrix.roomKeys.v1";
const ROOM_KEY_BYTES = 32;
const ROOM_AUTH_TAG_BYTES = 16;
const ROOM_KEY_NONCE_BYTES = 12;

/**
 * Resolve the per-user state root the runtime already uses for on-disk state.
 * Matches the ELIZA_STATE_DIR convention so the encrypted
 * room-key files land next to the rest of the agent's persistent state.
 */
function resolveStateDir(): string {
  return resolveAliasedEnvValue("ELIZA_STATE_DIR") || join(homedir(), ".local/state/eliza");
}

/**
 * Derive the encrypted crypto-store file path for an account. The account id is
 * sanitized so an arbitrary configured id can never escape the keys directory.
 * The file holds the full serialized rust-crypto IndexedDB snapshot (device
 * identity, cross-signing, and inbound megolm sessions), not just room keys.
 */
function cryptoStoreFilePath(accountId: string): string {
  const safeId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
  return join(resolveStateDir(), "matrix-keys", `${safeId}.enc`);
}

/**
 * AES-256-GCM envelope matching the vault wire format
 * (`v1:<nonce_b64>:<tag_b64>:<ct_b64>`). The key is derived per-account from the
 * access token via scrypt, so the at-rest file never contains usable crypto
 * state without the live token. Operates on Buffers: the crypto-store snapshot
 * is a v8-serialized binary blob, so there is no intermediate string form.
 */
function encryptCryptoStore(accessToken: string, plaintext: Buffer): string {
  const key = scryptSync(accessToken, ROOM_KEY_SCRYPT_SALT, ROOM_KEY_BYTES);
  const nonce = randomBytes(ROOM_KEY_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${nonce.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function decryptCryptoStore(accessToken: string, ciphertext: string): Buffer {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("malformed crypto-store ciphertext");
  }
  const key = scryptSync(accessToken, ROOM_KEY_SCRYPT_SALT, ROOM_KEY_BYTES);
  const nonce = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
    authTagLength: ROOM_AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Open an IndexedDB database. With a version + upgrade callback this triggers a
 * schema upgrade; without, it opens at the current version. Resolves the
 * IDBDatabase or rejects with the request error.
 */
function openIndexedDb(
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
    if (upgrade) {
      request.onupgradeneeded = (event) => upgrade((event.target as IDBOpenDBRequest).result);
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Read every object store of an IndexedDB database into a serializable snapshot:
 * each store's schema (keyPath, autoIncrement, indexes) plus all of its records.
 * Pure over the global `indexedDB`, so it is unit-testable with fake-indexeddb.
 */
export async function snapshotDb(name: string): Promise<CryptoStoreSnapshot> {
  const db = await openIndexedDb(name);
  const snapshot: CryptoStoreSnapshot = { version: db.version, stores: {} };
  for (const storeName of [...db.objectStoreNames]) {
    const store = db.transaction(storeName, "readonly").objectStore(storeName);
    const records: { key: IDBValidKey; value: unknown }[] = [];
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          records.push({ key: cursor.primaryKey, value: cursor.value });
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
    snapshot.stores[storeName] = {
      schema: {
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((indexName) => {
          const index = store.index(indexName);
          return {
            name: indexName,
            keyPath: index.keyPath,
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        }),
      },
      records,
    };
  }
  db.close();
  return snapshot;
}

/**
 * Recreate an IndexedDB database from a snapshot: delete any existing db, build
 * the stores + indexes in an upgrade transaction, then replay the records.
 * Keyless stores re-supply the out-of-line key; keyPath stores derive it.
 * Pure over the global `indexedDB`, so it is unit-testable with fake-indexeddb.
 */
export async function restoreDb(name: string, snapshot: CryptoStoreSnapshot): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
  const db = await openIndexedDb(name, snapshot.version, (upgradeDb) => {
    for (const [storeName, { schema }] of Object.entries(snapshot.stores)) {
      const store = upgradeDb.createObjectStore(storeName, {
        keyPath: schema.keyPath ?? undefined,
        autoIncrement: schema.autoIncrement,
      });
      for (const index of schema.indexes) {
        store.createIndex(index.name, index.keyPath, {
          unique: index.unique,
          multiEntry: index.multiEntry,
        });
      }
    }
  });
  for (const [storeName, { schema, records }] of Object.entries(snapshot.stores)) {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const { key, value } of records) {
      if (schema.keyPath) {
        store.put(value);
      } else {
        store.put(value, key);
      }
    }
    await transactionDone(tx);
  }
  db.close();
}

function normalizeConnectorLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError("Matrix connector limit must be a positive finite number");
  }
  return Math.floor(limit);
}

/**
 * Map a raw Matrix timeline event to a MatrixMessage. Returns null for events
 * we don't surface as chat: non-text msgtypes, non-string bodies, and events
 * without a room id (this also naturally skips state events and still-encrypted
 * events whose type stays "m.room.encrypted").
 */
function buildMatrixMessage(event: sdk.MatrixEvent, room: sdk.Room): MatrixMessage | null {
  const content = event.getContent();
  const msgType = content.msgtype;
  if (msgType !== "m.text") return null;
  if (typeof content.body !== "string") return null;

  const roomId = event.getRoomId();
  if (!roomId) return null;

  const sender = event.getSender();
  const senderMember = room.getMember(sender || "");

  const senderInfo: MatrixUserInfo = {
    userId: sender || "",
    displayName: senderMember?.name,
    avatarUrl: senderMember?.getMxcAvatarUrl() || undefined,
  };

  const relatesTo = content["m.relates_to"];
  const isEdit = relatesTo?.rel_type === "m.replace";
  const threadId = relatesTo?.rel_type === "m.thread" ? relatesTo.event_id : undefined;
  const replyTo = relatesTo?.["m.in_reply_to"]?.event_id;

  return {
    eventId: event.getId() || "",
    roomId,
    sender: sender || "",
    senderInfo,
    content: content.body,
    msgType,
    formattedBody: typeof content.formatted_body === "string" ? content.formatted_body : undefined,
    timestamp: event.getTs(),
    threadId,
    replyTo,
    isEdit,
    replacesEventId: isEdit ? relatesTo?.event_id : undefined,
  };
}

/**
 * Build a core Memory from a MatrixMessage, deriving deterministic ids the same
 * way the inbound dispatch path does so reads and the live message loop agree.
 * When `accountScope` is set (multi-account runtime), every seed is prefixed
 * with the account id so two Matrix accounts observing the same room never
 * share room/entity ids.
 */
function matrixMessageToMemory(
  runtime: IAgentRuntime,
  message: Pick<
    MatrixMessage,
    "roomId" | "eventId" | "timestamp" | "sender" | "content" | "replyTo"
  >,
  channelType: ChannelType,
  accountScope?: string
): Memory {
  const roomId = message.roomId;
  const scoped = (seed: string) => (accountScope ? `${accountScope}:${seed}` : seed);
  // Write path must key memories by the SAME authority-compatible
  // derivation the read fallback (readMessagesForTarget) uses — a v0
  // createUniqueUuid here would make every stored message invisible to
  // the matrixScopedUuid-keyed reader.
  return {
    id: matrixScopedUuid(runtime, scoped(message.eventId || `${roomId}:${message.timestamp}`)),
    entityId: matrixScopedUuid(runtime, scoped(message.sender || roomId)),
    agentId: runtime.agentId,
    roomId: matrixScopedUuid(runtime, scoped(message.roomId)),
    content: {
      text: message.content,
      source: MATRIX_SERVICE_NAME,
      channelType,
      ...(message.replyTo ? { inReplyTo: matrixScopedUuid(runtime, scoped(message.replyTo)) } : {}),
    },
    createdAt: message.timestamp,
  };
}

async function readStoredMessageMemories(
  runtime: IAgentRuntime,
  roomId: UUID,
  limit: number | undefined
): Promise<Memory[]> {
  return runtime.getMemories({
    tableName: "messages",
    roomId,
    ...(limit === undefined ? {} : { limit }),
    orderBy: "createdAt",
    orderDirection: "desc",
  });
}

/**
 * Resolve the raw Matrix room id (e.g. "!abc:server") for a connector target.
 * The canonical `read_channel "<room>"` path sets the room only in
 * `target.channelId`; older resolved targets may instead carry the core room
 * UUID in `target.roomId`, from which the raw id is recoverable via getRoom().
 */
async function resolveMatrixRoomId(
  runtime: IAgentRuntime,
  target: TargetInfo | undefined
): Promise<string> {
  return String(
    target?.channelId ??
      (target?.roomId ? (await runtime.getRoom(target.roomId))?.channelId : "") ??
      ""
  ).trim();
}

/**
 * Read recent messages across the account's joined rooms, newest-first. Uses
 * the live SDK timeline (and encrypted placeholders) per room — the same source
 * as the single-room branch — so the multi-room/recent case stays consistent.
 */
async function readJoinedRoomMessages(
  service: MatrixService,
  accountId: string,
  limit: number | undefined
): Promise<Memory[]> {
  const rooms = await service.getJoinedRooms(accountId);
  const chunks = await Promise.all(
    rooms.map((room) => service.getRoomMessages(room.roomId, limit, accountId))
  );
  const sorted = chunks.flat().sort((left, right) => {
    const r =
      typeof right.createdAt === "number" && Number.isFinite(right.createdAt) ? right.createdAt : 0;
    const l =
      typeof left.createdAt === "number" && Number.isFinite(left.createdAt) ? left.createdAt : 0;
    return r - l;
  });
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/**
 * Read up to `limit` messages for a connector target: resolve the target to a
 * Matrix room and read its live timeline (falling back to stored memories when
 * the live read is empty), or read across all joined rooms when the target names
 * no specific room. Shared by the fetchMessages and searchMessages hooks.
 */
async function readMessagesForTarget(
  service: MatrixService,
  runtime: IAgentRuntime,
  accountId: string,
  target: TargetInfo | undefined,
  limit: number | undefined
): Promise<Memory[]> {
  const matrixRoomId = await resolveMatrixRoomId(runtime, target);
  if (!matrixRoomId) {
    return readJoinedRoomMessages(service, accountId, limit);
  }
  const live = await service.getRoomMessages(matrixRoomId, limit, accountId);
  if (live.length > 0) {
    return live;
  }
  // Account-scoped key, matching how matrixMessageToMemory persists inbound
  // memories since the account-scoping change.
  return readStoredMessageMemories(
    runtime,
    matrixScopedUuid(runtime, `${accountId}:${matrixRoomId}`),
    limit
  );
}

function filterMemoriesByQuery(
  memories: Memory[],
  query: string,
  limit: number | undefined
): Memory[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return limit === undefined ? memories : memories.slice(0, limit);
  }
  const matches = memories.filter((memory) => {
    const text = typeof memory.content?.text === "string" ? memory.content.text : "";
    return text.toLowerCase().includes(normalized);
  });
  return limit === undefined ? matches : matches.slice(0, limit);
}

function extractMatrixSendOptions(content: Content, target: TargetInfo): MatrixMessageSendOptions {
  const data = content.data as Record<string, unknown> | undefined;
  const matrixData = (data?.matrix && typeof data.matrix === "object" ? data.matrix : data) as
    | Record<string, unknown>
    | undefined;

  return {
    threadId:
      target.threadId ||
      (typeof matrixData?.threadId === "string" ? matrixData.threadId : undefined),
    replyTo: typeof matrixData?.replyTo === "string" ? matrixData.replyTo : undefined,
    formatted: matrixData?.formatted === true,
  };
}

/**
 * Matrix messaging service for ElizaOS agents.
 */
export class MatrixService extends Service implements IMatrixService {
  static serviceType: string = MATRIX_SERVICE_NAME;

  capabilityDescription = "Matrix messaging service for chat communication";

  protected declare runtime: IAgentRuntime;
  private states = new Map<string, MatrixAccountState>();
  private defaultAccountId = DEFAULT_MATRIX_ACCOUNT_ID;

  /**
   * Start the Matrix service.
   */
  static async start(runtime: IAgentRuntime): Promise<MatrixService> {
    const service = new MatrixService();
    await service.initialize(runtime);
    return service;
  }

  /**
   * Stop the Matrix service.
   */
  static override async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(MATRIX_SERVICE_NAME) as MatrixService | undefined;
    if (service) {
      await service.stop();
    }
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    service: MatrixService,
    accountId = service.getAccountId(runtime)
  ): void {
    accountId = normalizeMatrixAccountId(accountId);
    const sendHandler = async (
      handlerRuntime: IAgentRuntime,
      target: TargetInfo,
      content: Content
    ): Promise<Memory | undefined> => {
      await service.handleSendMessage(handlerRuntime, target, content);
      return undefined;
    };

    if (typeof runtime.registerMessageConnector === "function") {
      const registration = {
        source: MATRIX_SERVICE_NAME,
        accountId,
        label: "Matrix",
        capabilities: [
          "send_message",
          "send_thread_reply",
          "send_formatted_message",
          "react_to_message",
          "list_rooms",
          "join_room",
        ],
        supportedTargetKinds: ["room", "channel", "thread", "user"],
        contexts: ["social", "connectors"],
        description:
          "Send messages to joined Matrix rooms, aliases, encrypted rooms, and known direct-message rooms.",
        metadata: {
          accountId,
          service: MATRIX_SERVICE_NAME,
        },
        sendHandler,
        resolveTargets: async (query) => {
          const rooms = await service.getJoinedRooms(accountId);
          return rooms
            .map((room) => ({ room, score: scoreMatrixRoom(room, query) }))
            .filter(({ score }) => score > 0)
            .sort((left, right) => {
              const r =
                typeof right.score === "number" && Number.isFinite(right.score) ? right.score : 0;
              const l =
                typeof left.score === "number" && Number.isFinite(left.score) ? left.score : 0;
              return r - l;
            })
            .map(({ room, score }) => matrixRoomToConnectorTarget(room, score, accountId));
        },
        listRecentTargets: async () =>
          (await service.getJoinedRooms(accountId)).map((room) =>
            matrixRoomToConnectorTarget(room, 0.5, accountId)
          ),
        listRooms: async () =>
          (await service.getJoinedRooms(accountId)).map((room) =>
            matrixRoomToConnectorTarget(room, 0.5, accountId)
          ),
        fetchMessages: async (context, params) => {
          const limit = normalizeConnectorLimit(params?.limit);
          const target = params?.target ?? context.target;
          return readMessagesForTarget(service, context.runtime, accountId, target, limit);
        },
        searchMessages: async (context, params) => {
          const limit = normalizeConnectorLimit(params?.limit);
          const target = params?.target ?? context.target;
          const messages = await readMessagesForTarget(
            service,
            context.runtime,
            accountId,
            target,
            undefined
          );
          return filterMemoriesByQuery(messages, params.query, limit);
        },
        reactHandler: async (handlerRuntime, params) => {
          const target = params.target ?? ({ source: MATRIX_SERVICE_NAME } as TargetInfo);
          const room = target.roomId ? await handlerRuntime.getRoom(target.roomId) : null;
          const roomId = String(target.channelId ?? room?.channelId ?? "").trim();
          const mutationParams = params as ConnectorMutationParams;
          const eventId = String(mutationParams.eventId ?? params.messageId ?? "").trim();
          const emoji = String(params.emoji ?? "").trim();
          if (!roomId || !eventId || !emoji) {
            throw new Error("Matrix reactHandler requires room, event id, and emoji");
          }
          const result = await service.sendReaction(roomId, eventId, emoji, accountId);
          if (!result.success) {
            throw new Error(result.error || "Matrix reaction failed");
          }
        },
        joinHandler: async (_handlerRuntime, params) => {
          const membershipParams = params as ConnectorRoomMembershipParams;
          const roomIdOrAlias = String(
            membershipParams.roomIdOrAlias ??
              params.alias ??
              params.invite ??
              params.channelId ??
              params.roomId ??
              ""
          ).trim();
          if (!roomIdOrAlias) {
            throw new Error("Matrix joinHandler requires a room ID or alias");
          }
          await service.joinRoom(roomIdOrAlias, accountId);
        },
        leaveHandler: async (handlerRuntime, params) => {
          const target = params.target ?? ({ source: MATRIX_SERVICE_NAME } as TargetInfo);
          const room = target.roomId ? await handlerRuntime.getRoom(target.roomId) : null;
          const roomId = String(
            params?.roomId ?? params?.channelId ?? target.channelId ?? room?.channelId ?? ""
          );
          if (!roomId) {
            throw new Error("Matrix leaveHandler requires a room ID");
          }
          await service.leaveRoom(roomId, accountId);
        },
        getChatContext: async (target, context) => {
          const room = target.roomId ? await context.runtime.getRoom(target.roomId) : null;
          const channelId = String(target.channelId ?? room?.channelId ?? "").trim();
          const joinedRoom = (await service.getJoinedRooms(accountId)).find(
            (candidate) => candidate.roomId === channelId || candidate.canonicalAlias === channelId
          );
          if (!joinedRoom) {
            return null;
          }

          return {
            target: {
              source: MATRIX_SERVICE_NAME,
              accountId,
              channelId: joinedRoom.roomId,
              roomId: target.roomId,
            },
            label: joinedRoom.name || joinedRoom.canonicalAlias || joinedRoom.roomId,
            summary: joinedRoom.topic,
            metadata: {
              accountId,
              roomId: joinedRoom.roomId,
              canonicalAlias: joinedRoom.canonicalAlias,
              isEncrypted: joinedRoom.isEncrypted,
              isDirect: joinedRoom.isDirect,
              memberCount: joinedRoom.memberCount,
            },
          } satisfies MessageConnectorChatContext;
        },
        getUserContext: async (entityId, context) => {
          if (typeof context.runtime.getEntityById !== "function") {
            return null;
          }
          const entity = await context.runtime.getEntityById(String(entityId) as UUID);
          if (!entity) {
            return null;
          }
          return {
            entityId,
            label: entity.names?.[0],
            aliases: entity.names,
            handles: {},
            metadata: entity.metadata,
          };
        },
      } as ExtendedMessageConnectorRegistration;
      runtime.registerMessageConnector(registration);
      return;
    }

    runtime.registerSendHandler(MATRIX_SERVICE_NAME, sendHandler);
  }

  /**
   * Initialize the Matrix service.
   */
  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.defaultAccountId = normalizeMatrixAccountId(resolveDefaultMatrixAccountId(runtime));

    const accountIds = listMatrixAccountIds(runtime);
    for (const accountId of accountIds) {
      const settings = this.loadSettings(accountId);
      if (settings.enabled === false) {
        continue;
      }

      this.validateSettings(settings);

      const state: MatrixAccountState = {
        accountId: normalizeMatrixAccountId(settings.accountId),
        settings,
        client: sdk.createClient({
          baseUrl: settings.homeserver,
          userId: settings.userId,
          accessToken: settings.accessToken,
          deviceId: settings.deviceId,
          verificationMethods: ["m.sas.v1"],
        }),
        connected: false,
        syncing: false,
        membershipSnapshotToken: crypto.randomUUID(),
        membershipSnapshotCounter: 0,
      };

      this.states.set(state.accountId, state);
      await this.initCrypto(state);
      this.startCryptoSnapshot(state);
      this.setupEventHandlers(state);
      // Membership-authority gate: null when the authority service is absent
      // (legacy ungated mode); a broken bootstrap records a fail-closed gate.
      const gate = await createMatrixMembershipGate({
        runtime,
        matrixAccountId: state.accountId,
        matrixUserId: settings.userId,
        personal: settings.personal,
      }).catch((err) => {
        // error-policy:J2 Bootstrap failure must stay distinguishable from
        // the absent-authority mode: the service IS configured but failed, so
        // report and surface a BROKEN gate below (fail-closed admission)
        // instead of silently degrading to the legacy allow mode.
        runtime.reportError("matrix:membership-bootstrap", err, {
          accountId: state.accountId,
        });
        return "broken" as const;
      });
      if (gate === "broken") {
        const brokenGate = new MatrixMembershipMessageGate({ runtime, authority: null });
        brokenGate.markBroken();
        state.membershipGate = brokenGate;
      } else if (gate) {
        state.membershipAuthority = gate.authority;
        state.membershipGate = new MatrixMembershipMessageGate({
          runtime,
          authority: gate.authority,
        });
      } else {
        state.membershipGate = new MatrixMembershipMessageGate({ runtime, authority: null });
      }
      await this.connect(state);
      MatrixService.registerSendHandlers(runtime, this, state.accountId);

      logger.info(`Matrix service initialized for ${settings.userId} on ${settings.homeserver}`);
    }

    if (this.states.size === 0) {
      const settings = this.loadSettings(this.defaultAccountId);
      this.validateSettings(settings);
    }
  }

  /**
   * Load settings from runtime.
   */
  private loadSettings(accountId?: string): MatrixSettings {
    return resolveMatrixAccountSettings(this.runtime, accountId);
  }

  /**
   * Validate the settings.
   */
  private validateSettings(settings: MatrixSettings): void {
    if (!settings.homeserver) {
      throw new MatrixConfigurationError("MATRIX_HOMESERVER is required", "MATRIX_HOMESERVER");
    }

    if (!settings.userId) {
      throw new MatrixConfigurationError("MATRIX_USER_ID is required", "MATRIX_USER_ID");
    }

    if (!settings.accessToken) {
      throw new MatrixConfigurationError("MATRIX_ACCESS_TOKEN is required", "MATRIX_ACCESS_TOKEN");
    }
  }

  /**
   * Initialize end-to-end encryption for an account when MATRIX_ENCRYPTION is
   * enabled. Most homeservers (including Continuwuity) encrypt rooms by
   * default, so without crypto the client can neither decrypt inbound nor
   * encrypt outbound messages — it would silently drop everything.
   *
   * The rust-crypto store persists in IndexedDB. This runtime (Bun/Node) has no
   * native IndexedDB, so `fake-indexeddb/auto` installs a global one and the
   * whole crypto state — device identity, cross-signing, and inbound megolm
   * sessions — is snapshotted to an encrypted file via saveCryptoStore and
   * restored before init via restoreCryptoStore. A stable device keeps the
   * curve25519/ed25519 identity across restarts, so senders treat it as the
   * same trusted device and keep sharing room keys (including forwarded history
   * keys at join), which is what makes history decryptable.
   *
   * Non-fatal by construction: if anything in the persistence path fails we fall
   * back to an in-memory store so the Matrix connection still comes up. Never
   * throws.
   */
  private async initCrypto(state: MatrixAccountState): Promise<void> {
    if (!state.settings.encryption) {
      return;
    }
    if (typeof state.client.initRustCrypto !== "function") {
      logger.warn(
        "Matrix encryption requested but initRustCrypto is unavailable in this matrix-js-sdk build; messages in encrypted rooms will be unreadable."
      );
      return;
    }
    let cryptoUp = false;
    try {
      await import("fake-indexeddb/auto");
      await this.restoreCryptoStore(state);
      await state.client.initRustCrypto({
        useIndexedDB: true,
        cryptoDatabasePrefix: cryptoDbPrefix(state.accountId),
      });
      logger.info(
        `Matrix E2EE initialized (persistent rust-crypto via IndexedDB) for ${state.settings.userId}`
      );
      cryptoUp = true;
    } catch (err) {
      logger.warn(
        `Matrix persistent crypto init failed (${err instanceof Error ? err.message : String(err)}); falling back to in-memory crypto (device will re-key on restart).`
      );
    }
    if (!cryptoUp) {
      try {
        await state.client.initRustCrypto({ useIndexedDB: false });
        logger.info(`Matrix E2EE initialized (in-memory rust-crypto) for ${state.settings.userId}`);
        cryptoUp = true;
      } catch (err) {
        logger.warn(
          `Matrix encryption failed to initialize (${err instanceof Error ? err.message : String(err)}); encrypted rooms will be unreadable, but the Matrix connection will continue.`
        );
      }
    }
    // Cross-signing makes strict senders share keys; it must run regardless of
    // which crypto backend came up, so do it once here after either path.
    if (cryptoUp) {
      await this.ensureCrossSigning(state);
    }
  }

  /**
   * Self-cross-sign this device so cohort senders running "exclude insecure
   * devices" (MSC4153) share megolm room keys to it — the thing that makes
   * encrypted cohort messages decryptable. The device otherwise carries an empty
   * cross-signing identity and is structurally skipped by those senders.
   *
   * Works with only an access token: MSC3967 (implemented by the homeserver) lets
   * the FIRST device-signing-key upload through with no UIA, so we send auth=null
   * and soft-fail (log, never throw) if the server still demands a password we
   * don't have. Idempotent + non-fatal: the signing keys persist in the
   * snapshotted rust store, so isCrossSigningReady() short-circuits this on every
   * later boot, and any failure leaves the Matrix connection untouched.
   */
  private async ensureCrossSigning(state: MatrixAccountState): Promise<void> {
    const crypto =
      typeof state.client.getCrypto === "function" ? state.client.getCrypto() : undefined;
    if (!crypto) {
      return;
    }
    try {
      // Never be the side that withholds: encrypt to unverified cohort devices
      // and trust owner-cross-signed devices (both SDK defaults, set explicitly
      // so a future default change can't silently gate us).
      crypto.globalBlacklistUnverifiedDevices = false;
      crypto.setTrustCrossSignedDevices(true);

      if (await crypto.isCrossSigningReady()) {
        return;
      }

      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (makeRequest) => {
          // First try the no-auth upload (MSC3967). Homeservers that don't
          // implement it answer 401 with a UIA challenge; satisfy m.login.password
          // with the challenge session when MATRIX_PASSWORD is configured,
          // otherwise soft-fail so the connection is unaffected.
          try {
            return await makeRequest(null);
          } catch (err) {
            const data = (err as { data?: { session?: string; flows?: unknown } })?.data;
            if (!data?.flows) {
              throw err;
            }
            if (!state.settings.password || !data.session) {
              logger.warn(
                `Matrix cross-signing upload for ${state.settings.userId} needs password UIA but ${state.settings.password ? "the server returned no challenge session" : "no MATRIX_PASSWORD is set"}; device ${state.settings.deviceId ?? "?"} stays uncross-signed, so exclude-insecure-devices senders will withhold keys.`
              );
              throw err;
            }
            return await makeRequest({
              type: "m.login.password",
              identifier: { type: "m.id.user", user: state.settings.userId },
              password: state.settings.password,
              session: data.session,
            });
          }
        },
      });
      logger.info(
        `Matrix cross-signing bootstrapped for ${state.settings.userId}; senders should now share megolm keys to this device.`
      );
      // Key-backup enable is a distinct best-effort step AFTER bootstrap already
      // succeeded; a throw here must not reach the outer catch and mislabel the
      // whole bootstrap as "skipped", but its failure must still be visible.
      await crypto.checkKeyBackupAndEnable().catch((backupErr) => {
        logger.warn(
          `Matrix cross-signing bootstrapped for ${state.settings.userId} but key-backup enable failed (${backupErr instanceof Error ? backupErr.message : String(backupErr)}); megolm history backup is unavailable until this device re-runs backup setup.`
        );
      });
    } catch (err) {
      logger.warn(
        `Matrix cross-signing bootstrap skipped (${err instanceof Error ? err.message : String(err)}); cohort senders in exclude-insecure-devices mode may withhold keys until this device is verified once from an operator's Matrix client.`
      );
    }
  }

  /**
   * Restore the persisted rust-crypto IndexedDB store from the encrypted at-rest
   * file into the live (fake-indexeddb) global, replacing whatever is there.
   * Must run BEFORE initRustCrypto so the store is populated when the crypto
   * stack opens it.
   *
   * Strictly additive and non-fatal: any failure (missing file, corrupt data,
   * token rotation making decrypt impossible) only warns and returns, leaving an
   * empty store so the device starts fresh.
   */
  private async restoreCryptoStore(state: MatrixAccountState): Promise<void> {
    try {
      const filePath = cryptoStoreFilePath(state.accountId);
      if (!existsSync(filePath)) {
        return;
      }
      const ciphertext = await readFile(filePath, "utf8");
      let snapshot: CryptoStoreSnapshot;
      try {
        snapshot = v8Deserialize(decryptCryptoStore(state.settings.accessToken, ciphertext));
      } catch {
        // Corrupt file or rotated token — start fresh rather than blocking init.
        logger.warn(
          `Matrix crypto-store restore skipped for ${state.accountId}: stored state could not be decrypted (token may have rotated).`
        );
        return;
      }
      await restoreDb(cryptoDbName(state.accountId), snapshot);
      logger.info(`Matrix restored persisted crypto store for ${state.accountId}`);
    } catch (err) {
      logger.warn(
        `Matrix crypto-store restore failed for ${state.accountId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Snapshot the live rust-crypto IndexedDB store and persist it, encrypted at
   * rest, so the device identity and room keys survive a process restart. The
   * snapshot contains PRIVATE device keys, so it is written 0600 and encrypted
   * under a token-derived key. Atomic (tmp + rename) so a crash mid-write can
   * never truncate the live file. Strictly additive and non-fatal: failures only
   * warn and never affect the Matrix connection.
   */
  private async saveCryptoStore(state: MatrixAccountState): Promise<void> {
    // No global IndexedDB means initCrypto fell back to the in-memory store
    // (nothing to snapshot). Skip silently rather than warn every tick.
    if (typeof indexedDB === "undefined") {
      return;
    }
    try {
      const snapshot = await snapshotDb(cryptoDbName(state.accountId));
      const ciphertext = encryptCryptoStore(state.settings.accessToken, v8Serialize(snapshot));
      const filePath = cryptoStoreFilePath(state.accountId);
      const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
      await mkdir(join(resolveStateDir(), "matrix-keys"), { recursive: true, mode: 0o700 });
      await writeFile(tmpPath, ciphertext, { mode: 0o600 });
      // mode on writeFile only applies on create; chmod enforces 0o600 even when
      // an existing temp name somehow had looser permissions.
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, filePath);
    } catch (err) {
      logger.warn(
        `Matrix crypto-store save failed for ${state.accountId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Start the periodic crypto-store snapshot for an account. The interval is
   * unref'd so it never keeps the process alive on its own, and its handle is
   * stored on the account state so stop() can clear it.
   */
  private startCryptoSnapshot(state: MatrixAccountState): void {
    if (!state.settings.encryption) {
      return;
    }
    const timer = setInterval(() => {
      void this.saveCryptoStore(state);
    }, CRYPTO_SNAPSHOT_INTERVAL_MS);
    timer.unref?.();
    state.cryptoSnapshotTimer = timer;
  }

  /**
   * Set up event handlers for the Matrix client.
   */
  private setupEventHandlers(state: MatrixAccountState): void {
    // Sync events
    state.client.on(sdk.ClientEvent.Sync, (syncState, _prevState, syncData) => {
      if (syncState === "PREPARED") {
        state.syncing = true;
        logger.info("Matrix sync complete");
        this.runtime.emitEvent(MatrixEventTypes.SYNC_COMPLETE, {
          runtime: this.runtime,
          accountId: state.accountId,
        } as EventPayload);
        // First PREPARED after start (oldSyncToken null/undefined): publish
        // complete membership snapshots for joined rooms. Later PREPAREDs
        // (reconnects) re-publish from the SDK's accumulated state, which is
        // complete for rooms already synced. A CACHED PREPARED (syncData
        // fromCache, e.g. after a restart resuming from the store) is NOT
        // fresh server state — publishing from it would restore possibly
        // stale rosters as current evidence, so skip publication and let the
        // recovery paths (scope-health probing) establish fresh state.
        const firstPrepared = syncData?.oldSyncToken == null && syncData?.fromCache !== true;
        // error-policy:J7 snapshot publication is diagnostic and must not
        // kill the sync loop; the failure is logged for operator escalation.
        void this.publishMembershipSnapshots(state, firstPrepared).catch((err) =>
          logger.error(
            `Matrix membership snapshot publication failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      } else if (syncState === "SYNCING" && _prevState === "RECONNECTING") {
        // The SDK recovers RECONNECTING -> SYNCING (PREPARED does NOT recur
        // after initial sync), so the republish that clears STALE scopes must
        // run here. Complete-state rules inside publishMembershipSnapshots
        // (lazy-load resolution + incompleteness checks) still gate what is
        // actually published.
        state.syncing = true;
        void this.publishMembershipSnapshots(state, false).catch((err) =>
          logger.error(
            `Matrix membership snapshot recovery failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      } else if (syncState === "ERROR" || syncState === "RECONNECTING") {
        // Connection trouble: room evidence may be stale. Degrade every
        // currently-tracked room scope to STALE (fail-closed admission, no
        // tombstone) so a fresh PREPARED can re-publish complete state and
        // restore admission. Unavailable+tombstone is reserved for bot
        // self-leave/ban, where only an explicit rejoin may clear it — a
        // transient reconnect must never permanently kill a scope.
        if (state.membershipAuthority) {
          // error-policy:J7 degrade is diagnostic; failed degrades surface
          // via the authority's own error path and the next sync retries.
          void this.degradeAllMembershipScopes(state, `sync_${syncState.toLowerCase()}`).catch(
            (err) =>
              logger.error(
                `Matrix membership scope degrade failed: ${err instanceof Error ? err.message : String(err)}`
              )
          );
        }
      }
    });

    // Limited-sync gaps: the SDK resets the live timeline when a sync response
    // is limited, which means state events (including m.room.member) may be
    // missing from the accumulated room state. The roster can no longer be
    // trusted as complete for this room until the next full sync — record
    // incompleteness, never publish the partial roster as complete.
    state.client.on(sdk.RoomEvent.TimelineReset, (room) => {
      if (!room || !state.membershipAuthority) {
        return;
      }
      // A limited-sync gap invalidates roster completeness immediately: the
      // persisted scope is degraded to STALE (fail-closed admission) rather
      // than left authorizing on an untrustworthy roster. The room is also
      // marked locally incomplete so a later publication pass re-establishes
      // a complete baseline instead of streaming deltas over the gap.
      state.membershipAuthority.markRoomIncomplete(room.roomId, "limited_sync_timeline_reset");
      // error-policy:J7 stale-degrade is diagnostic; a failed degrade leaves
      // the local incompleteness flag set, so publication stays blocked.
      void state.membershipAuthority
        .markScopeStale({ roomId: room.roomId, reason: "limited_sync_timeline_reset" })
        .then(() =>
          // A timeline reset marks the room incomplete but nothing else
          // schedules the recovery publication: PREPARED does not recur, and
          // without this pass the room stays incomplete indefinitely with
          // stale roster facts. The recovery publication fetches a FRESH
          // server roster (never the just-distrusted SDK model) and either
          // re-establishes the complete baseline or leaves the room
          // fail-closed incomplete on fetch failure — where the bounded
          // backoff below retries the same fresh-fetch path (never a cached
          // roster) until it succeeds or the room leaves the joined set.
          this.recoverMembershipAfterTimelineReset(state, room.roomId, 1)
        )
        .catch((err) =>
          logger.error(
            `Matrix membership recovery after timeline reset failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
    });

    // Room timeline events (messages)
    state.client.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) return;
      if (event.getSender() === state.settings.userId) return;

      // In E2EE rooms the event surfaces as m.room.encrypted until the crypto
      // stack decrypts it. If decryption is still pending, wait for the
      // Decrypted event before dispatching; otherwise dispatch immediately.
      if (event.isEncrypted() && event.getType() === "m.room.encrypted") {
        event.once(sdk.MatrixEventEvent.Decrypted, () => {
          if (event.getType() === "m.room.message") {
            // error-policy:J7 admission/dispatch failures are reported and
            // swallowed here: the SDK event callback must not become an
            // unhandled rejection source.
            void this.handleRoomMessage(state, event, room).catch((err) =>
              logger.error(
                `Matrix room message handling failed: ${err instanceof Error ? err.message : String(err)}`
              )
            );
          } else if (event.isDecryptionFailure()) {
            logger.warn(
              `Matrix could not decrypt event ${event.getId()} in ${event.getRoomId()} — the sender has not shared the megolm key with this device yet.`
            );
          }
        });
        return;
      }

      if (event.getType() !== "m.room.message") return;
      // error-policy:J7 see the Decrypted branch above — never leak an
      // unhandled rejection into the SDK event handler.
      void this.handleRoomMessage(state, event, room).catch((err) =>
        logger.error(
          `Matrix room message handling failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    });

    // Room membership events
    state.client.on(sdk.RoomMemberEvent.Membership, (event, member, oldMembership) => {
      // error-policy:J7 transition handling is diagnostic (the authority's
      // evidence path already reports its own failures); never kill sync.
      // Bootstrap (ensure*) rejections propagate here and are reported so
      // RECENT_ERRORS surfaces dropped membership evidence, not just the log.
      void this.handleMembershipTransition(state, event, member, oldMembership).catch((err) => {
        logger.error(
          `Matrix membership transition handling failed: ${err instanceof Error ? err.message : String(err)}`
        );
        this.runtime.reportError("matrix:membership-transition", err as Error, {
          roomId: event.getRoomId?.() ?? undefined,
          matrixUserId: member?.userId,
        });
      });
    });

    this.setupVerificationAutoAccept(state);
  }

  /**
   * Bounded-backoff recovery for a room flagged incomplete by a timeline
   * reset. Each attempt runs the full publication pass, which fetches a
   * FRESH server roster (never the cached SDK model); on failure the room
   * stays fail-closed incomplete and the next attempt retries. Retries stop
   * early once the room is no longer flagged incomplete (a concurrent pass
   * or a later PREPARED recovered it) or the bot left the room. Attempt
   * count, not wall-clock, bounds the schedule so timers stay deterministic
   * under test.
   */
  private async recoverMembershipAfterTimelineReset(
    state: MatrixAccountState,
    roomId: string,
    attempt: number
  ): Promise<void> {
    const authority = state.membershipAuthority;
    if (!authority) {
      return;
    }
    try {
      await this.publishMembershipSnapshots(state, false);
      // Success: any room still incomplete after a successful pass failed
      // its own fresh fetch; those rooms schedule their own retry below via
      // the per-room loop only if this pass threw — a clean return means
      // every room either published or reported incomplete, and the rooms
      // that reported incomplete are re-covered by the retry below.
      const stillIncomplete = authority.isRoomIncomplete(roomId);
      if (!stillIncomplete) {
        return;
      }
      throw new Error(`room ${roomId} still incomplete after recovery publication`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // error-policy:J7 diagnostics must not kill the sync loop; the room
      // remains fail-closed incomplete (admission denied) until a retry
      // publishes a complete fresh roster.
      logger.warn(`Matrix membership recovery attempt ${attempt} for ${roomId} failed: ${message}`);
      this.runtime.reportError(
        "matrix:membership-recovery",
        err instanceof Error ? err : new Error(message),
        { roomId, attempt }
      );
    }
    if (attempt >= 5) {
      logger.error(
        `Matrix membership recovery for ${roomId} exhausted after ${attempt} attempts; room stays fail-closed until the next sync/join trigger`
      );
      return;
    }
    const delayMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      void this.recoverMembershipAfterTimelineReset(state, roomId, attempt + 1);
    }, delayMs);
    // Never keep the process alive for a retry timer.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  /**
   * Publish complete membership snapshots for every joined room of an
   * account. Only called for known-complete state: the first PREPARED sync
   * (after lazy-loaded member lists resolve) or an explicit join. Rooms whose
   * member list is marked incomplete are reported incomplete instead — never
   * as empty or complete.
   */
  private async publishMembershipSnapshots(
    state: MatrixAccountState,
    firstSync: boolean
  ): Promise<void> {
    const authority = state.membershipAuthority;
    if (!authority) {
      return;
    }
    const rooms = state.client.getRooms().filter((room) => room.getMyMembership() === "join");
    for (const room of rooms) {
      // Lazy loading: until the out-of-band member list resolves, the SDK's
      // roster is partial AND the joined-member count is unreliable (a large
      // room can transiently look like a 1-member "direct" room). Load members
      // FIRST, then classify the room — never publish or skip on a partial
      // roster.
      let membersReady = true;
      if (typeof room.loadMembersIfNeeded === "function") {
        try {
          await room.loadMembersIfNeeded();
        } catch {
          membersReady = false;
        }
      }
      if (!membersReady) {
        await authority.reportIncomplete({
          roomId: room.roomId,
          reason: "member_load_failed",
          observedAt: new Date().toISOString(),
        });
        continue;
      }
      // Recovery check comes BEFORE the direct-room skip: a lazily-loaded
      // group can transiently report <= 2 members, and skipping first would
      // leave a partial roster unrecovered indefinitely. Only a room the
      // authority already knows (in-memory flag OR persisted non-current
      // health) needs recovery; a never-registered true DM has no scope row
      // and must not be published. A non-first sync (reconnect republish,
      // post-join sweep) NEVER publishes from the SDK cache directly — only
      // a fresh server roster may become evidence on those passes.
      const incomplete = authority.isRoomIncomplete(room.roomId);
      // error-policy:J7 a failed health probe is diagnostic and must fail
      // CLOSED for publication: an unknown persisted-health state cannot be
      // treated as "recovery unnecessary" (that would publish the possibly
      // stale SDK roster). Treat a probe failure as needing fresh recovery.
      let persistedNonCurrent = false;
      let healthProbeFailed = false;
      {
        const health = await authority
          .scopeHealth({ roomId: room.roomId })
          .catch((err: unknown) => {
            logger.error(
              `Matrix membership scope health probe failed for ${room.roomId}: ${err instanceof Error ? err.message : String(err)}`
            );
            return "probe-failed" as const;
          });
        if (health === "probe-failed") {
          healthProbeFailed = true;
        } else {
          // A scope the SQL authority holds as stale/unavailable must
          // recover through a fresh-roster republication even when this
          // process has no in-memory incompleteness flag (e.g. restart).
          // Probed even when the in-memory flag is set: a room with BOTH a
          // transient flag and a persisted scope must still publish its
          // (shrunken) fresh roster to restore the persisted scope, not just
          // clear the flag.
          persistedNonCurrent = health !== null && health.health !== "current";
        }
      }
      if (incomplete || persistedNonCurrent || healthProbeFailed || !firstSync) {
        // Recovery requires a GENUINELY FRESH server-side roster:
        // loadMembersIfNeeded is one-shot and cached by the SDK, so a cached
        // resolve does NOT disprove a later timeline-reset gap. Perform a
        // fresh client.members fetch; a successful full fetch disproves every
        // transient incompleteness reason (timeline reset, member load
        // failure, empty roster) at once. The FETCHED roster (not the SDK's
        // cached Room model, which client.members does not update) becomes
        // the published baseline. On failure the room stays
        // incomplete — fail closed.
        const freshRoster = await this.fetchFreshServerRoster(state, room.roomId);
        if (freshRoster === null) {
          await authority.reportIncomplete({
            roomId: room.roomId,
            reason: "member_list_incomplete",
            observedAt: new Date().toISOString(),
          });
          continue;
        }
        if (freshRoster.length <= 2 && !persistedNonCurrent) {
          // The fresh server roster shows this is (now) a direct-sized room
          // with no persisted authority scope: publish nothing, but clear the
          // transient flag so the room stops entering recovery every pass.
          // (A room WITH a persisted non-current scope still publishes — the
          // shrunken roster is complete evidence and restores health.)
          // A room with a CURRENT persisted scope is also governed evidence:
          // the shrunken roster is the complete truth (a governed group that
          // lost members), and skipping here would strand revoked members as
          // active forever. Skip only on a DEFINITIVE no-scope probe; a
          // failed probe stays fail-closed and publishes.
          let noScope = false;
          {
            const health = await authority
              .scopeHealth({ roomId: room.roomId })
              .then((h) => h === null)
              .catch(() => false);
            // The transient incompleteness flag is deliberately NOT consulted
            // here: reaching this point means the fresh server roster fetch
            // SUCCEEDED in full, which disproves every transient incompleteness
            // reason. Requiring !isRoomIncomplete as well would make this skip
            // unreachable exactly when a transient flag is set (the recovery
            // case), publishing a DM-sized room as a governed scope. Only the
            // persisted probe decides: definitive no-scope => true direct room.
            noScope = health;
          }
          if (noScope) {
            authority.clearTransientRoomIncompleteness(room.roomId);
            continue;
          }
        }
        authority.clearTransientRoomIncompleteness(room.roomId);
        // Fall through: publish the complete baseline from the fresh roster.
        await this.publishSingleRoomMembershipSnapshot(state, room, freshRoster);
        continue;
      }
      // Direct rooms are not membership-governed (assessed after recovery,
      // so a lazily-loaded group is never misclassified nor left stuck).
      if (room.getJoinedMemberCount() <= 2) {
        continue;
      }
      await this.publishSingleRoomMembershipSnapshot(state, room);
    }
  }

  /**
   * Fetches a GENUINELY FRESH server-side joined roster for a room via the
   * homeserver API (`client.members` — a plain HTTP request that does NOT
   * touch the SDK's cached Room model, unlike the one-shot
   * `room.loadMembersIfNeeded`). Returns the joined user IDs, or null on
   * failure (fail closed — the caller keeps the room incomplete).
   */
  private async fetchFreshServerRoster(
    state: MatrixAccountState,
    roomId: string
  ): Promise<string[] | null> {
    try {
      const result = await state.client.members(roomId, "join");
      if (result === null || typeof result !== "object") {
        return null;
      }
      // The homeserver /members endpoint (and matrix-js-sdk's
      // MatrixClient.members, which returns the raw response — see
      // Room.loadMembersFromServer consuming response.chunk) answers with
      // { chunk: IStateEventWithRoomId[] }, one state event per member with
      // the subject in state_key. Parse the chunk, not a map keyed by userId.
      const chunk = (result as { chunk?: unknown }).chunk;
      if (!Array.isArray(chunk)) {
        return null;
      }
      const joined: string[] = [];
      for (const event of chunk) {
        if (event === null || typeof event !== "object") {
          // A structurally invalid entry means the roster cannot be known
          // complete — skipping it could publish a partial roster as a
          // complete baseline. Fail closed.
          return null;
        }
        const { state_key: stateKey, content } = event as {
          state_key?: unknown;
          content?: { membership?: unknown } | null;
        };
        if (
          typeof stateKey !== "string" ||
          content === null ||
          typeof content !== "object" ||
          typeof content.membership !== "string"
        ) {
          return null;
        }
        // Only an explicit "join" counts as presence on the fresh server roster;
        // well-formed leave/invite events are simply not presence.
        if (content.membership === "join") {
          joined.push(stateKey);
        }
      }
      return joined;
    } catch (err) {
      logger.error(
        `Matrix fresh member fetch failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
      // error-policy:J6 fetch failure leaves the room incomplete; recovery
      // is retried on the next publication pass.
    }
  }

  /**
   * Publishes ONE room's complete membership snapshot (the ordered-delta
   * baseline): bootstraps entity/room/world rows for members the runtime has
   * never seen, then submits the roster under a unique observation key.
   * Shared by the sync-driven publication pass and the grown-room baseline
   * path in the membership-transition handler. Returns true when published.
   */
  private async publishSingleRoomMembershipSnapshot(
    state: MatrixAccountState,
    room: sdk.Room,
    freshJoinedUserIds?: string[]
  ): Promise<boolean> {
    const authority = state.membershipAuthority;
    if (!authority) {
      return false;
    }
    // A caller-supplied fresh server roster (from client.members) overrides
    // the SDK Room model: the plain HTTP fetch does not update the Room's
    // cached members, so reading room.getJoinedMembers() after a fresh fetch
    // would republish the stale/partial roster that triggered recovery.
    let memberEntries: { userId: string; powerLevel: number }[];
    if (freshJoinedUserIds !== undefined) {
      if (freshJoinedUserIds.length === 0) {
        await authority.reportIncomplete({
          roomId: room.roomId,
          reason: "empty_roster",
          observedAt: new Date().toISOString(),
        });
        return false;
      }
      memberEntries = freshJoinedUserIds.map((userId) => ({
        userId,
        powerLevel: room.getMember(userId)?.powerLevel ?? 0,
      }));
    } else {
      const joinedMembers = room.getJoinedMembers();
      if (joinedMembers.length === 0) {
        await authority.reportIncomplete({
          roomId: room.roomId,
          reason: "empty_roster",
          observedAt: new Date().toISOString(),
        });
        return false;
      }
      memberEntries = joinedMembers.map((m) => ({
        userId: m.userId,
        powerLevel: m.powerLevel,
      }));
    }
    // Snapshot members must reference existing entity/room/world rows; the
    // gate path creates them lazily, and synced rooms may carry members the
    // runtime has never seen — bootstrap rows before publishing. ensure* (not
    // create*): the PREPARED publication pass and the membership-transition
    // handler run concurrently on the same room in a real sync (both observe
    // the join), and a plain createWorld would throw WORLD_ALREADY_EXISTS
    // from the loser and kill evidence publication.
    const worldId = matrixScopedUuid(this.runtime, `${state.accountId}:${room.roomId}`);
    await this.runtime.ensureWorldExists({
      id: worldId,
      name: room.name || room.roomId,
      agentId: this.runtime.agentId,
      metadata: { source: MATRIX_SERVICE_NAME, accountId: state.accountId, roomId: room.roomId },
    });
    await this.runtime.ensureRoomExists({
      id: worldId,
      name: room.name || room.roomId,
      source: MATRIX_SERVICE_NAME,
      type: ChannelType.GROUP,
      channelId: room.roomId,
      worldId,
    });
    const memberRecords = [];
    for (const roomMember of memberEntries) {
      const entityId = matrixScopedUuid(this.runtime, `${state.accountId}:${roomMember.userId}`);
      await this.runtime.createEntity({
        id: entityId,
        agentId: this.runtime.agentId,
        names: [`matrix-${getMatrixLocalpart(roomMember.userId)}`],
        metadata: { source: MATRIX_SERVICE_NAME, matrixUserId: roomMember.userId },
      });
      memberRecords.push({
        canonicalPrincipalId: entityId,
        roles: matrixMemberRoles(roomMember.powerLevel),
        permissionSnapshot: { membership: "join" },
        runtime: { worldId, roomId: worldId, entityId },
      });
    }
    // Idempotency keys must identify ONE observation, not a class of sync
    // events: a per-state instance token + monotonic counter keeps restarts,
    // resyncs, and in-process state reconstruction distinct (a reused key is
    // an idempotency CONFLICT, and publishSnapshot would silently skip a
    // changed roster).
    state.membershipSnapshotCounter += 1;
    const published = await authority.publishSnapshot({
      roomId: room.roomId,
      observedAt: new Date().toISOString(),
      members: memberRecords,
      idempotencyKey: `mx:${state.accountId}:${room.roomId}:snapshot:${state.membershipSnapshotToken}:${state.membershipSnapshotCounter}`,
    });
    if (published) {
      logger.debug(
        `Matrix membership snapshot published for ${room.roomId}: ${memberRecords.length} members`
      );
    }
    return published;
  }

  /**
   * Degrade every tracked room scope for an account to STALE (transient sync
   * trouble): admission fails closed until a fresh PREPARED re-publishes, and
   * NO tombstone is installed so the re-publish is accepted.
   */
  private async degradeAllMembershipScopes(
    state: MatrixAccountState,
    reason: string
  ): Promise<void> {
    const authority = state.membershipAuthority;
    if (!authority) {
      return;
    }
    // Degrade EVERY joined room scope: during a reconnect gap the SDK member
    // count is unreliable (lazy loading can make a group look like a <=2
    // direct room), so the count must not gate degradation. Rooms that were
    // never snapshotted (true DMs, unpublished rooms) are skipped inside
    // degradeScope — no scope row, nothing authorizing.
    //
    // Per-room containment is load-bearing: one failed durable write must not
    // abort the loop, or every later room keeps authorizing stale evidence
    // for the whole reconnect gap. Attempt ALL rooms, retain the first
    // failure, and rethrow it after the loop so the reconnect handler's
    // catch logs it and the next sync retries — a swallow would disguise a
    // scope that never degraded. A boolean flag marks failure: the rejection
    // value itself may be null.
    // error-policy:J7 a failed degrade write must not kill the degrade loop;
    // the aggregate rejection surfaces after every room is attempted.
    let firstFailure: unknown = null;
    let sawFailure = false;
    for (const room of state.client.getRooms().filter((r) => r.getMyMembership() === "join")) {
      try {
        await authority.markScopeStale({ roomId: room.roomId, reason });
      } catch (error) {
        if (!sawFailure) {
          firstFailure = error;
          sawFailure = true;
        }
        logger.error(
          `Matrix membership scope stale-degrade failed for ${room.roomId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (sawFailure) {
      throw firstFailure;
    }
  }

  /**
   * Consume one m.room.member transition: record authority evidence for the
   * subject; self-transitions (the bot's own membership) additionally manage
   * the scope lifecycle (leave/ban terminates the publisher with a tombstone;
   * join clears it and publishes a fresh complete snapshot).
   */
  private async handleMembershipTransition(
    state: MatrixAccountState,
    event: sdk.MatrixEvent,
    member: sdk.RoomMember,
    oldMembership: string | undefined
  ): Promise<void> {
    const authority = state.membershipAuthority;
    const roomId = event.getRoomId();
    if (!authority || !roomId) {
      // No authority configured: preserve the legacy self-invite auto-join
      // behavior even in ungated deployments.
      if (
        roomId &&
        member.userId === state.settings.userId &&
        member.membership === "invite" &&
        state.settings.autoJoin
      ) {
        logger.info(`Auto-joining room ${roomId}`);
        state.client.joinRoom(roomId).catch((err) => {
          logger.error(`Failed to auto-join room: ${err.message}`);
        });
      }
      return;
    }
    const room = state.client.getRoom(roomId);
    if (room && member.membership !== "join" && member.userId !== state.settings.userId) {
      // Direct rooms are not membership-governed; a PEER's leave/ban must
      // create NO authority evidence. Room SIZE is not the governor signal
      // though — a governed room that shrank can be any size. The definitive
      // signal is the authority's own scope row: a scope that exists (in any
      // health) means this room IS governed and the leaving peer's revocation
      // must record. Only a definitive no-scope probe lets the DM skip run;
      // a failed probe reports and drops (recording against the same failing
      // store would mint a scope row for a possible DM as a side effect of a
      // doomed write). Returning via the size heuristic alone would strand
      // revoked members of shrinking groups as active forever.
      let governed = true;
      const health = await authority.scopeHealth({ roomId }).catch((err: unknown) => {
        logger.error(
          `Matrix membership scope health probe failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`
        );
        return "probe-failed" as const;
      });
      if (health === "probe-failed") {
        // The authority store itself just failed — recordTransition would
        // hit the same store and its ensureRegistered would MINT a scope
        // row for a possible DM as a side effect of a doomed write. Report
        // and drop instead: the next roster publication pass for this room
        // re-derives the full baseline from fresh server state.
        this.runtime.reportError(
          "matrix:membership-transition",
          new Error("scope health probe failed"),
          {
            roomId,
            matrixUserId: member.userId,
            transition: "leave",
          }
        );
        return;
      }
      if (health === null && room.getJoinedMemberCount() + 1 <= 2) {
        // Definitive no-scope AND direct-sized (even counting the subject):
        // a true DM peer leave.
        governed = false;
      }
      if (!governed) {
        return;
      }
    }
    // Bot self-transitions own the scope lifecycle.
    if (member.userId === state.settings.userId) {
      if (member.membership === "leave" || member.membership === "ban") {
        const reason =
          member.membership === "ban"
            ? "bot_banned"
            : oldMembership === "invite"
              ? "invite_declined"
              : "bot_left";
        await authority.markScopeUnavailable({ roomId, reason });
        logger.info(`Matrix membership scope terminated for ${roomId} (${reason})`);
        return;
      }
      if (member.membership === "join" && oldMembership !== "join") {
        authority.clearScopeRemoval({ roomId });
        // error-policy:J7 post-join republish is diagnostic; the join itself
        // already succeeded.
        await this.publishMembershipSnapshots(state, false).catch((err) =>
          logger.error(
            `Matrix membership snapshot after join failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
        return;
      }
      if (member.membership === "invite" && state.settings.autoJoin) {
        logger.info(`Auto-joining room ${roomId}`);
        state.client.joinRoom(roomId).catch((err) => {
          logger.error(`Failed to auto-join room: ${err.message}`);
        });
      }
      return;
    }
    // Other members' transitions become ordered-delta evidence.
    if (room && room.getJoinedMemberCount() <= 2 && member.membership === "join") {
      // Direct rooms are not membership-governed.
      return;
    }
    // A previously ungoverned (direct) room that grew past two members has NO
    // snapshot baseline, and the SQL authority rejects ordered deltas without
    // one — the delta below would be dropped, leaving the new group
    // permanently denied. Bootstrap ONLY a scope that does not exist at all;
    // a scope with stale or degraded health must recover through the
    // verified-fresh-roster path in the publication pass, never by promoting
    // possibly-incomplete state to current.
    if (room && room.getJoinedMemberCount() > 2 && member.membership === "join") {
      const health = await authority.scopeHealth({ roomId }).catch((err: unknown) => {
        logger.error(
          `Matrix membership scope health probe failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      });
      if (health === null && !authority.isRoomIncomplete(roomId)) {
        const published = await this.publishSingleRoomMembershipSnapshot(state, room).catch(
          (err) => {
            logger.error(
              `Matrix membership baseline for grown room failed: ${err instanceof Error ? err.message : String(err)}`
            );
            return false;
          }
        );
        if (!published) {
          // No baseline exists: the delta below would be rejected anyway
          // (SNAPSHOT_REQUIRED). Return so the failure is visible rather than
          // falling through as if a baseline existed.
          return;
        }
      }
    }
    const matrixUserId = member.userId || event.getSender() || "unknown";
    const transition = classifyMatrixTransition(member.membership, oldMembership);
    if (transition === null) {
      // Unknown/missing membership must not become leave authority (an
      // explicit decision is required to revoke a principal).
      // error-policy:J7 diagnostic report only; the loop continues.
      this.runtime.reportError(
        "matrix:membership-transition",
        new Error(`Unsupported Matrix membership value: ${String(member.membership)}`),
        { roomId, subject: matrixUserId, membership: member.membership ?? null }
      );
      return;
    }
    const entityId = matrixScopedUuid(this.runtime, `${state.accountId}:${matrixUserId}`);
    const worldId = matrixScopedUuid(this.runtime, `${state.accountId}:${roomId}`);
    // Evidence requires entity/room/world rows: bootstrap them for members the
    // runtime has never seen (idempotent creates).
    await this.runtime.createEntity({
      id: entityId,
      agentId: this.runtime.agentId,
      names: [`matrix-${getMatrixLocalpart(matrixUserId)}`],
      metadata: { source: MATRIX_SERVICE_NAME, matrixUserId },
    });
    // ensure* (not create*): the PREPARED publication pass and the
    // membership-transition handler run concurrently on the same room in a
    // real sync (both observe the join); ensure* is idempotent by contract
    // (read-compare-upsert with CAS retry), so whichever wins, this call
    // completes without WORLD_ALREADY_EXISTS dropping the transition.
    // Bootstrap failures propagate to the caller's J7 report handler.
    await this.runtime.ensureWorldExists({
      id: worldId,
      name: roomId,
      agentId: this.runtime.agentId,
      metadata: { source: MATRIX_SERVICE_NAME, accountId: state.accountId, roomId },
    });
    await this.runtime.ensureRoomExists({
      id: worldId,
      name: roomId,
      source: MATRIX_SERVICE_NAME,
      type: ChannelType.GROUP,
      channelId: roomId,
      worldId,
    });
    await authority.recordTransition({
      roomId,
      canonicalPrincipalId: entityId,
      transition,
      roles: matrixMemberRoles(member.powerLevel),
      permissionSnapshot: { membership: member.membership ?? "unknown" },
      runtime: { worldId, roomId: worldId, entityId },
      eventId: event.getId() || `${roomId}:${event.getTs()}`,
      matrixUserId,
      observedAt: matrixObservedAt(event.getTs()),
    });
  }

  /**
   * Let allow-listed users verify this device via SAS (emoji) verification from
   * their own Matrix client. On homeservers where the bot can't self-cross-sign
   * (no MSC3967 + no password), this is how senders come to trust the device and
   * start sharing megolm keys to it — and the verifying user's client also
   * gossips the room keys it already holds, backfilling history.
   *
   * Fail-closed: with no MATRIX_VERIFY_ALLOWLIST nothing is accepted, so this is
   * inert unless explicitly configured. The verified trust persists in the
   * snapshotted crypto store, so it is a one-time action per user.
   */
  private setupVerificationAutoAccept(state: MatrixAccountState): void {
    const crypto = state.client.getCrypto();
    if (!crypto || state.settings.verifyAllowlist.length === 0) {
      return;
    }
    state.client.on(CryptoEvent.VerificationRequestReceived, (request) => {
      void this.handleVerificationRequest(state, request);
    });
  }

  private async handleVerificationRequest(
    state: MatrixAccountState,
    request: VerificationRequest
  ): Promise<void> {
    const other = request.otherUserId;
    if (!state.settings.verifyAllowlist.includes(other)) {
      logger.warn(`Matrix rejecting verification request from non-allowlisted ${other}`);
      // error-policy:J6 best-effort teardown of a rejected verification request; the
      // rejection is already logged and the request is being abandoned.
      await request.cancel().catch(() => {});
      return;
    }
    logger.info(`Matrix auto-accepting SAS verification from ${other}`);
    try {
      if (canAcceptVerificationRequest(request)) {
        await request.accept();
      }
      const verifier = request.verifier ?? (await this.awaitVerifier(request));
      if (!verifier) {
        // error-policy:J6 best-effort teardown when no verifier materialized; the
        // request is being abandoned either way.
        await request.cancel().catch(() => {});
        return;
      }
      verifier.on(VerifierEvent.ShowSas, (callbacks: ShowSasCallbacks) => {
        logger.info(`Matrix auto-confirming SAS with ${other}`);
        // error-policy:J5 confirm() rejection is observed by the awaited
        // verifier.verify() below, whose failure is logged in the outer catch;
        // this no-op guard only suppresses the unhandled-rejection warning.
        void callbacks.confirm().catch(() => {});
      });
      await verifier.verify();
      logger.info(
        `Matrix device verification with ${other} complete; megolm keys should now flow.`
      );
    } catch (err) {
      logger.warn(
        `Matrix verification with ${other} failed or was cancelled (${err instanceof Error ? err.message : String(err)}).`
      );
    }
  }

  /**
   * Wait for the verifier to materialize. The bot is a pure responder: the
   * initiator (e.g. Element) sends the m.key.verification.start, which creates
   * the verifier on our side. We only start SAS ourselves as a fallback, after a
   * short grace period, for the rare initiator that waits for the responder to
   * start — starting eagerly would race the initiator's start ("glare") and the
   * two sides would compute the SAS over different start events, failing the
   * match. Resolves undefined if the request is cancelled or completes first.
   */
  private awaitVerifier(request: VerificationRequest): Promise<Verifier | undefined> {
    return new Promise((resolve) => {
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: Verifier | undefined) => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        request.off(VerificationRequestEvent.Change, onChange);
        resolve(value);
      };
      const onChange = () => {
        if (request.verifier) {
          settle(request.verifier);
        } else if (
          request.phase === VerificationPhase.Cancelled ||
          request.phase === VerificationPhase.Done
        ) {
          settle(undefined);
        } else if (request.phase === VerificationPhase.Ready && !fallbackTimer) {
          fallbackTimer = setTimeout(() => {
            if (!request.verifier) {
              request.startVerification("m.sas.v1").then(settle, () => settle(undefined));
            }
          }, VERIFICATION_START_FALLBACK_MS);
        }
      };
      request.on(VerificationRequestEvent.Change, onChange);
      onChange();
    });
  }

  /**
   * Handle an incoming room message.
   */
  private async handleRoomMessage(
    state: MatrixAccountState,
    event: sdk.MatrixEvent,
    room: sdk.Room | undefined
  ): Promise<void> {
    if (!room) return;

    const message = buildMatrixMessage(event, room);
    if (!message) return;

    const roomId = message.roomId;

    // Check mention requirement. Skipped in 1:1 DMs: a direct message is
    // inherently addressed to the bot, so requiring an @mention there would
    // make it ignore the user. Group rooms still honor the gate.
    // A lazy-loaded room's member count is unreliable until the out-of-band
    // roster resolves (a large group can transiently look like a 1-member
    // room). Only a RESOLVED <=2 roster counts as direct: otherwise the room
    // is treated as governed and the membership gate decides, so a group can
    // never bypass admission via a partial roster.
    let rosterResolved = true;
    if (typeof room.loadMembersIfNeeded === "function") {
      try {
        await room.loadMembersIfNeeded();
      } catch {
        rosterResolved = false;
      }
    }
    const isDirectRoom = rosterResolved && room.getJoinedMemberCount() <= 2;
    if (state.settings.requireMention && !isDirectRoom) {
      const localpart = getMatrixLocalpart(state.settings.userId);
      const mentionPattern = new RegExp(`@?${escapeRegExp(localpart)}`, "i");
      if (!mentionPattern.test(message.content)) {
        return;
      }
    }

    const matrixRoom: MatrixRoom = {
      roomId,
      name: room.name,
      topic: room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic,
      canonicalAlias: room.getCanonicalAlias() || undefined,
      isEncrypted: room.hasEncryptionStateEvent(),
      isDirect:
        state.client
          .getAccountData(sdk.EventType.Direct)
          ?.getContent()
          ?.[message.sender || ""]?.includes(roomId) || false,
      memberCount: room.getJoinedMemberCount(),
    };

    logger.debug(
      `Matrix message from ${message.senderInfo.displayName || message.sender} in ${room.name || roomId}: ${truncateWellFormed(toWellFormedUnicode(message.content), 50)}...`
    );

    // Membership admission (group rooms only; DMs bypass). Fail-closed when
    // the authority is configured but cannot produce fresh evidence.
    if (state.membershipGate) {
      const allowed = await state.membershipGate.authorizeMessage({
        roomId,
        isDirectRoom,
        principalEntityId: matrixScopedUuid(this.runtime, `${state.accountId}:${message.sender}`),
        matrixUserId: message.sender,
        getJoinedMemberIds: () => room.getJoinedMembers().map((m) => m.userId),
      });
      if (!allowed) {
        return;
      }
    }

    // Plugin-local event other code may listen for (the MatrixMessage/MatrixRoom payload).
    this.runtime.emitEvent(MatrixEventTypes.MESSAGE_RECEIVED, {
      message,
      room: matrixRoom,
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);

    // Drive the core message loop so the agent actually reads and replies.
    // error-policy:J7 dispatch failure is reported after the loop; dispatch
    // must not take down the SDK event handler.
    void this.dispatchToAgent(state, message, matrixRoom).catch((err) =>
      logger.error(
        `Matrix dispatchToAgent failed: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }

  /**
   * Feed an inbound Matrix message into the core message loop and wire a
   * callback that posts the agent's reply back to the same room. Mirrors the
   * connector pattern used by plugin-discord: emit EventType.MESSAGE_RECEIVED
   * with a core Memory and a HandlerCallback. The bootstrap message handler
   * runs the agent, decides whether to respond, and invokes the callback.
   */
  private async dispatchToAgent(
    state: MatrixAccountState,
    message: MatrixMessage,
    room: MatrixRoom
  ): Promise<void> {
    const roomId = room.roomId;
    // Account-scoped derivations: two Matrix accounts on one runtime observing
    // the same room must never share room/world/entity UUIDs (the authority
    // scopes membership per connector account, and cross-account memory
    // blending is a privacy violation).
    // Authority-compatible derivation: the membership scope's entity/room/world
    // rows must match the ids publication bootstrapped (matrixScopedUuid).
    const scoped = (seed: string) => matrixScopedUuid(this.runtime, `${state.accountId}:${seed}`);
    const entityId = scoped(message.sender || roomId);
    const coreRoomId = scoped(roomId);
    const worldId = scoped(roomId);
    // Member count is the reliable DM signal (m.direct account data is often
    // unset for a bot) and matches the mention-gate check in handleRoomMessage.
    const channelType = room.memberCount <= 2 ? ChannelType.DM : ChannelType.GROUP;
    const displayName = message.senderInfo.displayName || message.sender || "Matrix user";

    await this.runtime.ensureConnection({
      entityId,
      roomId: coreRoomId,
      roomName: room.name || roomId,
      userName: displayName,
      name: displayName,
      source: MATRIX_SERVICE_NAME,
      channelId: roomId,
      type: channelType,
      worldId,
      worldName: room.name,
      // Preserve the raw Matrix user id for role / allowlist checks.
      userId: (message.sender || roomId) as UUID,
      metadata: { accountId: state.accountId },
    });

    const coreMessage = matrixMessageToMemory(this.runtime, message, channelType, state.accountId);

    // Auto-reply is gated (default off, matching plugin-discord/telegram) so the
    // agent never speaks unprompted; passive LifeOps mode also suppresses it.
    // When gated off, the inbound message is still persisted to memory.
    const autoReplyRaw = this.runtime.getSetting("MATRIX_AUTO_REPLY");
    const autoReply =
      !lifeOpsPassiveConnectorsEnabled(this.runtime) &&
      (autoReplyRaw === true || autoReplyRaw === "true");

    if (!autoReply) {
      try {
        await this.runtime.createMemory(coreMessage, "messages");
      } catch (err) {
        logger.warn(
          `Matrix inbound memory persist failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime: this.runtime,
          message: coreMessage,
          source: MATRIX_SERVICE_NAME,
        });
      } catch (err) {
        logger.warn(
          `Matrix inbound event emit failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    if (!this.runtime.messageService) {
      logger.error("Matrix: runtime.messageService is unavailable; cannot process inbound message");
      return;
    }

    const callback: HandlerCallback = async (responseContent: Content) => {
      const text = typeof responseContent.text === "string" ? responseContent.text.trim() : "";
      if (!text) {
        return [];
      }
      const result = await this.sendMessage(text, {
        accountId: state.accountId,
        roomId,
        threadId: message.threadId,
        replyTo: message.eventId,
      });
      if (!result.success) {
        logger.warn(`Matrix reply send failed in ${roomId}: ${result.error}`);
        return [];
      }
      const outbound: Memory = {
        // A primary key that never reaches the authority, but scoped v5 keeps
        // every "messages" row id homogeneous with its inbound siblings.
        id: matrixScopedUuid(this.runtime, result.eventId ?? `${roomId}:reply:${Date.now()}`),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: coreRoomId,
        content: {
          text,
          source: MATRIX_SERVICE_NAME,
          channelType,
          inReplyTo: coreMessage.id,
        },
        createdAt: Date.now(),
      };
      try {
        await this.runtime.createMemory(outbound, "messages");
      } catch (err) {
        logger.warn(
          `Matrix outbound memory persist failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return [outbound];
    };

    // Canonical dispatch: the core message loop runs through
    // messageService.handleMessage (mirrors plugin-discord/telegram), not a
    // bare EventType.MESSAGE_RECEIVED emit, which has no default handler.
    await this.runtime.messageService.handleMessage(this.runtime, coreMessage, callback);
  }

  /**
   * Connect to Matrix.
   */
  private async connect(state: MatrixAccountState): Promise<void> {
    try {
      await state.client.startClient({ initialSyncLimit: 10 });
      await waitForMatrixPrepared(state.client, sdk.ClientEvent.Sync);
      state.connected = true;
    } catch (error) {
      state.connected = false;
      state.syncing = false;
      try {
        state.client.stopClient();
      } catch (stopError) {
        // error-policy:J6 failed-startup teardown is best effort; preserve the
        // original connection failure while making cleanup failure visible.
        logger.warn(
          `Matrix client cleanup after failed connection failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        );
      }
      throw error;
    }

    // Join configured rooms
    for (const room of state.settings.rooms) {
      try {
        await this.joinRoom(room, state.accountId);
      } catch (err) {
        logger.warn(`Failed to join room ${room}: ${err}`);
      }
    }
  }

  /**
   * Shutdown the service.
   */
  async stop(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.cryptoSnapshotTimer) {
        clearInterval(state.cryptoSnapshotTimer);
        state.cryptoSnapshotTimer = undefined;
      }
      // Best-effort final flush so crypto state accumulated since the last tick
      // survives the restart. Non-fatal: saveCryptoStore swallows its own
      // failures. Guarded on encryption so a non-encrypted account doesn't
      // touch the (possibly absent) IndexedDB global.
      if (state.settings.encryption) {
        await this.saveCryptoStore(state);
      }
      state.client.stopClient();
      state.connected = false;
      state.syncing = false;
    }
    logger.info("Matrix service stopped");
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  isConnected(): boolean {
    const legacy = this as { connected?: boolean; syncing?: boolean };
    const states = this.states ?? new Map<string, MatrixAccountState>();
    if (states.size === 0 && typeof legacy.connected === "boolean") {
      return legacy.connected && (legacy.syncing ?? true);
    }
    return Array.from(states.values()).some((state) => state.connected && state.syncing);
  }

  getAccountId(runtime?: IAgentRuntime): string {
    const legacy = this as { settings?: MatrixSettings };
    const states = this.states ?? new Map<string, MatrixAccountState>();
    if (states.size === 0 && legacy.settings?.accountId) {
      return normalizeMatrixAccountId(legacy.settings.accountId);
    }
    return normalizeMatrixAccountId(
      this.defaultAccountId !== DEFAULT_MATRIX_ACCOUNT_ID
        ? this.defaultAccountId
        : runtime
          ? resolveDefaultMatrixAccountId(runtime)
          : this.defaultAccountId
    );
  }

  getUserId(): string {
    return this.getState().settings.userId;
  }

  getHomeserver(): string {
    return this.getState().settings.homeserver;
  }

  async getJoinedRooms(accountId?: string): Promise<MatrixRoom[]> {
    const state = this.getState(accountId);
    const rooms = state.client.getRooms();
    return rooms
      .filter((room) => room.getMyMembership() === "join")
      .map((room) => ({
        roomId: room.roomId,
        name: room.name,
        topic: room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic,
        canonicalAlias: room.getCanonicalAlias() || undefined,
        isEncrypted: room.hasEncryptionStateEvent(),
        isDirect: false,
        memberCount: room.getJoinedMemberCount(),
      }));
  }

  /**
   * Read recent messages straight from the SDK's live room timeline (kept in
   * sync by the RoomEvent.Timeline listener), newest-first. Unlike the agent's
   * own memory DB, this surfaces room activity the agent never persisted —
   * e.g. a busy room where the bot was never mentioned.
   */
  async getRoomMessages(
    matrixRoomId: string,
    limit: number | undefined,
    accountId?: string
  ): Promise<Memory[]> {
    const state = this.getState(accountId);
    const room = state.client.getRoom(matrixRoomId);
    if (!room) {
      return [];
    }

    const channelType = room.getJoinedMemberCount() <= 2 ? ChannelType.DM : ChannelType.GROUP;
    const events = room.getLiveTimeline().getEvents();
    const out: Memory[] = [];
    for (let i = events.length - 1; i >= 0 && (limit === undefined || out.length < limit); i -= 1) {
      const event = events[i];
      const message = buildMatrixMessage(event, room);
      if (message) {
        const memory = matrixMessageToMemory(this.runtime, message, channelType, state.accountId);
        memory.content.name = message.senderInfo.displayName || message.sender;
        out.push(memory);
        continue;
      }
      // Faithfully surface an encrypted message the agent can't read, so the
      // agent reports real encrypted activity (who/when) rather than treating the
      // room as empty. Two shapes must both be caught: a still-undecrypted event
      // keeps wire type "m.room.encrypted", but once decryption has FAILED the SDK
      // flips getType() to "m.room.message" with a "m.bad.encrypted" body and only
      // isDecryptionFailure() stays true — the original bug was checking type
      // alone, so failed-decrypt events fell through and the room looked empty.
      if (event.getType() === "m.room.encrypted" || event.isDecryptionFailure()) {
        const sender = event.getSender() || "unknown";
        const placeholder = matrixMessageToMemory(
          this.runtime,
          {
            eventId: event.getId() || "",
            roomId: matrixRoomId,
            sender,
            content:
              "🔒 [end-to-end encrypted message this device can't read — its device isn't cross-signed, so senders withhold the decryption keys. This needs a one-time device verification (or the account password) to unblock; it is NOT a sync or pagination issue.]",
            timestamp: event.getTs(),
          },
          channelType,
          state.accountId
        );
        placeholder.content.name = room.getMember(sender)?.name || sender;
        out.push(placeholder);
      }
    }
    return out;
  }

  async sendMessage(text: string, options?: MatrixMessageSendOptions): Promise<MatrixSendResult> {
    const state = this.getState(options?.accountId);
    if (!state.connected || !state.syncing) {
      throw new MatrixNotConnectedError();
    }

    const roomId = options?.roomId;
    if (!roomId?.trim()) {
      return { success: false, error: "Room ID is required" };
    }

    // Resolve room ID from alias if needed
    let resolvedRoomId = roomId.trim();
    if (isValidMatrixRoomAlias(resolvedRoomId)) {
      const resolved = await state.client.getRoomIdForAlias(resolvedRoomId);
      resolvedRoomId = resolved.room_id;
    }

    // Build content
    const content: {
      body: string;
      format?: "org.matrix.custom.html";
      formatted_body?: string;
      msgtype: sdk.MsgType.Text;
      "m.relates_to"?: {
        event_id?: string;
        rel_type?: sdk.RelationType.Thread;
        "m.in_reply_to"?: {
          event_id: string;
        };
      };
    } = {
      msgtype: sdk.MsgType.Text,
      body: text,
    };

    if (options?.formatted) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = text;
    }

    // Handle reply/thread
    if (options?.threadId || options?.replyTo) {
      content["m.relates_to"] = {};

      if (options.threadId) {
        content["m.relates_to"].rel_type = sdk.RelationType.Thread;
        content["m.relates_to"].event_id = options.threadId;
      }

      if (options.replyTo) {
        content["m.relates_to"]["m.in_reply_to"] = {
          event_id: options.replyTo,
        };
      }
    }

    const response = await state.client.sendMessage(
      resolvedRoomId,
      content as RoomMessageEventContent
    );
    const eventId = response.event_id;

    this.runtime.emitEvent(MatrixEventTypes.MESSAGE_SENT, {
      roomId: resolvedRoomId,
      eventId,
      content: text,
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);

    return {
      success: true,
      eventId,
      roomId: resolvedRoomId,
    };
  }

  async sendReaction(
    roomId: string,
    eventId: string,
    emoji: string,
    accountId?: string
  ): Promise<MatrixSendResult> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      throw new MatrixNotConnectedError();
    }
    const normalizedRoomId = roomId.trim();
    const normalizedEventId = eventId.trim();
    const normalizedEmoji = emoji.trim();
    if (!normalizedRoomId || !normalizedEventId || !normalizedEmoji) {
      return { success: false, error: "Room ID, event ID, and emoji are required" };
    }

    const content = {
      "m.relates_to": {
        rel_type: sdk.RelationType.Annotation as const,
        event_id: normalizedEventId,
        key: normalizedEmoji,
      },
    };

    const response = await state.client.sendEvent(
      normalizedRoomId,
      sdk.EventType.Reaction,
      content
    );

    return {
      success: true,
      eventId: response.event_id,
      roomId: normalizedRoomId,
    };
  }

  async joinRoom(roomIdOrAlias: string, accountId?: string): Promise<string> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      throw new MatrixNotConnectedError();
    }
    const normalizedRoomIdOrAlias = roomIdOrAlias.trim();
    if (!normalizedRoomIdOrAlias) {
      throw new Error("Matrix room ID or alias is required");
    }

    const response = await state.client.joinRoom(normalizedRoomIdOrAlias);
    const roomId = response.roomId;

    // The homeserver confirmed the join: clear any prior leave tombstone NOW.
    // Relying solely on the SDK membership event would leave the scope
    // tombstoned (snapshots rejected) whenever that event is missed.
    if (state.membershipAuthority) {
      state.membershipAuthority.clearScopeRemoval({ roomId });
      // error-policy:J7 post-join publication is diagnostic; the join itself
      // already succeeded. Publish THIS room directly from the Room object
      // the homeserver call returned — the store scan inside the general
      // publication pass only sees rooms whose getMyMembership() is already
      // "join" in the SDK's possibly-not-yet-synced state, which is exactly
      // the missed-event case this recovery exists for. Direct rooms (>2
      // exclusion) never register membership scopes — guard here the same
      // way the publication pass does.
      const directPublish =
        typeof response.getJoinedMemberCount === "function" && response.getJoinedMemberCount() > 2
          ? this.publishSingleRoomMembershipSnapshot(state, response)
          : Promise.resolve(false);
      void directPublish
        .catch((err) =>
          logger.error(
            `Matrix membership snapshot after join failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
        .then(() => {
          // Sweep the store too: rooms already known to the SDK get their
          // snapshots through the general pass (which enforces its own
          // freshness and direct-room rules).
          void this.publishMembershipSnapshots(state, false).catch((err) =>
            logger.error(
              `Matrix membership snapshot sweep after join failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        });
    }

    logger.info(`Joined room ${roomId}`);
    this.runtime.emitEvent(MatrixEventTypes.ROOM_JOINED, {
      room: { roomId },
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);

    return roomId;
  }

  async leaveRoom(roomId: string, accountId?: string): Promise<void> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      throw new MatrixNotConnectedError();
    }
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) {
      throw new Error("Matrix room ID is required");
    }

    await state.client.leave(normalizedRoomId);
    // The homeserver confirmed the leave: terminate the room's authority
    // scope NOW (unavailable + tombstone) instead of waiting for the SDK
    // membership event — otherwise persisted membership stays current (and
    // authorizing) after an explicit leave, potentially beyond this
    // process's lifetime if the event never arrives.
    if (state.membershipAuthority) {
      await state.membershipAuthority.markScopeUnavailable({
        roomId: normalizedRoomId,
        reason: "bot_left_explicit",
      });
    }
    logger.info(`Left room ${normalizedRoomId}`);
    this.runtime.emitEvent(MatrixEventTypes.ROOM_LEFT, {
      roomId: normalizedRoomId,
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);
  }

  async sendTyping(
    roomId: string,
    typing: boolean,
    timeout: number = 30000,
    accountId?: string
  ): Promise<void> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      return;
    }

    await state.client.sendTyping(roomId, typing, timeout);
  }

  async sendReadReceipt(roomId: string, eventId: string, accountId?: string): Promise<void> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      return;
    }

    await state.client.sendReadReceipt(new sdk.MatrixEvent({ event_id: eventId, room_id: roomId }));
  }

  async sendRoomMessage(roomIdOrAlias: string, content: Content): Promise<void> {
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }
    await this.sendMessage(text, {
      accountId: readMatrixAccountId(content) ?? this.getAccountId(),
      roomId: roomIdOrAlias,
    });
  }

  async sendDirectMessage(roomIdOrAlias: string, content: Content): Promise<void> {
    await this.sendRoomMessage(roomIdOrAlias, content);
  }

  private async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    const requestedAccountId = normalizeMatrixAccountId(
      target.accountId ?? readMatrixAccountId(content, target) ?? this.getAccountId()
    );
    this.getState(requestedAccountId);

    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }

    const room = target.roomId ? await runtime.getRoom(target.roomId) : null;
    const roomIdOrAlias = String(
      target.channelId ||
        room?.channelId ||
        (typeof target.roomId === "string" &&
        (isValidMatrixRoomId(target.roomId) || isValidMatrixRoomAlias(target.roomId))
          ? target.roomId
          : "")
    ).trim();

    if (!roomIdOrAlias) {
      throw new Error("Matrix target is missing a room ID or alias");
    }

    await this.sendMessage(text, {
      accountId: requestedAccountId,
      roomId: roomIdOrAlias,
      ...extractMatrixSendOptions(content, target),
    });
  }

  private getState(accountId = this.defaultAccountId): MatrixAccountState {
    const normalized = normalizeMatrixAccountId(accountId);
    const states = this.states ?? new Map<string, MatrixAccountState>();
    const state = states.get(normalized);
    if (state) {
      return state;
    }

    const legacy = this as {
      settings?: MatrixSettings;
      client?: sdk.MatrixClient;
      connected?: boolean;
      syncing?: boolean;
    };
    if (legacy.settings) {
      return {
        accountId: normalizeMatrixAccountId(legacy.settings.accountId ?? normalized),
        settings: legacy.settings,
        client: legacy.client ?? ({} as sdk.MatrixClient),
        connected: legacy.connected ?? true,
        syncing: legacy.syncing ?? true,
        membershipSnapshotToken: crypto.randomUUID(),
        membershipSnapshotCounter: 0,
      };
    }

    throw new Error(`Matrix account '${normalized}' is not available in this service instance`);
  }
}

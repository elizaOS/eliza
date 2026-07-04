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
  Service,
  type TargetInfo,
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
const ROOM_KEY_NONCE_BYTES = 12;

/**
 * Resolve the per-user state root the runtime already uses for on-disk state.
 * Matches the ELIZA_STATE_DIR convention so the encrypted
 * room-key files land next to the rest of the agent's persistent state.
 */
function resolveStateDir(): string {
  return process.env.ELIZA_STATE_DIR || join(homedir(), ".local/state/eliza");
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
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
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

function normalizeConnectorLimit(limit: number | undefined, fallback = 50): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), 200);
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
 */
function matrixMessageToMemory(
  runtime: IAgentRuntime,
  message: Pick<
    MatrixMessage,
    "roomId" | "eventId" | "timestamp" | "sender" | "content" | "replyTo"
  >,
  channelType: ChannelType
): Memory {
  const roomId = message.roomId;
  return {
    id: createUniqueUuid(runtime, message.eventId || `${roomId}:${message.timestamp}`),
    entityId: createUniqueUuid(runtime, message.sender || roomId),
    agentId: runtime.agentId,
    roomId: createUniqueUuid(runtime, message.roomId),
    content: {
      text: message.content,
      source: MATRIX_SERVICE_NAME,
      channelType,
      ...(message.replyTo ? { inReplyTo: createUniqueUuid(runtime, message.replyTo) } : {}),
    },
    createdAt: message.timestamp,
  };
}

async function readStoredMessageMemories(
  runtime: IAgentRuntime,
  roomId: UUID,
  limit: number
): Promise<Memory[]> {
  return runtime.getMemories({
    tableName: "messages",
    roomId,
    limit,
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
  limit: number
): Promise<Memory[]> {
  const rooms = (await service.getJoinedRooms(accountId)).slice(0, 10);
  const chunks = await Promise.all(
    rooms.map((room) => service.getRoomMessages(room.roomId, limit, accountId))
  );
  return chunks
    .flat()
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    .slice(0, limit);
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
  limit: number
): Promise<Memory[]> {
  const matrixRoomId = await resolveMatrixRoomId(runtime, target);
  if (!matrixRoomId) {
    return readJoinedRoomMessages(service, accountId, limit);
  }
  const live = await service.getRoomMessages(matrixRoomId, limit, accountId);
  if (live.length > 0) {
    return live;
  }
  return readStoredMessageMemories(runtime, createUniqueUuid(runtime, matrixRoomId), limit);
}

function filterMemoriesByQuery(memories: Memory[], query: string, limit: number): Memory[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return memories.slice(0, limit);
  }
  return memories
    .filter((memory) => {
      const text = typeof memory.content?.text === "string" ? memory.content.text : "";
      return text.toLowerCase().includes(normalized);
    })
    .slice(0, limit);
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
            .sort((left, right) => right.score - left.score)
            .slice(0, 10)
            .map(({ room, score }) => matrixRoomToConnectorTarget(room, score, accountId));
        },
        listRecentTargets: async () =>
          (await service.getJoinedRooms(accountId))
            .slice(0, 10)
            .map((room) => matrixRoomToConnectorTarget(room, 0.5, accountId)),
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
          // Scan wider than the requested limit so the query filter has candidates.
          const messages = await readMessagesForTarget(
            service,
            context.runtime,
            accountId,
            target,
            Math.max(limit, 100)
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
      };

      this.states.set(state.accountId, state);
      await this.initCrypto(state);
      this.startCryptoSnapshot(state);
      this.setupEventHandlers(state);
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
      await crypto.checkKeyBackupAndEnable().catch(() => {});
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
    state.client.on(sdk.ClientEvent.Sync, (syncState) => {
      if (syncState === "PREPARED") {
        state.syncing = true;
        logger.info("Matrix sync complete");
        this.runtime.emitEvent(MatrixEventTypes.SYNC_COMPLETE, {
          runtime: this.runtime,
          accountId: state.accountId,
        } as EventPayload);
      }
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
            this.handleRoomMessage(state, event, room);
          } else if (event.isDecryptionFailure()) {
            logger.warn(
              `Matrix could not decrypt event ${event.getId()} in ${event.getRoomId()} — the sender has not shared the megolm key with this device yet.`
            );
          }
        });
        return;
      }

      if (event.getType() !== "m.room.message") return;
      this.handleRoomMessage(state, event, room);
    });

    // Room membership events
    state.client.on(sdk.RoomMemberEvent.Membership, (event, member) => {
      if (member.userId !== state.settings.userId) return;

      if (member.membership === "invite" && state.settings.autoJoin) {
        const roomId = event.getRoomId();
        if (roomId) {
          logger.info(`Auto-joining room ${roomId}`);
          state.client.joinRoom(roomId).catch((err) => {
            logger.error(`Failed to auto-join room: ${err.message}`);
          });
        }
      }
    });

    this.setupVerificationAutoAccept(state);
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
  private handleRoomMessage(
    state: MatrixAccountState,
    event: sdk.MatrixEvent,
    room: sdk.Room | undefined
  ): void {
    if (!room) return;

    const message = buildMatrixMessage(event, room);
    if (!message) return;

    const roomId = message.roomId;

    // Check mention requirement. Skipped in 1:1 DMs: a direct message is
    // inherently addressed to the bot, so requiring an @mention there would
    // make it ignore the user. Group rooms still honor the gate.
    const isDirectRoom = room.getJoinedMemberCount() <= 2;
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
      `Matrix message from ${message.senderInfo.displayName || message.sender} in ${room.name || roomId}: ${message.content.slice(0, 50)}...`
    );

    // Plugin-local event other code may listen for (the MatrixMessage/MatrixRoom payload).
    this.runtime.emitEvent(MatrixEventTypes.MESSAGE_RECEIVED, {
      message,
      room: matrixRoom,
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);

    // Drive the core message loop so the agent actually reads and replies.
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
    const entityId = createUniqueUuid(this.runtime, message.sender || roomId);
    const coreRoomId = createUniqueUuid(this.runtime, roomId);
    const worldId = createUniqueUuid(this.runtime, roomId);
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

    const coreMessage = matrixMessageToMemory(this.runtime, message, channelType);

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
        id: createUniqueUuid(this.runtime, result.eventId ?? `${roomId}:reply:${Date.now()}`),
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
    await state.client.startClient({ initialSyncLimit: 10 });
    state.connected = true;

    // Wait for initial sync
    await new Promise<void>((resolve) => {
      const listener = (syncState: string) => {
        if (syncState === "PREPARED") {
          state.client.removeListener(sdk.ClientEvent.Sync, listener);
          resolve();
        }
      };
      state.client.on(sdk.ClientEvent.Sync, listener);
    });

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
    limit: number,
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
    for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const event = events[i];
      const message = buildMatrixMessage(event, room);
      if (message) {
        const memory = matrixMessageToMemory(this.runtime, message, channelType);
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
          channelType
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
      };
    }

    throw new Error(`Matrix account '${normalized}' is not available in this service instance`);
  }
}

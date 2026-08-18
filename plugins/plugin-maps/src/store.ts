/**
 * Persists owner-scoped saved places in one canonical CAS document per owner.
 * The document atomically binds current resources to an immutable operation
 * ledger, so applied/replayed results come from committed datastore state.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type UUID,
} from "@elizaos/core";
import * as z from "zod";
import { MapsError } from "./errors.js";
import {
  type SavedPlace,
  type SavePlaceRequest,
  type SavePlaceResult,
  savedPlaceSchema,
} from "./types.js";

export const SAVED_PLACES_TABLE = "documents";
const SAVED_PLACE_SOURCE = "plugin-maps.saved-place-state.v1";
const MAX_CAS_ATTEMPTS = 16;

const savedPlaceOperationSchema = z
  .object({
    mutationId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    committedAt: z.string().datetime({ offset: true }),
    result: savedPlaceSchema,
  })
  .strict();

const savedPlaceStateSchema = z
  .object({
    version: z.literal(1),
    generation: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    ownerEntityId: z.string().uuid(),
    savedPlaces: z.array(savedPlaceSchema),
    operations: z.array(savedPlaceOperationSchema),
  })
  .strict();

type SavedPlaceState = z.infer<typeof savedPlaceStateSchema>;
type SavedPlaceOperation = z.infer<typeof savedPlaceOperationSchema>;

const namespacePromises = new WeakMap<IAgentRuntime, Promise<void>>();
const PROCESS_LOCKS_KEY = Symbol.for(
  "@elizaos/plugin-maps:saved-place-cas-locks",
);
type LockRegistry = Map<string, Promise<void>>;

function processLocks(): LockRegistry {
  const root = globalThis as typeof globalThis & {
    [PROCESS_LOCKS_KEY]?: LockRegistry;
  };
  root[PROCESS_LOCKS_KEY] ??= new Map<string, Promise<void>>();
  return root[PROCESS_LOCKS_KEY];
}

function stateWorldId(runtime: IAgentRuntime): UUID {
  return createUniqueUuid(runtime, "maps:saved-places:world") as UUID;
}

function stateRoomId(runtime: IAgentRuntime): UUID {
  return createUniqueUuid(runtime, "maps:saved-places:room") as UUID;
}

function stateDocumentId(runtime: IAgentRuntime, ownerEntityId: string): UUID {
  return createUniqueUuid(
    runtime,
    `maps:saved-places:owner:${ownerEntityId}`,
  ) as UUID;
}

function uuidFromKey(key: string): UUID {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}` as UUID;
}

function savedPlaceId(runtime: IAgentRuntime, request: SavePlaceRequest): UUID {
  return uuidFromKey(
    `maps-saved-place-v2:${runtime.agentId}:${request.ownerEntityId}:${request.place.provider}:${request.place.providerPlaceId}`,
  );
}

async function ensureNamespace(runtime: IAgentRuntime): Promise<void> {
  const prior = namespacePromises.get(runtime);
  if (prior) return prior;
  const setup = (async () => {
    const worldId = stateWorldId(runtime);
    try {
      await runtime.ensureWorldExists({
        id: worldId,
        name: "Maps saved places",
        agentId: runtime.agentId,
      });
    } catch (error) {
      // error-policy:J1 A concurrent deterministic namespace insert is success
      // only after the adapter confirms the expected durable world.
      const [persisted] = await runtime.adapter.getWorldsByIds([worldId]);
      if (!persisted) throw error;
    }
    const roomId = stateRoomId(runtime);
    try {
      await runtime.ensureRoomExists({
        id: roomId,
        name: "Maps saved places",
        source: SAVED_PLACE_SOURCE,
        type: ChannelType.API,
        channelId: `maps-saved-places-${runtime.agentId}`,
        worldId,
      });
    } catch (error) {
      // error-policy:J1 The same verified duplicate-key translation applies to
      // the deterministic room; unrelated persistence failures still escape.
      const [persisted] = await runtime.adapter.getRoomsByIds([roomId]);
      if (!persisted || persisted.worldId !== worldId) throw error;
    }
  })();
  namespacePromises.set(runtime, setup);
  return setup;
}

function assertCasStorage(runtime: IAgentRuntime): void {
  if (
    runtime.adapter.documentListQueryCapability !== 2 ||
    typeof runtime.adapter.getDocument !== "function" ||
    typeof runtime.adapter.compareAndSwapDocument !== "function"
  ) {
    throw new MapsError("Saved-place atomic storage is unavailable.", {
      code: "MAPS_STORAGE_FAILURE",
      context: { agentId: runtime.agentId },
    });
  }
}

function requester(runtime: IAgentRuntime) {
  return {
    agentId: runtime.agentId,
    requesterEntityId: runtime.agentId,
    requesterRoomIds: [stateRoomId(runtime)],
    requesterRole: "RUNTIME" as const,
  };
}

function parseState(memory: Memory | null): SavedPlaceState | null {
  if (!memory) return null;
  const metadata = memory.metadata as Record<string, unknown> | undefined;
  const parsed = savedPlaceStateSchema.safeParse(metadata?.mapsSavedPlaceState);
  if (!parsed.success) {
    throw new MapsError("Persisted saved-place state is malformed.", {
      code: "MAPS_STORAGE_FAILURE",
      cause: parsed.error,
      context: { memoryId: memory.id },
    });
  }
  return parsed.data;
}

function buildStateMemory(
  runtime: IAgentRuntime,
  documentId: UUID,
  state: SavedPlaceState,
  createdAt = Date.now(),
): Memory {
  const metadata = {
    type: MemoryType.DOCUMENT,
    scope: "agent-private",
    source: SAVED_PLACE_SOURCE,
    timestamp: createdAt,
    documentRevision: state.revision,
    mapsSavedPlaceState: state,
  } as unknown as MemoryMetadata;
  return {
    id: documentId,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: stateRoomId(runtime),
    worldId: stateWorldId(runtime),
    content: { text: "Maps saved-place state" },
    metadata,
    createdAt,
    unique: true,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mutation(request: SavePlaceRequest): {
  idempotencyKey: string;
  label: string;
  requestDigest: string;
} {
  const label = request.label?.trim() || request.place.name;
  const requestDigest = digest({ place: request.place, label });
  return {
    label,
    requestDigest,
    idempotencyKey:
      request.idempotencyKey?.trim() || `maps-save:${requestDigest}`,
  };
}

function replay(
  operation: SavedPlaceOperation,
  expectedDigest: string,
): SavePlaceResult {
  if (operation.requestDigest !== expectedDigest) {
    throw new MapsError(
      "The idempotency key belongs to a different saved-place mutation.",
      {
        code: "MAPS_INVALID_INPUT",
        context: { idempotencyKey: operation.idempotencyKey },
      },
    );
  }
  return {
    savedPlace: operation.result,
    replayed: true,
    commitId: operation.mutationId,
    committedAt: operation.committedAt,
    idempotencyKey: operation.idempotencyKey,
  };
}

function nextCommittedAt(state: SavedPlaceState | null): string {
  const latest = state?.operations.at(-1)?.committedAt;
  const minimum = latest ? Date.parse(latest) + 1 : 0;
  return new Date(Math.max(Date.now(), minimum)).toISOString();
}

export interface SavedPlaceStore {
  save(request: SavePlaceRequest): Promise<SavePlaceResult>;
  list(ownerEntityId: string): Promise<SavedPlace[]>;
  get(ownerEntityId: string, savedPlaceId: string): Promise<SavedPlace | null>;
}

export class RuntimeSavedPlaceStore implements SavedPlaceStore {
  constructor(private readonly runtime: IAgentRuntime) {}

  async save(request: SavePlaceRequest): Promise<SavePlaceResult> {
    assertCasStorage(this.runtime);
    await ensureNamespace(this.runtime);
    const normalized = mutation(request);
    const lockKey = `${this.runtime.agentId}:${request.ownerEntityId}`;
    const locks = processLocks();
    const prior = locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(lockKey, current);
    await prior;
    try {
      return await this.saveWithCas(request, normalized);
    } finally {
      release();
      if (locks.get(lockKey) === current) locks.delete(lockKey);
    }
  }

  async list(ownerEntityId: string): Promise<SavedPlace[]> {
    assertCasStorage(this.runtime);
    await ensureNamespace(this.runtime);
    const memory = await this.runtime.adapter.getDocument({
      ...requester(this.runtime),
      documentId: stateDocumentId(this.runtime, ownerEntityId),
    });
    const state = parseState(memory);
    if (state && state.ownerEntityId !== ownerEntityId) {
      throw new MapsError("Saved-place owner binding is invalid.", {
        code: "MAPS_STORAGE_FAILURE",
      });
    }
    return state?.savedPlaces ?? [];
  }

  async get(
    ownerEntityId: string,
    savedPlaceId: string,
  ): Promise<SavedPlace | null> {
    return (
      (await this.list(ownerEntityId)).find(
        (place) => place.id === savedPlaceId,
      ) ?? null
    );
  }

  private async saveWithCas(
    request: SavePlaceRequest,
    normalized: ReturnType<typeof mutation>,
  ): Promise<SavePlaceResult> {
    const documentId = stateDocumentId(this.runtime, request.ownerEntityId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const document = await this.runtime.adapter.getDocument({
        ...requester(this.runtime),
        documentId,
      });
      const state = parseState(document);
      if (state && state.ownerEntityId !== request.ownerEntityId) {
        throw new MapsError("Saved-place owner binding is invalid.", {
          code: "MAPS_STORAGE_FAILURE",
        });
      }
      const prior = state?.operations.find(
        (operation) => operation.idempotencyKey === normalized.idempotencyKey,
      );
      if (prior) return replay(prior, normalized.requestDigest);

      const committedAt = nextCommittedAt(state);
      const mutationId = randomUUID() as UUID;
      const id = savedPlaceId(this.runtime, request);
      const existing = state?.savedPlaces.find((place) => place.id === id);
      const savedPlace = savedPlaceSchema.parse({
        id,
        ownerEntityId: request.ownerEntityId,
        place: request.place,
        label: normalized.label,
        createdAt: existing?.createdAt ?? committedAt,
        updatedAt: committedAt,
      });
      const operation: SavedPlaceOperation = {
        mutationId,
        idempotencyKey: normalized.idempotencyKey,
        requestDigest: normalized.requestDigest,
        committedAt,
        result: savedPlace,
      };
      const savedPlaces = state
        ? state.savedPlaces.some((place) => place.id === id)
          ? state.savedPlaces.map((place) =>
              place.id === id ? savedPlace : place,
            )
          : [...state.savedPlaces, savedPlace]
        : [savedPlace];
      const replacement: SavedPlaceState = {
        version: 1,
        generation: mutationId,
        revision: (state?.revision ?? -1) + 1,
        ownerEntityId: request.ownerEntityId,
        savedPlaces,
        operations: [...(state?.operations ?? []), operation],
      };

      if (!document) {
        await this.runtime.createMemory(
          buildStateMemory(this.runtime, documentId, replacement),
          SAVED_PLACES_TABLE,
          true,
        );
        const persisted = parseState(
          await this.runtime.adapter.getDocument({
            ...requester(this.runtime),
            documentId,
          }),
        );
        const persistedOperation = persisted?.operations.find(
          (entry) => entry.idempotencyKey === normalized.idempotencyKey,
        );
        if (!persistedOperation) continue;
        if (persistedOperation.mutationId !== mutationId) {
          return replay(persistedOperation, normalized.requestDigest);
        }
      } else {
        const result = await this.runtime.adapter.compareAndSwapDocument({
          ...requester(this.runtime),
          documentId,
          expected: {
            scope: "agent-private",
            roomId: stateRoomId(this.runtime),
            entityId: this.runtime.agentId,
            revision: state?.revision ?? 0,
          },
          replacement: buildStateMemory(
            this.runtime,
            documentId,
            replacement,
            document.createdAt,
          ),
        });
        if (result.status !== "updated") continue;
      }
      return {
        savedPlace,
        replayed: false,
        commitId: mutationId,
        committedAt,
        idempotencyKey: normalized.idempotencyKey,
      };
    }
    throw new MapsError("Saved-place persistence remained contended.", {
      code: "MAPS_STORAGE_FAILURE",
      context: { ownerEntityId: request.ownerEntityId },
    });
  }
}

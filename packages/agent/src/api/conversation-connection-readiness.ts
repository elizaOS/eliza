/**
 * Serializes web-conversation topology reconciliation for a running agent.
 *
 * Descriptors capture the exact runtime, topology, room generation, and caller
 * used by a turn. Connection work is single-flight per descriptor and serialized
 * per runtime because every web conversation mutates one shared world. Room
 * generation tokens are globally unique and safely evictable: eviction makes an
 * old descriptor invalid instead of letting a default generation revive it.
 */
import { type AgentRuntime, ElizaError, type UUID } from "@elizaos/core";
import type { BoundaryWorldRole } from "./boundary-role-resolver.ts";

const MAX_TRACKED_CONVERSATION_ROOMS = 2_048;
const MAX_PENDING_CONNECTION_MUTATIONS = 256;
const CONNECTION_MUTATION_TIMEOUT_MS = 15_000;

const CONNECTION_ERROR_CODES = new Set([
  "CONVERSATION_CONNECTION_INVALIDATED",
  "CONVERSATION_CONNECTION_QUEUE_SATURATED",
  "CONVERSATION_CONNECTION_REFRESH_FAILED",
  "CONVERSATION_CONNECTION_ROOM_BLOCKED",
  "CONVERSATION_CONNECTION_TIMEOUT",
  "CONVERSATION_RUNTIME_CHANGED",
]);

export interface ConversationConnectionDescriptor {
  readonly runtime: AgentRuntime;
  readonly runtimeAgentId: UUID;
  readonly conversationId: string;
  readonly roomId: UUID;
  readonly worldId: UUID;
  readonly messageServerId: UUID;
  readonly channelId: string;
  readonly agentName: string;
  readonly ownerId: UUID;
  readonly callerEntityId: UUID;
  readonly callerRole: BoundaryWorldRole;
  readonly callerUserName: string;
  readonly topologyIdentity: string;
  readonly proofIdentity: string;
  readonly topologyGeneration: number;
  readonly roomGeneration: number;
}

interface InFlightConnectionEnsure {
  readonly descriptor: ConversationConnectionDescriptor;
  readonly promise: Promise<void>;
}

interface ConversationConnectionRegistry {
  topologyIdentity: string | null;
  topologyGeneration: number;
  nextRoomGeneration: number;
  readonly roomGenerations: Map<UUID, number>;
  readonly inFlightEnsures: Map<string, InFlightConnectionEnsure>;
  readonly blockedRooms: Set<UUID>;
  readonly stalledMutations: Set<Promise<void>>;
  pendingMutationCount: number;
  mutationTail: Promise<void>;
}

const registries = new WeakMap<AgentRuntime, ConversationConnectionRegistry>();

function getRegistry(runtime: AgentRuntime): ConversationConnectionRegistry {
  let registry = registries.get(runtime);
  if (!registry) {
    registry = {
      topologyIdentity: null,
      topologyGeneration: 0,
      nextRoomGeneration: 0,
      roomGenerations: new Map(),
      inFlightEnsures: new Map(),
      blockedRooms: new Set(),
      stalledMutations: new Set(),
      pendingMutationCount: 0,
      mutationTail: Promise.resolve(),
    };
    registries.set(runtime, registry);
  }
  return registry;
}

function connectionTopologyIdentity(input: {
  runtimeAgentId: UUID;
  agentName: string;
  worldId: UUID;
  messageServerId: UUID;
  ownerId: UUID;
}): string {
  return JSON.stringify([
    input.runtimeAgentId,
    input.agentName,
    input.worldId,
    input.messageServerId,
    input.ownerId,
  ]);
}

function connectionProofIdentity(input: {
  topologyIdentity: string;
  conversationId: string;
  roomId: UUID;
  channelId: string;
  ownerId: UUID;
  callerEntityId: UUID;
  callerRole: BoundaryWorldRole;
  callerUserName: string;
}): string {
  return JSON.stringify([
    input.topologyIdentity,
    input.conversationId,
    input.roomId,
    input.channelId,
    input.ownerId,
    input.callerEntityId,
    input.callerRole,
    input.callerUserName,
  ]);
}

function invalidateTopology(
  registry: ConversationConnectionRegistry,
  nextTopologyIdentity: string | null,
): void {
  registry.topologyGeneration += 1;
  registry.topologyIdentity = nextTopologyIdentity;
}

function roomHasInFlightEnsure(
  registry: ConversationConnectionRegistry,
  roomId: UUID,
): boolean {
  return Array.from(registry.inFlightEnsures.values()).some(
    (entry) => entry.descriptor.roomId === roomId,
  );
}

function pruneRoomGenerations(registry: ConversationConnectionRegistry): void {
  const candidateCount = registry.roomGenerations.size;
  let inspected = 0;
  while (
    registry.roomGenerations.size > MAX_TRACKED_CONVERSATION_ROOMS &&
    inspected < candidateCount
  ) {
    const oldestRoomId = registry.roomGenerations.keys().next().value;
    if (typeof oldestRoomId !== "string") return;
    inspected += 1;
    if (
      registry.blockedRooms.has(oldestRoomId) ||
      roomHasInFlightEnsure(registry, oldestRoomId)
    ) {
      const generation = registry.roomGenerations.get(oldestRoomId);
      registry.roomGenerations.delete(oldestRoomId);
      if (generation !== undefined) {
        registry.roomGenerations.set(oldestRoomId, generation);
      }
      continue;
    }
    // Missing is an invalid generation. A later capture allocates a globally
    // unique token, so eviction can never make an old descriptor current.
    registry.roomGenerations.delete(oldestRoomId);
  }
}

function allocateRoomGeneration(
  registry: ConversationConnectionRegistry,
  roomId: UUID,
): number {
  registry.nextRoomGeneration += 1;
  const generation = registry.nextRoomGeneration;
  registry.roomGenerations.delete(roomId);
  registry.roomGenerations.set(roomId, generation);
  pruneRoomGenerations(registry);
  return generation;
}

function currentRoomGeneration(
  registry: ConversationConnectionRegistry,
  roomId: UUID,
): number {
  const generation = registry.roomGenerations.get(roomId);
  if (generation !== undefined) {
    registry.roomGenerations.delete(roomId);
    registry.roomGenerations.set(roomId, generation);
    return generation;
  }
  return allocateRoomGeneration(registry, roomId);
}

function descriptorGenerationsAreCurrent(
  registry: ConversationConnectionRegistry,
  descriptor: ConversationConnectionDescriptor,
): boolean {
  return (
    registry.topologyIdentity === descriptor.topologyIdentity &&
    registry.topologyGeneration === descriptor.topologyGeneration &&
    registry.roomGenerations.get(descriptor.roomId) ===
      descriptor.roomGeneration
  );
}

function descriptorIsCurrent(
  registry: ConversationConnectionRegistry,
  descriptor: ConversationConnectionDescriptor,
): boolean {
  return (
    descriptorGenerationsAreCurrent(registry, descriptor) &&
    !registry.blockedRooms.has(descriptor.roomId)
  );
}

function invalidatedConnectionError(
  descriptor: ConversationConnectionDescriptor,
  cause?: unknown,
): ElizaError {
  return new ElizaError("Conversation connection descriptor was invalidated", {
    code: "CONVERSATION_CONNECTION_INVALIDATED",
    ...(cause !== undefined ? { cause } : {}),
    context: {
      agentId: descriptor.runtimeAgentId,
      conversationId: descriptor.conversationId,
      roomId: descriptor.roomId,
      worldId: descriptor.worldId,
    },
    severity: "ephemeral",
  });
}

function assertDescriptorCurrent(
  registry: ConversationConnectionRegistry,
  descriptor: ConversationConnectionDescriptor,
): void {
  if (!descriptorGenerationsAreCurrent(registry, descriptor)) {
    throw invalidatedConnectionError(descriptor);
  }
  if (registry.blockedRooms.has(descriptor.roomId)) {
    throw new ElizaError("Conversation room is being deleted", {
      code: "CONVERSATION_CONNECTION_ROOM_BLOCKED",
      context: {
        agentId: descriptor.runtimeAgentId,
        conversationId: descriptor.conversationId,
        roomId: descriptor.roomId,
      },
      severity: "ephemeral",
    });
  }
}

interface ConnectionMutationContext {
  readonly agentId: UUID;
  readonly roomId: UUID;
  readonly conversationId?: string;
  readonly worldId?: UUID;
}

interface EnqueuedConnectionMutation {
  /** The exclusive lock remains attached to this promise until I/O settles. */
  readonly raw: Promise<void>;
  /** The request-facing observer rejects at the bounded deadline. */
  readonly result: Promise<void>;
}

function mutationUnavailableError(
  context: ConnectionMutationContext,
  code:
    | "CONVERSATION_CONNECTION_QUEUE_SATURATED"
    | "CONVERSATION_CONNECTION_TIMEOUT",
  message: string,
): ElizaError {
  return new ElizaError(message, {
    code,
    context: { ...context },
    severity: "ephemeral",
  });
}

function enqueueConnectionMutation(
  registry: ConversationConnectionRegistry,
  context: ConnectionMutationContext,
  mutation: () => Promise<void>,
  onTimeout: () => void,
): EnqueuedConnectionMutation {
  if (registry.stalledMutations.size > 0) {
    throw mutationUnavailableError(
      context,
      "CONVERSATION_CONNECTION_TIMEOUT",
      "Conversation connection reconciliation is quarantined behind an unsettled write",
    );
  }
  if (registry.pendingMutationCount >= MAX_PENDING_CONNECTION_MUTATIONS) {
    throw mutationUnavailableError(
      context,
      "CONVERSATION_CONNECTION_QUEUE_SATURATED",
      "Conversation connection reconciliation queue is saturated",
    );
  }

  const timeoutError = mutationUnavailableError(
    context,
    "CONVERSATION_CONNECTION_TIMEOUT",
    "Conversation connection reconciliation exceeded its deadline",
  );
  let cancelledBeforeStart = false;
  const execute = async (): Promise<void> => {
    if (cancelledBeforeStart) throw timeoutError;
    await mutation();
  };

  registry.pendingMutationCount += 1;
  const run = registry.mutationTail.then(execute, execute);
  registry.mutationTail = run.then(
    () => undefined,
    () => undefined,
  );

  let observerSettled = false;
  const result = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (observerSettled) return;
      observerSettled = true;
      cancelledBeforeStart = true;
      onTimeout();
      // The request may fail now, but the raw write keeps exclusive ownership
      // of mutationTail. New mutations fail fast until that I/O truly settles.
      registry.stalledMutations.add(run);
      reject(timeoutError);
    }, CONNECTION_MUTATION_TIMEOUT_MS);

    run.then(
      () => {
        clearTimeout(deadline);
        if (observerSettled) return;
        observerSettled = true;
        resolve();
      },
      (error: unknown) => {
        clearTimeout(deadline);
        if (observerSettled) return;
        observerSettled = true;
        reject(error);
      },
    );
  });

  const releaseMutation = (): void => {
    registry.pendingMutationCount -= 1;
    registry.stalledMutations.delete(run);
  };
  run.then(releaseMutation, releaseMutation);
  return { raw: run, result };
}

/**
 * Captures every mutable input that determines the connection writes. The
 * returned descriptor remains valid only for the generations recorded here.
 */
export function captureConversationConnectionDescriptor(input: {
  runtime: AgentRuntime;
  conversationId: string;
  roomId: UUID;
  agentName: string;
  worldId: UUID;
  messageServerId: UUID;
  channelId: string;
  ownerId: UUID;
  callerEntityId: UUID;
  callerRole: BoundaryWorldRole;
  callerUserName: string;
}): ConversationConnectionDescriptor {
  const registry = getRegistry(input.runtime);
  const topologyIdentity = connectionTopologyIdentity({
    runtimeAgentId: input.runtime.agentId,
    agentName: input.agentName,
    worldId: input.worldId,
    messageServerId: input.messageServerId,
    ownerId: input.ownerId,
  });
  if (registry.topologyIdentity === null) {
    registry.topologyIdentity = topologyIdentity;
  } else if (registry.topologyIdentity !== topologyIdentity) {
    invalidateTopology(registry, topologyIdentity);
  }

  const proofIdentity = connectionProofIdentity({
    topologyIdentity,
    conversationId: input.conversationId,
    roomId: input.roomId,
    channelId: input.channelId,
    ownerId: input.ownerId,
    callerEntityId: input.callerEntityId,
    callerRole: input.callerRole,
    callerUserName: input.callerUserName,
  });

  return Object.freeze({
    runtime: input.runtime,
    runtimeAgentId: input.runtime.agentId,
    conversationId: input.conversationId,
    roomId: input.roomId,
    worldId: input.worldId,
    messageServerId: input.messageServerId,
    channelId: input.channelId,
    agentName: input.agentName,
    ownerId: input.ownerId,
    callerEntityId: input.callerEntityId,
    callerRole: input.callerRole,
    callerUserName: input.callerUserName,
    topologyIdentity,
    proofIdentity,
    topologyGeneration: registry.topologyGeneration,
    roomGeneration: currentRoomGeneration(registry, input.roomId),
  });
}

/**
 * Coalesces identical work and serializes shared-world mutations. Callers await
 * this prerequisite before generation; it is not a success cache.
 */
export function scheduleConversationConnectionEnsure(
  descriptor: ConversationConnectionDescriptor,
  ensure: () => Promise<void>,
): Promise<void> {
  const registry = getRegistry(descriptor.runtime);
  try {
    assertDescriptorCurrent(registry, descriptor);
  } catch (error) {
    return Promise.reject(error);
  }

  const existing = registry.inFlightEnsures.get(descriptor.proofIdentity);
  if (
    existing &&
    existing.descriptor.topologyGeneration === descriptor.topologyGeneration &&
    existing.descriptor.roomGeneration === descriptor.roomGeneration
  ) {
    return existing.promise;
  }

  let run: Promise<void>;
  try {
    run = enqueueConnectionMutation(
      registry,
      {
        agentId: descriptor.runtimeAgentId,
        conversationId: descriptor.conversationId,
        roomId: descriptor.roomId,
        worldId: descriptor.worldId,
      },
      async () => {
        assertDescriptorCurrent(registry, descriptor);
        try {
          await ensure();
          assertDescriptorCurrent(registry, descriptor);
        } catch (error) {
          if (isConversationConnectionError(error)) {
            throw error;
          }
          if (!descriptorIsCurrent(registry, descriptor)) {
            throw invalidatedConnectionError(descriptor, error);
          }
          invalidateTopology(registry, registry.topologyIdentity);
          const reason = error instanceof Error ? error.message : String(error);
          throw new ElizaError(
            `Conversation connection reconciliation failed: ${reason}`,
            {
              code: "CONVERSATION_CONNECTION_REFRESH_FAILED",
              cause: error,
              context: {
                agentId: descriptor.runtimeAgentId,
                conversationId: descriptor.conversationId,
                roomId: descriptor.roomId,
                worldId: descriptor.worldId,
              },
              severity: "ephemeral",
            },
          );
        }
      },
      () => {
        invalidateTopology(registry, registry.topologyIdentity);
      },
    ).result;
  } catch (error) {
    return Promise.reject(error);
  }

  let tracked: Promise<void>;
  tracked = run.finally(() => {
    if (
      registry.inFlightEnsures.get(descriptor.proofIdentity)?.promise ===
      tracked
    ) {
      registry.inFlightEnsures.delete(descriptor.proofIdentity);
    }
    pruneRoomGenerations(registry);
  });
  registry.inFlightEnsures.set(descriptor.proofIdentity, {
    descriptor,
    promise: tracked,
  });
  // error-policy:J5 route callers await the returned promise; this observer
  // prevents a rejection from becoming unhandled before a queued caller joins.
  tracked.catch(() => {});
  return tracked;
}

/** Invalidates every descriptor and in-flight ensure for an in-place rename. */
export function invalidateConversationConnectionTopology(
  runtime: AgentRuntime,
): void {
  invalidateTopology(getRegistry(runtime), null);
}

/** Gives an explicitly created or recreated room a fresh generation token. */
export function prepareConversationConnectionRoom(
  runtime: AgentRuntime,
  roomId: UUID,
): void {
  const registry = getRegistry(runtime);
  registry.blockedRooms.delete(roomId);
  allocateRoomGeneration(registry, roomId);
}

/**
 * Invalidates immediately, drains earlier reconciliation, and blocks new work
 * until deletion completes. Retiring the generation makes every descriptor
 * captured before or during deletion permanently stale without retaining a
 * historical tombstone in memory.
 */
export async function serializeConversationConnectionRoomDeletion(
  runtime: AgentRuntime,
  roomId: UUID,
  deleteRoom: () => Promise<void>,
): Promise<void> {
  const registry = getRegistry(runtime);
  allocateRoomGeneration(registry, roomId);
  registry.blockedRooms.add(roomId);
  let queued: EnqueuedConnectionMutation;
  try {
    queued = enqueueConnectionMutation(
      registry,
      { agentId: runtime.agentId, roomId },
      deleteRoom,
      () => undefined,
    );
  } catch (error) {
    registry.blockedRooms.delete(roomId);
    registry.roomGenerations.delete(roomId);
    throw error;
  }

  const releaseRoom = (): void => {
    registry.blockedRooms.delete(roomId);
    registry.roomGenerations.delete(roomId);
  };
  queued.raw.then(releaseRoom, releaseRoom);
  await queued.result;
}

/**
 * Rejects a turn when its runtime, topology, or room generation changed after
 * capture, including deletion and in-place character rename.
 */
export function assertConversationConnectionRuntime(
  currentRuntime: AgentRuntime | null,
  descriptor: ConversationConnectionDescriptor,
): void {
  if (currentRuntime !== descriptor.runtime) {
    throw new ElizaError("Conversation runtime changed during the turn", {
      code: "CONVERSATION_RUNTIME_CHANGED",
      context: {
        expectedAgentId: descriptor.runtimeAgentId,
        conversationId: descriptor.conversationId,
        roomId: descriptor.roomId,
        currentAgentId: currentRuntime?.agentId,
      },
      severity: "ephemeral",
    });
  }
  assertDescriptorCurrent(getRegistry(descriptor.runtime), descriptor);
}

/** Narrows errors that must terminate the request without a success fallback. */
export function isConversationConnectionError(
  error: unknown,
): error is ElizaError {
  return error instanceof ElizaError && CONNECTION_ERROR_CODES.has(error.code);
}

/**
 * Coordinates web-conversation connection proofs for one running agent.
 *
 * A proof is tied to an immutable runtime/topology/caller descriptor. All
 * mutations are serialized because every web conversation shares one world,
 * while generation may overlap a refresh only after that exact descriptor has
 * completed once. Generation counters keep late completions from reviving
 * proofs invalidated by failure, deletion, or an in-place topology change.
 */
import { type AgentRuntime, ElizaError, type UUID } from "@elizaos/core";
import type { BoundaryWorldRole } from "./boundary-role-resolver.ts";

const MAX_READY_CONNECTION_PROOFS = 2_048;
const MAX_BLOCKED_CONVERSATION_ROOMS = 5_000;

const CONNECTION_ERROR_CODES = new Set([
  "CONVERSATION_CONNECTION_INVALIDATED",
  "CONVERSATION_CONNECTION_REFRESH_FAILED",
  "CONVERSATION_CONNECTION_ROOM_BLOCKED",
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

interface ReadyConnectionProof {
  readonly roomId: UUID;
  readonly ownerId: UUID;
  readonly callerEntityId: UUID;
  readonly callerRole: BoundaryWorldRole;
  readonly callerUserName: string;
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
  readonly roomGenerations: Map<UUID, number>;
  readonly readyProofs: Map<string, ReadyConnectionProof>;
  readonly inFlightEnsures: Map<string, InFlightConnectionEnsure>;
  readonly blockedRooms: Set<UUID>;
  mutationTail: Promise<void>;
}

const registries = new WeakMap<AgentRuntime, ConversationConnectionRegistry>();

function getRegistry(runtime: AgentRuntime): ConversationConnectionRegistry {
  let registry = registries.get(runtime);
  if (!registry) {
    registry = {
      topologyIdentity: null,
      topologyGeneration: 0,
      roomGenerations: new Map(),
      readyProofs: new Map(),
      inFlightEnsures: new Map(),
      blockedRooms: new Set(),
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
  registry.readyProofs.clear();
}

function deleteRoomProofs(
  registry: ConversationConnectionRegistry,
  roomId: UUID,
): void {
  for (const [identity, proof] of registry.readyProofs) {
    if (proof.roomId === roomId) {
      registry.readyProofs.delete(identity);
    }
  }
}

function incrementRoomGeneration(
  registry: ConversationConnectionRegistry,
  roomId: UUID,
): number {
  const nextGeneration = (registry.roomGenerations.get(roomId) ?? 0) + 1;
  registry.roomGenerations.set(roomId, nextGeneration);
  deleteRoomProofs(registry, roomId);
  return nextGeneration;
}

function pruneReadyProofs(registry: ConversationConnectionRegistry): void {
  while (registry.readyProofs.size > MAX_READY_CONNECTION_PROOFS) {
    const oldestIdentity = registry.readyProofs.keys().next().value;
    if (typeof oldestIdentity !== "string") return;
    registry.readyProofs.delete(oldestIdentity);
  }
}

function deleteConflictingCallerProofs(
  registry: ConversationConnectionRegistry,
  descriptor: ConversationConnectionDescriptor,
): void {
  for (const [identity, proof] of registry.readyProofs) {
    if (
      proof.ownerId !== descriptor.ownerId ||
      (proof.callerEntityId === descriptor.callerEntityId &&
        (proof.callerRole !== descriptor.callerRole ||
          proof.callerUserName !== descriptor.callerUserName))
    ) {
      registry.readyProofs.delete(identity);
    }
  }
}

function pruneBlockedRooms(registry: ConversationConnectionRegistry): void {
  const candidateCount = registry.blockedRooms.size;
  let inspected = 0;
  while (
    registry.blockedRooms.size > MAX_BLOCKED_CONVERSATION_ROOMS &&
    inspected < candidateCount
  ) {
    const oldestRoomId = registry.blockedRooms.values().next().value;
    if (typeof oldestRoomId !== "string") return;
    inspected += 1;
    const hasInFlightEnsure = Array.from(
      registry.inFlightEnsures.values(),
    ).some((entry) => entry.descriptor.roomId === oldestRoomId);
    if (hasInFlightEnsure) {
      registry.blockedRooms.delete(oldestRoomId);
      registry.blockedRooms.add(oldestRoomId);
      continue;
    }
    registry.blockedRooms.delete(oldestRoomId);
    registry.roomGenerations.delete(oldestRoomId);
  }
}

function descriptorGenerationsAreCurrent(
  registry: ConversationConnectionRegistry,
  descriptor: ConversationConnectionDescriptor,
): boolean {
  return (
    registry.topologyIdentity === descriptor.topologyIdentity &&
    registry.topologyGeneration === descriptor.topologyGeneration &&
    (registry.roomGenerations.get(descriptor.roomId) ?? 0) ===
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
  return new ElizaError("Conversation connection proof was invalidated", {
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

function enqueueConnectionMutation(
  registry: ConversationConnectionRegistry,
  mutation: () => Promise<void>,
): Promise<void> {
  const run = registry.mutationTail.then(mutation, mutation);
  registry.mutationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
    roomGeneration: registry.roomGenerations.get(input.roomId) ?? 0,
  });
}

/** Returns true only for the exact current descriptor and refreshes its LRU. */
export function hasReadyConversationConnection(
  descriptor: ConversationConnectionDescriptor,
): boolean {
  const registry = getRegistry(descriptor.runtime);
  if (!descriptorIsCurrent(registry, descriptor)) return false;
  const proof = registry.readyProofs.get(descriptor.proofIdentity);
  if (
    !proof ||
    proof.topologyGeneration !== descriptor.topologyGeneration ||
    proof.roomGeneration !== descriptor.roomGeneration
  ) {
    return false;
  }
  registry.readyProofs.delete(descriptor.proofIdentity);
  registry.readyProofs.set(descriptor.proofIdentity, proof);
  return true;
}

/**
 * Coalesces identical work and serializes all web-world mutations for the
 * runtime. A failed mutation clears every proof for that topology because the
 * shared world may have been only partially reconciled.
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

  const run = enqueueConnectionMutation(registry, async () => {
    assertDescriptorCurrent(registry, descriptor);
    try {
      await ensure();
      assertDescriptorCurrent(registry, descriptor);
      deleteConflictingCallerProofs(registry, descriptor);
      registry.readyProofs.delete(descriptor.proofIdentity);
      registry.readyProofs.set(descriptor.proofIdentity, {
        roomId: descriptor.roomId,
        ownerId: descriptor.ownerId,
        callerEntityId: descriptor.callerEntityId,
        callerRole: descriptor.callerRole,
        callerUserName: descriptor.callerUserName,
        topologyGeneration: descriptor.topologyGeneration,
        roomGeneration: descriptor.roomGeneration,
      });
      pruneReadyProofs(registry);
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
        `Conversation connection refresh failed: ${reason}`,
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
  });

  let tracked: Promise<void>;
  tracked = run.finally(() => {
    if (
      registry.inFlightEnsures.get(descriptor.proofIdentity)?.promise ===
      tracked
    ) {
      registry.inFlightEnsures.delete(descriptor.proofIdentity);
    }
  });
  registry.inFlightEnsures.set(descriptor.proofIdentity, {
    descriptor,
    promise: tracked,
  });
  // error-policy:J5 stream routes join this guarded rejection before emitting
  // their terminal frame; serial route callers await the returned promise.
  tracked.catch(() => {});
  return tracked;
}

/** Invalidates every proof and in-flight generation for an in-place rename. */
export function invalidateConversationConnectionTopology(
  runtime: AgentRuntime,
): void {
  invalidateTopology(getRegistry(runtime), null);
}

/**
 * Unblocks an explicitly recreated room and gives it a new generation. Normal
 * stream requests cannot clear a deletion block.
 */
export function prepareConversationConnectionRoom(
  runtime: AgentRuntime,
  roomId: UUID,
): void {
  const registry = getRegistry(runtime);
  registry.blockedRooms.delete(roomId);
  incrementRoomGeneration(registry, roomId);
}

/**
 * Invalidates immediately, then performs deletion after all earlier connection
 * mutations. A late ensure therefore fails its generation check before the
 * serialized delete removes the room.
 */
export async function serializeConversationConnectionRoomDeletion(
  runtime: AgentRuntime,
  roomId: UUID,
  deleteRoom: () => Promise<void>,
): Promise<void> {
  const registry = getRegistry(runtime);
  incrementRoomGeneration(registry, roomId);
  registry.blockedRooms.delete(roomId);
  registry.blockedRooms.add(roomId);
  pruneBlockedRooms(registry);
  await enqueueConnectionMutation(registry, deleteRoom);
}

/** Rejects a turn whose runtime was replaced while its work was in flight. */
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
}

/** Narrows errors that must terminate the stream without a success fallback. */
export function isConversationConnectionError(
  error: unknown,
): error is ElizaError {
  return error instanceof ElizaError && CONNECTION_ERROR_CODES.has(error.code);
}

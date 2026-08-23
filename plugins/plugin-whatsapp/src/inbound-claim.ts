/**
 * Owns durable WhatsApp inbound delivery leases in the runtime document store.
 *
 * A deterministic claim document is distinct from the inbound message row. New
 * claims use the memory store's unique insert; reclaim and terminal transitions
 * use the adapter's document compare-and-swap contract, whose SQL implementation
 * locks the row and checks its revision in the same transaction. A random lease
 * token fences every owner without relying on wall-clock uniqueness.
 */

import { randomUUID } from "node:crypto";
import {
  ChannelType,
  createUniqueUuid,
  ElizaError,
  type IAgentRuntime,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type UUID,
} from "@elizaos/core";

export type InboundClaimStage = "processing" | "processed" | "failed" | "abandoned";

export interface InboundClaimState {
  stage: InboundClaimStage;
  /** Collision-resistant ownership token checked together with revision. */
  generation: UUID;
  /** Document CAS revision owned by this generation. */
  revision: number;
  accountId: string;
  chatId: string;
  externalMessageId: string;
  claimedAt: number;
  updatedAt: number;
  error?: string;
}

export const WHATSAPP_INBOUND_CLAIM_TABLE = "documents";
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const CLAIM_SOURCE = "whatsapp-inbound-claim";
const namespacePromises = new WeakMap<IAgentRuntime, Promise<void>>();

function claimWorldId(runtime: IAgentRuntime): UUID {
  return createUniqueUuid(runtime, "whatsapp:inbound-claims:world") as UUID;
}

function claimRoomId(runtime: IAgentRuntime): UUID {
  return createUniqueUuid(runtime, "whatsapp:inbound-claims:room") as UUID;
}

async function ensureClaimNamespace(runtime: IAgentRuntime): Promise<void> {
  const existing = namespacePromises.get(runtime);
  if (existing) return existing;

  const setup = (async () => {
    const worldId = claimWorldId(runtime);
    try {
      await runtime.ensureWorldExists({
        id: worldId,
        name: "WhatsApp inbound claims",
        agentId: runtime.agentId,
      });
    } catch (error) {
      // error-policy:J1 A cross-host duplicate-key race is translated into
      // success only after the durable adapter confirms the expected world.
      const [persisted] = await runtime.adapter.getWorldsByIds([worldId]);
      if (!persisted) throw error;
    }

    const roomId = claimRoomId(runtime);
    try {
      await runtime.ensureRoomExists({
        id: roomId,
        name: "WhatsApp inbound claims",
        source: CLAIM_SOURCE,
        type: ChannelType.API,
        channelId: `whatsapp-inbound-claims-${runtime.agentId}`,
        worldId,
      });
    } catch (error) {
      // error-policy:J1 Apply the same verified duplicate-key translation to
      // the shared claim room; all other persistence failures still escape.
      const [persisted] = await runtime.adapter.getRoomsByIds([roomId]);
      if (!persisted || persisted.worldId !== worldId) throw error;
    }
  })();
  namespacePromises.set(runtime, setup);
  return setup;
}

export function createInboundClaimId(
  runtime: IAgentRuntime,
  accountId: string,
  chatId: string,
  externalMessageId: string
): UUID {
  return createUniqueUuid(
    runtime,
    `whatsapp:inbound-claim:${accountId}:${chatId}:${externalMessageId}`
  ) as UUID;
}

function parseClaim(memory: Memory | null): InboundClaimState | null {
  if (memory?.metadata?.type !== MemoryType.DOCUMENT) return null;
  const raw = (memory.metadata as Record<string, unknown>).whatsappClaim;
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<InboundClaimState>;
  if (
    !["processing", "processed", "failed", "abandoned"].includes(String(state.stage)) ||
    typeof state.generation !== "string" ||
    !Number.isSafeInteger(state.revision) ||
    typeof state.accountId !== "string" ||
    typeof state.chatId !== "string" ||
    typeof state.externalMessageId !== "string" ||
    typeof state.claimedAt !== "number" ||
    typeof state.updatedAt !== "number"
  ) {
    return null;
  }
  return state as InboundClaimState;
}

function buildClaimMetadata(state: InboundClaimState): MemoryMetadata {
  return {
    type: MemoryType.DOCUMENT,
    scope: "agent-private",
    source: CLAIM_SOURCE,
    timestamp: state.claimedAt,
    documentRevision: state.revision,
    whatsappClaim: state,
  } as unknown as MemoryMetadata;
}

function buildClaimMemory(
  claimId: UUID,
  state: InboundClaimState,
  runtime: IAgentRuntime,
  createdAt = state.claimedAt
): Memory {
  return {
    id: claimId,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: claimRoomId(runtime),
    worldId: claimWorldId(runtime),
    content: { text: "WhatsApp inbound delivery claim" },
    metadata: buildClaimMetadata(state),
    createdAt,
    unique: true,
  };
}

function requester(runtime: IAgentRuntime) {
  return {
    agentId: runtime.agentId,
    requesterEntityId: runtime.agentId,
    requesterRoomIds: [claimRoomId(runtime)],
    requesterRole: "RUNTIME" as const,
  };
}

async function readClaimDocument(runtime: IAgentRuntime, claimId: UUID): Promise<Memory | null> {
  return runtime.adapter.getDocument({
    ...requester(runtime),
    documentId: claimId,
  });
}

function assertClaimStorage(runtime: IAgentRuntime): void {
  const adapter = runtime.adapter;
  if (
    !Number.isInteger(adapter?.documentListQueryCapability) ||
    adapter.documentListQueryCapability < 2 ||
    typeof adapter.getDocument !== "function" ||
    typeof adapter.compareAndSwapDocument !== "function" ||
    typeof runtime.createMemory !== "function"
  ) {
    throw new ElizaError("WhatsApp idempotency storage is unavailable", {
      code: "WHATSAPP_IDEMPOTENCY_STORAGE_UNAVAILABLE",
      context: { agentId: runtime.agentId },
    });
  }
}

export function isStaleProcessing(state: InboundClaimState, now = Date.now()): boolean {
  return state.stage === "processing" && now - state.updatedAt > STALE_PROCESSING_MS;
}

export interface ClaimResult {
  won: boolean;
  state: InboundClaimState | null;
}

function freshProcessingState(
  accountId: string,
  chatId: string,
  externalMessageId: string,
  revision: number,
  now: number
): InboundClaimState {
  return {
    stage: "processing",
    generation: randomUUID() as UUID,
    revision,
    accountId,
    chatId,
    externalMessageId,
    claimedAt: now,
    updatedAt: now,
  };
}

export async function tryClaim(
  runtime: IAgentRuntime,
  claimId: UUID,
  accountId: string,
  chatId: string,
  externalMessageId: string
): Promise<ClaimResult> {
  assertClaimStorage(runtime);
  await ensureClaimNamespace(runtime);
  const now = Date.now();
  let document = await readClaimDocument(runtime, claimId);

  if (!document) {
    const proposed = freshProcessingState(accountId, chatId, externalMessageId, 0, now);
    await runtime.createMemory(
      buildClaimMemory(claimId, proposed, runtime),
      WHATSAPP_INBOUND_CLAIM_TABLE,
      true
    );
    document = await readClaimDocument(runtime, claimId);
    const persisted = parseClaim(document);
    if (!persisted) {
      throw new ElizaError("WhatsApp claim insert produced no readable claim", {
        code: "WHATSAPP_INBOUND_CLAIM_INVALID",
        context: { accountId, chatId, externalMessageId, claimId },
      });
    }
    return {
      won: persisted.generation === proposed.generation,
      state: persisted,
    };
  }

  const existing = parseClaim(document);
  if (!existing) {
    throw new ElizaError("WhatsApp claim row has invalid metadata", {
      code: "WHATSAPP_INBOUND_CLAIM_INVALID",
      context: { accountId, chatId, externalMessageId, claimId },
    });
  }
  if (existing.stage === "processed") return { won: false, state: existing };
  if (existing.stage === "processing" && !isStaleProcessing(existing, now)) {
    return { won: false, state: existing };
  }

  const replacement = freshProcessingState(
    accountId,
    chatId,
    externalMessageId,
    existing.revision + 1,
    now
  );
  const result = await runtime.adapter.compareAndSwapDocument({
    ...requester(runtime),
    documentId: claimId,
    expected: {
      scope: "agent-private",
      roomId: claimRoomId(runtime),
      entityId: runtime.agentId,
      revision: existing.revision,
    },
    replacement: buildClaimMemory(claimId, replacement, runtime, document.createdAt),
  });
  if (result.status === "updated") return { won: true, state: replacement };

  const current = parseClaim(await readClaimDocument(runtime, claimId));
  return { won: false, state: current };
}

async function transitionClaim(
  runtime: IAgentRuntime,
  claimId: UUID,
  expected: InboundClaimState,
  stage: "processed" | "failed" | "abandoned",
  error?: string
): Promise<void> {
  assertClaimStorage(runtime);
  const document = await readClaimDocument(runtime, claimId);
  const current = parseClaim(document);
  if (
    !document ||
    !current ||
    current.generation !== expected.generation ||
    current.revision !== expected.revision
  ) {
    throw new ElizaError("WhatsApp inbound claim ownership was lost", {
      code: "WHATSAPP_INBOUND_CLAIM_CONFLICT",
      context: { claimId, expectedGeneration: expected.generation, stage },
    });
  }

  const next: InboundClaimState = {
    ...expected,
    stage,
    revision: expected.revision + 1,
    updatedAt: Date.now(),
    ...(error ? { error } : { error: undefined }),
  };
  const result = await runtime.adapter.compareAndSwapDocument({
    ...requester(runtime),
    documentId: claimId,
    expected: {
      scope: "agent-private",
      roomId: claimRoomId(runtime),
      entityId: runtime.agentId,
      revision: expected.revision,
    },
    replacement: buildClaimMemory(claimId, next, runtime, document.createdAt),
  });
  if (result.status !== "updated") {
    throw new ElizaError("WhatsApp inbound claim transition lost its CAS", {
      code: "WHATSAPP_INBOUND_CLAIM_CONFLICT",
      context: {
        claimId,
        expectedGeneration: expected.generation,
        stage,
        status: result.status,
      },
    });
  }
}

export async function completeClaim(
  runtime: IAgentRuntime,
  claimId: UUID,
  expected: InboundClaimState
): Promise<void> {
  await transitionClaim(runtime, claimId, expected, "processed");
}

export async function failClaim(
  runtime: IAgentRuntime,
  claimId: UUID,
  expected: InboundClaimState,
  error: string
): Promise<void> {
  await transitionClaim(runtime, claimId, expected, "failed", error);
}

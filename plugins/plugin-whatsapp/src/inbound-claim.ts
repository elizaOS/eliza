/**
 * Durable staged inbound delivery claims for the WhatsApp connector.
 *
 * Meta redelivers a webhook when it does not see a 200 quickly enough, and a
 * single webhook batch can repeat a message id. The deterministic UUID
 * derived from `(accountId, externalMessageId)` keys a claim row in the
 * runtime's memory store. The claim transitions through a staged lifecycle —
 * `processing → processed / failed` with `abandoned` for crashed hosts — so a
 * second host or a process restart converges instead of duplicating side
 * effects (ensureConnection, room creation, model turn, auto-reply).
 *
 * Generation fencing: each claim carries a monotonic generation counter
 * (wall-clock claimedAt). A stale `processing` claim (host died mid-turn) is
 * fenced to a new generation only after the staleness threshold elapses.
 * Completion and failure transitions check the expected generation before
 * writing, so a zombie host that wakes up after its successor has taken over
 * cannot overwrite the successor's terminal state.
 *
 * Best-effort note: the runtime memory API does not expose conditional
 * (CAS) updates, so the read-then-write in `fenceStaleClaim` and
 * `transitionClaim` has a narrow TOCTOU window. The in-process Set guard in
 * `WhatsAppConnectorService` closes the common concurrent-redelivery path;
 * the durable claim closes restart and multi-host paths. SQL adapters apply
 * `ON CONFLICT DO NOTHING` on `createMemory(unique=true)`, so two hosts
 * racing to insert the same claim id results in exactly one persisted row —
 * the loser reads back the winner's generation and yields.
 */

import { hostname } from "node:os";
import type { IAgentRuntime, Memory, MemoryMetadata, UUID } from "@elizaos/core";

/** Staged lifecycle of a durable inbound claim. */
export type InboundClaimStage = "processing" | "processed" | "failed" | "abandoned";

/** Metadata persisted alongside the claim memory row. */
export interface InboundClaimState {
  stage: InboundClaimStage;
  /** Monotonic ownership epoch — wall-clock ms at claim time. */
  generation: number;
  /** `hostname:pid` of the host that owns this generation. */
  hostId: string;
  accountId: string;
  externalMessageId: string;
  claimedAt: number;
  updatedAt: number;
  /** Present when `stage === "failed"`. */
  error?: string;
}

/** Memory table used for durable claim rows. */
export const WHATSAPP_INBOUND_CLAIM_TABLE = "whatsapp_inbound_claims";

/**
 * Elapsed time after which a `processing` claim is considered stale (host
 * crashed or was OOM-killed mid-turn). Meta webhooks are expected to complete
 * within 30 s; 5 min gives generous headroom for model latency.
 */
const STALE_PROCESSING_MS = 5 * 60 * 1000;

const CLAIM_METADATA_TYPE = "whatsapp_inbound_claim";

function currentHostId(): string {
  return `${hostname()}:${process.pid}`;
}

/**
 * Extracts the claim state from a memory row's metadata, or `null` if the
 * row is not a claim (e.g. it is the inbound message itself).
 */
function parseClaim(memory: Memory | null): InboundClaimState | null {
  if (!memory?.metadata) return null;
  const raw = (memory.metadata as Record<string, unknown>)?.whatsappClaim;
  if (!raw || typeof raw !== "object") return null;
  return raw as InboundClaimState;
}

function buildClaimMetadata(state: InboundClaimState): MemoryMetadata {
  return {
    type: CLAIM_METADATA_TYPE,
    whatsappClaim: state,
  } as unknown as MemoryMetadata;
}

function buildClaimMemory(claimId: UUID, state: InboundClaimState, runtime: IAgentRuntime): Memory {
  return {
    id: claimId,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: claimId,
    content: { text: "" },
    metadata: buildClaimMetadata(state),
    createdAt: state.claimedAt,
  };
}

/**
 * Determines whether a `processing` claim is stale enough to fence.
 */
export function isStaleProcessing(state: InboundClaimState, now = Date.now()): boolean {
  return state.stage === "processing" && now - state.updatedAt > STALE_PROCESSING_MS;
}

/**
 * Result of attempting to acquire a durable claim.
 */
export interface ClaimResult {
  /** `true` when this host owns the claim and may proceed with side effects. */
  won: boolean;
  /** The current persisted state (null if no store was available). */
  state: InboundClaimState | null;
}

/**
 * Attempts to atomically acquire (or re-acquire after crash) a durable
 * inbound claim. Returns `{ won: true }` when this host should process the
 * message; `{ won: false }` when another host or a prior delivery already
 * completed or is actively processing it.
 *
 * Flow:
 * 1. Read the existing claim (if any).
 * 2. If `processed` — skip (already done).
 * 3. If `processing` and not stale — skip (another host is handling it).
 * 4. If `processing` and stale, or `failed`/`abandoned` — fence/re-claim.
 * 5. If no claim exists — insert a new `processing` claim (ON CONFLICT DO
 *    NOTHING in SQL), then read back to confirm ownership.
 */
export async function tryClaim(
  runtime: IAgentRuntime,
  claimId: UUID,
  accountId: string,
  externalMessageId: string
): Promise<ClaimResult> {
  const hostId = currentHostId();
  const now = Date.now();
  const generation = now;

  if (typeof runtime.getMemoryById !== "function") {
    return { won: true, state: null };
  }

  const existing = await runtime.getMemoryById(claimId);
  const existingClaim = parseClaim(existing);

  if (!existingClaim) {
    // Fresh claim — insert as processing. SQL ON CONFLICT DO NOTHING
    // means a concurrent inserter's row persists; we detect loss by
    // reading back and comparing hostId + generation.
    const state: InboundClaimState = {
      stage: "processing",
      generation,
      hostId,
      accountId,
      externalMessageId,
      claimedAt: now,
      updatedAt: now,
    };
    if (typeof runtime.createMemory === "function") {
      await runtime.createMemory(
        buildClaimMemory(claimId, state, runtime),
        WHATSAPP_INBOUND_CLAIM_TABLE,
        true
      );
    }
    const after = await runtime.getMemoryById(claimId);
    const afterClaim = parseClaim(after);
    if (afterClaim && afterClaim.hostId === hostId && afterClaim.generation === generation) {
      return { won: true, state: afterClaim };
    }
    return { won: false, state: afterClaim };
  }

  // Existing claim present — check stage
  if (existingClaim.stage === "processed") {
    return { won: false, state: existingClaim };
  }

  if (existingClaim.stage === "processing" && !isStaleProcessing(existingClaim, now)) {
    return { won: false, state: existingClaim };
  }

  // Reclaimable: stale processing, failed, or abandoned.
  // Fence the stale owner (if any) and take ownership.
  const newState: InboundClaimState = {
    ...existingClaim,
    stage: "processing",
    generation,
    hostId,
    updatedAt: now,
    error: undefined,
  };
  await runtime.updateMemory({
    id: claimId,
    metadata: buildClaimMetadata(newState),
  });

  return { won: true, state: newState };
}

/**
 * Transitions a claim to `processed`. Checks the expected generation first;
 * if a successor has fenced this claim, the transition is a no-op (the
 * successor's terminal state must not be overwritten by a zombie).
 */
export async function completeClaim(
  runtime: IAgentRuntime,
  claimId: UUID,
  expected: InboundClaimState
): Promise<void> {
  if (typeof runtime.getMemoryById !== "function") return;
  const current = await runtime.getMemoryById(claimId);
  const currentClaim = parseClaim(current);
  if (currentClaim && currentClaim.generation !== expected.generation) {
    // We were fenced — do not overwrite the successor's state.
    return;
  }
  const now = Date.now();
  await runtime.updateMemory({
    id: claimId,
    metadata: buildClaimMetadata({
      ...expected,
      stage: "processed",
      updatedAt: now,
    }),
  });
}

/**
 * Transitions a claim to `failed`. Same generation guard as
 * `completeClaim`.
 */
export async function failClaim(
  runtime: IAgentRuntime,
  claimId: UUID,
  expected: InboundClaimState,
  error: string
): Promise<void> {
  if (typeof runtime.getMemoryById !== "function") return;
  const current = await runtime.getMemoryById(claimId);
  const currentClaim = parseClaim(current);
  if (currentClaim && currentClaim.generation !== expected.generation) {
    return;
  }
  const now = Date.now();
  await runtime.updateMemory({
    id: claimId,
    metadata: buildClaimMetadata({
      ...expected,
      stage: "failed",
      updatedAt: now,
      error,
    }),
  });
}

/**
 * Owner-activation contract: persist exactly one durable assistant activation
 * turn per owner+agent+contract version when onboarding hands the owner to the
 * live conversation.
 *
 * The app's first-run conductor renders synthetic `first_run` turns and then
 * deliberately clears them (see `packages/ui/src/first-run/clear-first-run-transcript.ts`),
 * so without this boundary no durable activation memory exists and the owner
 * lands on an empty thread. This service is the server/runtime-side authority:
 * it is keyed by `owner+agent+contractVersion`, idempotent across retries and
 * restarts (the activation turn uses a DETERMINISTIC memory id derived from
 * that key, so a crash between the durable write and the completion marker
 * reconciles instead of duplicating), and it never marks activation complete
 * unless the conversation memory write succeeded.
 *
 * Eligibility protects established owners: an owner who already has a
 * `primaryGoal` fact, real conversation history in the target room, or a prior
 * contract-version activation is recorded `exempt` and receives no canned
 * greeting (#15149's silent entry is the deliberate first-use exception).
 * Bumping {@link OWNER_ACTIVATION_CONTRACT_VERSION} never re-activates
 * silently — reactivation requires the explicit `reactivate` input.
 */

import {
  ChannelType,
  ElizaError,
  type IAgentRuntime,
  logger,
  type Memory,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { asCacheRuntime } from "../runtime-cache.js";
import { createOwnerFactStore, type OwnerFactStore } from "./state.js";

/**
 * Version of the activation contract. Bumping it does NOT silently re-run
 * activation for owners with a prior-version record; callers must pass
 * `reactivate: true` for an explicit contract-version reactivation.
 */
export const OWNER_ACTIVATION_CONTRACT_VERSION = 1;

const ACTIVATION_CACHE_KEY = "eliza:lifeops:owner-activation:v1";
const ACTIVATION_MESSAGE_SOURCE = "owner_activation";

/**
 * The one durable activation turn. Intentionally goal-forward: the
 * `ftu_goal_discovery` evaluator listens on the turns that follow it and
 * persists the owner's first goal into `OwnerFactStore.primaryGoal`.
 */
export const OWNER_ACTIVATION_MESSAGE =
  "You're all set up. I'm your assistant from here on — before anything else, what's the one thing you most want my help with?";

export type OwnerActivationStatus = "complete" | "exempt";

export type OwnerActivationExemptReason =
  | "existing_primary_goal"
  | "existing_history"
  | "prior_contract_activation";

export interface OwnerActivationEntry {
  status: OwnerActivationStatus;
  ownerEntityId: UUID;
  agentId: UUID;
  contractVersion: number;
  /** ISO-8601 instant the entry was recorded. */
  recordedAt: string;
  /** Durable conversation-memory id of the activation turn (status=complete). */
  memoryId?: UUID;
  /** Room the activation turn was written into (status=complete). */
  roomId?: UUID;
  /** Why activation was skipped (status=exempt). */
  exemptReason?: OwnerActivationExemptReason;
}

interface OwnerActivationRecord {
  entries: Record<string, OwnerActivationEntry>;
}

export interface EnsureActivationInput {
  ownerEntityId: UUID;
  /** Conversation room the owner lands in after onboarding. */
  roomId: UUID;
  /**
   * Explicit opt-in to re-activate after a contract-version bump. Without it,
   * a prior-version activation entry makes the current version `exempt`.
   */
  reactivate?: boolean;
}

export interface EnsureActivationResult {
  /** `activated` = the durable turn was written by THIS call. */
  outcome: "activated" | "already_complete" | "exempt";
  entry: OwnerActivationEntry;
}

function activationKey(
  ownerEntityId: UUID,
  agentId: UUID,
  contractVersion: number,
): string {
  return `${ownerEntityId}:${agentId}:v${contractVersion}`;
}

/** Deterministic activation-turn memory id — the storage-level exactly-once key. */
export function activationMemoryId(
  ownerEntityId: UUID,
  agentId: UUID,
  contractVersion: number,
): UUID {
  return stringToUuid(
    `owner-activation:${activationKey(ownerEntityId, agentId, contractVersion)}`,
  );
}

function isEntry(value: unknown): value is OwnerActivationEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    (v.status === "complete" || v.status === "exempt") &&
    typeof v.ownerEntityId === "string" &&
    typeof v.agentId === "string" &&
    typeof v.contractVersion === "number" &&
    typeof v.recordedAt === "string"
  );
}

function normalizeRecord(value: unknown): OwnerActivationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { entries: {} };
  }
  const entriesRaw = (value as Record<string, unknown>).entries;
  if (!entriesRaw || typeof entriesRaw !== "object") {
    return { entries: {} };
  }
  const entries: Record<string, OwnerActivationEntry> = {};
  for (const [key, entry] of Object.entries(
    entriesRaw as Record<string, unknown>,
  )) {
    if (isEntry(entry)) entries[key] = entry;
  }
  return { entries };
}

export class OwnerActivationService {
  private readonly factStore: OwnerFactStore;
  /** Per-key in-flight dedup so concurrent calls in one process share a write. */
  private readonly inFlight = new Map<
    string,
    Promise<EnsureActivationResult>
  >();

  constructor(
    private readonly runtime: IAgentRuntime,
    options?: { factStore?: OwnerFactStore },
  ) {
    this.factStore = options?.factStore ?? createOwnerFactStore(runtime);
  }

  async readEntry(ownerEntityId: UUID): Promise<OwnerActivationEntry | null> {
    const record = await this.readRecord();
    const key = activationKey(
      ownerEntityId,
      this.runtime.agentId,
      OWNER_ACTIVATION_CONTRACT_VERSION,
    );
    return record.entries[key] ?? null;
  }

  /**
   * Idempotently ensure the owner's activation state for the current contract
   * version. Throws (without marking complete) when the durable conversation
   * write fails, so callers retry observably.
   */
  async ensureActivated(
    input: EnsureActivationInput,
  ): Promise<EnsureActivationResult> {
    const key = activationKey(
      input.ownerEntityId,
      this.runtime.agentId,
      OWNER_ACTIVATION_CONTRACT_VERSION,
    );
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = this.ensureActivatedUncached(key, input).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async ensureActivatedUncached(
    key: string,
    input: EnsureActivationInput,
  ): Promise<EnsureActivationResult> {
    const record = await this.readRecord();
    const existing = record.entries[key];
    if (existing) {
      return {
        outcome: existing.status === "exempt" ? "exempt" : "already_complete",
        entry: existing,
      };
    }

    const memoryId = activationMemoryId(
      input.ownerEntityId,
      this.runtime.agentId,
      OWNER_ACTIVATION_CONTRACT_VERSION,
    );

    // Crash reconciliation: the durable turn may exist even though the marker
    // write was lost. Marking complete without a second write keeps the turn
    // exactly-once across restarts.
    const persisted = await this.runtime.getMemoryById(memoryId);
    if (persisted) {
      return {
        outcome: "already_complete",
        entry: await this.writeEntry(record, key, {
          status: "complete",
          ownerEntityId: input.ownerEntityId,
          agentId: this.runtime.agentId,
          contractVersion: OWNER_ACTIVATION_CONTRACT_VERSION,
          recordedAt: new Date().toISOString(),
          memoryId,
          roomId: persisted.roomId,
        }),
      };
    }

    const exemptReason = await this.resolveExemptReason(record, input);
    if (exemptReason) {
      return {
        outcome: "exempt",
        entry: await this.writeEntry(record, key, {
          status: "exempt",
          ownerEntityId: input.ownerEntityId,
          agentId: this.runtime.agentId,
          contractVersion: OWNER_ACTIVATION_CONTRACT_VERSION,
          recordedAt: new Date().toISOString(),
          exemptReason,
        }),
      };
    }

    await this.persistActivationTurn(memoryId, input);
    const entry = await this.writeEntry(record, key, {
      status: "complete",
      ownerEntityId: input.ownerEntityId,
      agentId: this.runtime.agentId,
      contractVersion: OWNER_ACTIVATION_CONTRACT_VERSION,
      recordedAt: new Date().toISOString(),
      memoryId,
      roomId: input.roomId,
    });
    logger.info(
      {
        src: "lifeops:owner-activation",
        agentId: this.runtime.agentId,
        ownerEntityId: input.ownerEntityId,
        roomId: input.roomId,
        memoryId,
      },
      "[OwnerActivationService] Persisted the owner activation turn.",
    );
    return { outcome: "activated", entry };
  }

  private async resolveExemptReason(
    record: OwnerActivationRecord,
    input: EnsureActivationInput,
  ): Promise<OwnerActivationExemptReason | null> {
    if (!input.reactivate) {
      const priorVersion = Object.values(record.entries).some(
        (entry) =>
          entry.ownerEntityId === input.ownerEntityId &&
          entry.agentId === this.runtime.agentId &&
          entry.contractVersion < OWNER_ACTIVATION_CONTRACT_VERSION,
      );
      if (priorVersion) return "prior_contract_activation";
    }
    const facts = await this.factStore.read();
    if (facts.primaryGoal?.value) return "existing_primary_goal";

    const history = await this.runtime.getMemories({
      roomId: input.roomId,
      tableName: "messages",
      count: 3,
    });
    const realTurns = history.filter(
      (memory) => memory.content?.source !== ACTIVATION_MESSAGE_SOURCE,
    );
    if (realTurns.length > 0) return "existing_history";
    return null;
  }

  private async persistActivationTurn(
    memoryId: UUID,
    input: EnsureActivationInput,
  ): Promise<void> {
    try {
      await this.runtime.ensureRoomExists({
        id: input.roomId,
        agentId: this.runtime.agentId,
        source: ACTIVATION_MESSAGE_SOURCE,
        type: ChannelType.DM,
      });
      const memory: Memory = {
        id: memoryId,
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: input.roomId,
        content: {
          text: OWNER_ACTIVATION_MESSAGE,
          source: ACTIVATION_MESSAGE_SOURCE,
        },
        metadata: {
          type: MemoryType.MESSAGE,
          source: ACTIVATION_MESSAGE_SOURCE,
        },
        createdAt: Date.now(),
      };
      await this.runtime.createMemory(memory, "messages");
    } catch (cause) {
      // error-policy:J2 wrap the failed durable write with the activation key
      // so the boundary can retry; activation is NEVER marked complete here.
      throw new ElizaError(
        "OwnerActivationService: durable activation-turn write failed; activation left incomplete for retry",
        {
          code: "OWNER_ACTIVATION_WRITE_FAILED",
          cause: cause instanceof Error ? cause : new Error(String(cause)),
          context: {
            ownerEntityId: input.ownerEntityId,
            roomId: input.roomId,
            memoryId,
          },
        },
      );
    }
  }

  private async readRecord(): Promise<OwnerActivationRecord> {
    const cache = asCacheRuntime(this.runtime);
    return normalizeRecord(await cache.getCache(ACTIVATION_CACHE_KEY));
  }

  private async writeEntry(
    record: OwnerActivationRecord,
    key: string,
    entry: OwnerActivationEntry,
  ): Promise<OwnerActivationEntry> {
    const next: OwnerActivationRecord = {
      entries: { ...record.entries, [key]: entry },
    };
    await asCacheRuntime(this.runtime).setCache(ACTIVATION_CACHE_KEY, next);
    return entry;
  }
}

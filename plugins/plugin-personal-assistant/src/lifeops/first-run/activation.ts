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
import {
  createFirstRunStateStore,
  createOwnerFactStore,
  type FirstRunStateStore,
  type OwnerFactStore,
} from "./state.js";

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
  "You’re signed in — I’m ready. What would you like to work on first? If you’ve got a problem you want to solve, tell me what’s going on.";

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
  private readonly firstRunStore: FirstRunStateStore;
  /** Per-key in-flight dedup so concurrent calls in one process share a write. */
  private readonly inFlight = new Map<
    string,
    Promise<EnsureActivationResult>
  >();
  /** Serializes read-modify-write updates to the shared activation record. */
  private recordWriteTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: IAgentRuntime,
    options?: {
      factStore?: OwnerFactStore;
      firstRunStore?: FirstRunStateStore;
    },
  ) {
    this.factStore = options?.factStore ?? createOwnerFactStore(runtime);
    this.firstRunStore =
      options?.firstRunStore ?? createFirstRunStateStore(runtime);
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
      await this.reconcileFirstRunComplete();
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
      if (
        persisted.agentId !== this.runtime.agentId ||
        persisted.entityId !== this.runtime.agentId ||
        persisted.content?.source !== ACTIVATION_MESSAGE_SOURCE
      ) {
        throw new ElizaError(
          "OwnerActivationService: deterministic activation memory id is occupied by another record",
          {
            code: "OWNER_ACTIVATION_MEMORY_COLLISION",
            context: { memoryId, ownerEntityId: input.ownerEntityId },
          },
        );
      }
      const entry = await this.writeEntry(key, {
        status: "complete",
        ownerEntityId: input.ownerEntityId,
        agentId: this.runtime.agentId,
        contractVersion: OWNER_ACTIVATION_CONTRACT_VERSION,
        recordedAt: new Date().toISOString(),
        memoryId,
        roomId: persisted.roomId,
      });
      await this.reconcileFirstRunComplete();
      return {
        outcome: "already_complete",
        entry,
      };
    }

    await this.assertPrivateOwnerRoom(input);

    const exemptReason = await this.resolveExemptReason(record, input);
    if (exemptReason) {
      const entry = await this.writeEntry(key, {
        status: "exempt",
        ownerEntityId: input.ownerEntityId,
        agentId: this.runtime.agentId,
        contractVersion: OWNER_ACTIVATION_CONTRACT_VERSION,
        recordedAt: new Date().toISOString(),
        exemptReason,
      });
      await this.reconcileFirstRunComplete();
      return {
        outcome: "exempt",
        entry,
      };
    }

    const created = await this.persistActivationTurn(memoryId, input);
    const entry = await this.writeEntry(key, {
      status: "complete",
      ownerEntityId: input.ownerEntityId,
      agentId: this.runtime.agentId,
      contractVersion: OWNER_ACTIVATION_CONTRACT_VERSION,
      recordedAt: new Date().toISOString(),
      memoryId,
      roomId: input.roomId,
    });
    await this.reconcileFirstRunComplete();
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
    return { outcome: created ? "activated" : "already_complete", entry };
  }

  private async assertPrivateOwnerRoom(
    input: EnsureActivationInput,
  ): Promise<void> {
    const [room, participants] = await Promise.all([
      this.runtime.getRoom(input.roomId),
      this.runtime.getParticipantsForRoom(input.roomId),
    ]);
    const participantSet = new Set(participants);
    const privateOwnerRoom =
      room?.type === ChannelType.DM &&
      (room.agentId === undefined || room.agentId === this.runtime.agentId) &&
      participantSet.has(input.ownerEntityId) &&
      participantSet.has(this.runtime.agentId) &&
      [...participantSet].every(
        (entityId) =>
          entityId === input.ownerEntityId || entityId === this.runtime.agentId,
      );
    if (privateOwnerRoom) return;
    throw new ElizaError(
      "OwnerActivationService: activation requires the selected agent's private owner room",
      {
        code: "OWNER_ACTIVATION_PRIVATE_ROOM_REQUIRED",
        context: {
          ownerEntityId: input.ownerEntityId,
          agentId: this.runtime.agentId,
          roomId: input.roomId,
          roomType: room?.type ?? null,
          participantCount: participants.length,
        },
      },
    );
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

    const ownerRooms = await this.runtime.getRoomsForParticipant(
      input.ownerEntityId,
    );
    for (const roomId of ownerRooms) {
      const history = await this.runtime.getMemories({
        entityId: input.ownerEntityId,
        roomId,
        tableName: "messages",
        count: 1,
      });
      if (history.length > 0) return "existing_history";
    }
    return null;
  }

  private async persistActivationTurn(
    memoryId: UUID,
    input: EnsureActivationInput,
  ): Promise<boolean> {
    try {
      const memory: Memory = {
        id: memoryId,
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: input.roomId,
        content: {
          text: OWNER_ACTIVATION_MESSAGE,
          source: ACTIVATION_MESSAGE_SOURCE,
          channelType: ChannelType.DM,
        },
        metadata: {
          type: MemoryType.MESSAGE,
          source: ACTIVATION_MESSAGE_SOURCE,
          scope: "owner-private",
          scopedToEntityId: input.ownerEntityId,
        },
        createdAt: Date.now(),
      };
      await this.runtime.createMemory(memory, "messages");
      return true;
    } catch (cause) {
      // A second process can win the deterministic-id insert. Re-read before
      // classifying the error: the durable row is the exactly-once anchor.
      const persisted = await this.runtime.getMemoryById(memoryId);
      if (
        persisted?.agentId === this.runtime.agentId &&
        persisted.entityId === this.runtime.agentId &&
        persisted.content?.source === ACTIVATION_MESSAGE_SOURCE
      ) {
        return false;
      }
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

  private async reconcileFirstRunComplete(): Promise<void> {
    const firstRun = await this.firstRunStore.read();
    if (firstRun.status !== "complete") {
      await this.firstRunStore.complete();
    }
  }

  private async readRecord(): Promise<OwnerActivationRecord> {
    const cache = asCacheRuntime(this.runtime);
    return normalizeRecord(await cache.getCache(ACTIVATION_CACHE_KEY));
  }

  private async writeEntry(
    key: string,
    entry: OwnerActivationEntry,
  ): Promise<OwnerActivationEntry> {
    const write = this.recordWriteTail.then(async () => {
      const current = await this.readRecord();
      const next: OwnerActivationRecord = {
        entries: { ...current.entries, [key]: entry },
      };
      await asCacheRuntime(this.runtime).setCache(ACTIVATION_CACHE_KEY, next);
      return entry;
    });
    this.recordWriteTail = write.then(
      () => undefined,
      () => undefined,
    );
    return await write;
  }
}

const ownerActivationServices = new WeakMap<
  IAgentRuntime,
  OwnerActivationService
>();

/** Runtime-scoped service so concurrent HTTP callbacks share one write lock. */
export function getOwnerActivationService(
  runtime: IAgentRuntime,
): OwnerActivationService {
  const existing = ownerActivationServices.get(runtime);
  if (existing) return existing;
  const service = new OwnerActivationService(runtime);
  ownerActivationServices.set(runtime, service);
  return service;
}

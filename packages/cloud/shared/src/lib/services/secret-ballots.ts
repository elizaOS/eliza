/**
 * SecretBallotsService (Wave G).
 *
 * Atomic primitives for "agent collects N secret votes, reveals only if M
 * reached". The service issues a per-participant scoped token (32 random
 * bytes; sha256-hashed at rest), gates vote submission on that token,
 * records votes idempotently, and tallies once the threshold is met.
 *
 * v1 plaintext: `value_ciphertext` is base64-encoded plaintext. The server
 * decodes and counts. Wave H+ swaps this for Shamir-shared shares in the
 * same column without a schema migration.
 */

import type {
  RecordVoteOutcome,
  SecretBallotRow,
  SecretBallotsRepository,
} from "../../db/repositories/secret-ballots";
import type {
  SecretBallotParticipant,
  SecretBallotTallyResult,
} from "../../db/schemas/secret-ballots";
import { logger } from "../utils/logger";

export type {
  SecretBallotEventName,
  SecretBallotParticipant,
  SecretBallotRow,
  SecretBallotStatus,
  SecretBallotTallyResult,
} from "../../db/repositories/secret-ballots";

const DEFAULT_EXPIRES_IN_MS = 24 * 60 * 60 * 1000; // 24 hours
const TOKEN_BYTES = 32;

export interface SecretBallotParticipantToken {
  identityId: string;
  scopedToken: string;
}

export interface CreateSecretBallotInput {
  organizationId: string;
  agentId?: string | null;
  purpose: string;
  participants: SecretBallotParticipant[];
  threshold: number;
  expiresInMs?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateSecretBallotResult {
  ballot: SecretBallotRow;
  ballotId: string;
  expiresAt: Date;
  participantTokens: SecretBallotParticipantToken[];
}

export type SecretBallotDistributionTarget = "dm";

export interface DistributeSecretBallotInput {
  ballotId: string;
  target: SecretBallotDistributionTarget;
}

export interface SecretBallotDistributionResult {
  ballotId: string;
  target: SecretBallotDistributionTarget;
  dispatched: number;
}

export interface SubmitVoteInput {
  ballotId: string;
  scopedToken: string;
  /** Plaintext value chosen by the participant (v1). */
  value: string;
}

export type SubmitVoteResult =
  | { ok: true; outcome: "recorded" | "replay_same_value"; ballotStatus: SecretBallotRow["status"] }
  | {
      ok: false;
      reason:
        | "ballot_not_found"
        | "ballot_not_open"
        | "unknown_token"
        | "conflict_different_value"
        | "ballot_expired";
    };

export interface TallyResult {
  tallied: boolean;
  ballot: SecretBallotRow;
  result: SecretBallotTallyResult | null;
}

export interface SensitiveRequestDispatcher {
  /**
   * Dispatch a per-participant sensitive request for a ballot. Implementations
   * resolve the participant's DM channel and deliver `scopedToken` privately.
   *
   * Wave G provides the contract only; implementations are wired by deployment
   * code in subsequent waves.
   */
  dispatchBallotInvite(input: {
    ballotId: string;
    organizationId: string;
    agentId: string | null;
    purpose: string;
    participant: SecretBallotParticipant;
    scopedToken: string;
    expiresAt: Date;
  }): Promise<{ delivered: boolean; error?: string }>;
}

export interface SecretBallotsService {
  create(input: CreateSecretBallotInput): Promise<CreateSecretBallotResult>;
  get(id: string, organizationId: string): Promise<SecretBallotRow | null>;
  list(
    organizationId: string,
    filter?: {
      status?: SecretBallotRow["status"];
      agentId?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<SecretBallotRow[]>;
  distribute(input: DistributeSecretBallotInput): Promise<SecretBallotDistributionResult>;
  submitVote(input: SubmitVoteInput): Promise<SubmitVoteResult>;
  tallyIfThresholdMet(input: { ballotId: string }): Promise<TallyResult>;
  expireBallot(input: { ballotId: string; organizationId: string }): Promise<SecretBallotRow>;
  cancel(input: {
    ballotId: string;
    organizationId: string;
    reason?: string;
  }): Promise<SecretBallotRow>;
  expirePast(now?: Date): Promise<string[]>;
}

export interface SecretBallotsServiceDeps {
  repository: SecretBallotsRepository;
  dispatcher?: SensitiveRequestDispatcher;
  generateToken?: () => string | Promise<string>;
  sha256Hex?: (input: string) => Promise<string>;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function defaultGenerateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `sb_${bytesToBase64Url(bytes)}`;
}

async function defaultSha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function encodePlaintextValue(value: string): string {
  // v1: base64 plaintext. Wave H+ replaces this with Shamir shares.
  return btoa(unescape(encodeURIComponent(value)));
}

function decodePlaintextValue(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)));
}

function validateCreateInput(input: CreateSecretBallotInput): void {
  if (!input.organizationId) {
    throw new Error("organizationId is required");
  }
  if (!input.purpose || input.purpose.trim().length === 0) {
    throw new Error("purpose is required");
  }
  if (!Array.isArray(input.participants) || input.participants.length === 0) {
    throw new Error("participants must be a non-empty array");
  }
  if (!Number.isInteger(input.threshold) || input.threshold < 1) {
    throw new Error("threshold must be a positive integer");
  }
  if (input.threshold > input.participants.length) {
    throw new Error("threshold cannot exceed participant count");
  }
  const seen = new Set<string>();
  for (const participant of input.participants) {
    if (!participant.identityId || participant.identityId.length === 0) {
      throw new Error("each participant requires identityId");
    }
    if (seen.has(participant.identityId)) {
      throw new Error(`duplicate participant identityId: ${participant.identityId}`);
    }
    seen.add(participant.identityId);
  }
  if (input.expiresInMs !== undefined && input.expiresInMs <= 0) {
    throw new Error("expiresInMs must be positive");
  }
}

function requireRow(row: SecretBallotRow | null, id: string, context: string): SecretBallotRow {
  if (!row) {
    throw new Error(`Secret ballot ${id} not found (${context})`);
  }
  return row;
}

class SecretBallotsServiceImpl implements SecretBallotsService {
  private readonly repository: SecretBallotsRepository;
  private readonly dispatcher: SensitiveRequestDispatcher | undefined;
  private readonly generateToken: () => string | Promise<string>;
  private readonly sha256Hex: (input: string) => Promise<string>;

  constructor(deps: SecretBallotsServiceDeps) {
    this.repository = deps.repository;
    this.dispatcher = deps.dispatcher;
    this.generateToken = deps.generateToken ?? defaultGenerateToken;
    this.sha256Hex = deps.sha256Hex ?? defaultSha256Hex;
  }

  async create(input: CreateSecretBallotInput): Promise<CreateSecretBallotResult> {
    validateCreateInput(input);

    const expiresInMs = input.expiresInMs ?? DEFAULT_EXPIRES_IN_MS;
    const expiresAt = new Date(Date.now() + expiresInMs);

    const participantTokens: SecretBallotParticipantToken[] = [];
    const tokenHashByIdentity = new Map<string, string>();
    for (const participant of input.participants) {
      const scopedToken = await this.generateToken();
      const hash = await this.sha256Hex(scopedToken);
      participantTokens.push({ identityId: participant.identityId, scopedToken });
      tokenHashByIdentity.set(participant.identityId, hash);
    }

    const metadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      tokenHashByIdentity: Object.fromEntries(tokenHashByIdentity),
    };

    const ballot = await this.repository.createBallot({
      organizationId: input.organizationId,
      agentId: input.agentId ?? null,
      purpose: input.purpose.trim(),
      participants: input.participants,
      threshold: input.threshold,
      status: "open",
      expiresAt,
      metadata,
    });

    await this.repository.recordEvent({
      ballotId: ballot.id,
      eventName: "ballot.created",
      redactedPayload: {
        ballotId: ballot.id,
        organizationId: ballot.organizationId,
        threshold: ballot.threshold,
        participantCount: input.participants.length,
        expiresAt: ballot.expiresAt.toISOString(),
      },
    });

    logger.info("[SecretBallots] Created ballot", {
      ballotId: ballot.id,
      organizationId: ballot.organizationId,
      threshold: ballot.threshold,
      participantCount: input.participants.length,
    });

    return {
      ballot,
      ballotId: ballot.id,
      expiresAt: ballot.expiresAt,
      participantTokens,
    };
  }

  async get(id: string, organizationId: string): Promise<SecretBallotRow | null> {
    const row = await this.repository.getBallot(id);
    if (!row || row.organizationId !== organizationId) return null;
    return row;
  }

  async list(
    organizationId: string,
    filter: {
      status?: SecretBallotRow["status"];
      agentId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<SecretBallotRow[]> {
    return this.repository.listBallots({
      organizationId,
      status: filter.status,
      agentId: filter.agentId,
      limit: filter.limit,
      offset: filter.offset,
    });
  }

  async distribute(input: DistributeSecretBallotInput): Promise<SecretBallotDistributionResult> {
    if (input.target !== "dm") {
      throw new Error(
        `Unsupported distribution target: ${input.target}. Only "dm" is allowed for ballots.`,
      );
    }

    const ballot = requireRow(
      await this.repository.getBallot(input.ballotId),
      input.ballotId,
      "distribute lookup",
    );
    if (ballot.status !== "open") {
      throw new Error(`Cannot distribute ballot ${ballot.id}: status "${ballot.status}".`);
    }

    const tokenHashes = ballot.metadata.tokenHashByIdentity as Record<string, string> | undefined;
    if (!tokenHashes) {
      throw new Error(`Ballot ${ballot.id} is missing token hash metadata; cannot distribute.`);
    }

    let dispatched = 0;
    if (this.dispatcher) {
      // Distribution requires the original tokens, which the caller must hold.
      // The service exposes a dispatch contract — concrete adapters wire the
      // mapping between participant identity and DM channel in subsequent
      // waves. When no dispatcher is registered we record the intent only.
      for (const participant of ballot.participants) {
        const hash = tokenHashes[participant.identityId];
        if (!hash) continue;
        const result = await this.dispatcher.dispatchBallotInvite({
          ballotId: ballot.id,
          organizationId: ballot.organizationId,
          agentId: ballot.agentId,
          purpose: ballot.purpose,
          participant,
          // Dispatcher receives the token hash only; ballot creators must
          // separately hand each participant their scopedToken from
          // `create(...)`. The dispatcher uses the hash to address a
          // pre-issued sensitive-request token (Wave G v1 hook).
          scopedToken: hash,
          expiresAt: ballot.expiresAt,
        });
        if (result.delivered) dispatched += 1;
      }
    }

    await this.repository.recordEvent({
      ballotId: ballot.id,
      eventName: "ballot.distributed",
      redactedPayload: {
        ballotId: ballot.id,
        target: input.target,
        attempted: ballot.participants.length,
        dispatched,
      },
    });

    logger.info("[SecretBallots] Distributed ballot", {
      ballotId: ballot.id,
      target: input.target,
      attempted: ballot.participants.length,
      dispatched,
    });

    return { ballotId: ballot.id, target: input.target, dispatched };
  }

  async submitVote(input: SubmitVoteInput): Promise<SubmitVoteResult> {
    const ballot = await this.repository.getBallot(input.ballotId);
    if (!ballot) return { ok: false, reason: "ballot_not_found" };

    if (ballot.status !== "open") {
      return { ok: false, reason: "ballot_not_open" };
    }
    if (ballot.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: "ballot_expired" };
    }

    const tokenHashes = ballot.metadata.tokenHashByIdentity as Record<string, string> | undefined;
    if (!tokenHashes) {
      return { ok: false, reason: "unknown_token" };
    }

    const tokenHash = await this.sha256Hex(input.scopedToken);
    const participantIdentityId = Object.keys(tokenHashes).find(
      (identityId) => tokenHashes[identityId] === tokenHash,
    );
    if (!participantIdentityId) {
      await this.repository.recordEvent({
        ballotId: ballot.id,
        eventName: "ballot.vote_rejected",
        redactedPayload: { ballotId: ballot.id, reason: "unknown_token" },
      });
      return { ok: false, reason: "unknown_token" };
    }

    const valueCiphertext = encodePlaintextValue(input.value);
    const outcome: RecordVoteOutcome = await this.repository.recordVote({
      ballotId: ballot.id,
      participantTokenHash: tokenHash,
      participantIdentityId,
      valueCiphertext,
    });

    if (outcome.outcome === "conflict_different_value") {
      await this.repository.recordEvent({
        ballotId: ballot.id,
        eventName: "ballot.vote_rejected",
        redactedPayload: { ballotId: ballot.id, reason: "conflict_different_value" },
      });
      return { ok: false, reason: "conflict_different_value" };
    }
    if (outcome.outcome === "unknown_token") {
      return { ok: false, reason: "unknown_token" };
    }

    if (outcome.outcome === "recorded") {
      await this.repository.recordEvent({
        ballotId: ballot.id,
        eventName: "ballot.vote_recorded",
        redactedPayload: { ballotId: ballot.id },
      });
      logger.info("[SecretBallots] Recorded vote", {
        ballotId: ballot.id,
        organizationId: ballot.organizationId,
      });
    }

    return {
      ok: true,
      outcome: outcome.outcome === "recorded" ? "recorded" : "replay_same_value",
      ballotStatus: ballot.status,
    };
  }

  async tallyIfThresholdMet(input: { ballotId: string }): Promise<TallyResult> {
    const ballot = requireRow(
      await this.repository.getBallot(input.ballotId),
      input.ballotId,
      "tally lookup",
    );

    if (ballot.status === "tallied") {
      return { tallied: true, ballot, result: ballot.tallyResult };
    }
    if (ballot.status !== "open") {
      return { tallied: false, ballot, result: null };
    }

    const votes = await this.repository.listVotes(ballot.id);
    if (votes.length < ballot.threshold) {
      return { tallied: false, ballot, result: null };
    }

    const counts: Record<string, number> = {};
    const values: string[] = [];
    for (const vote of votes) {
      const decoded = decodePlaintextValue(vote.valueCiphertext);
      values.push(decoded);
      counts[decoded] = (counts[decoded] ?? 0) + 1;
    }

    const tally: SecretBallotTallyResult = {
      threshold: ballot.threshold,
      totalVotes: votes.length,
      values,
      counts,
      tallySchemaVersion: 1,
      tallyMethod: "plaintext_v1",
    };

    const updated = requireRow(
      await this.repository.updateBallot(ballot.id, {
        status: "tallied",
        tallyResult: tally,
      }),
      ballot.id,
      "tally update",
    );

    await this.repository.recordEvent({
      ballotId: ballot.id,
      eventName: "ballot.tallied",
      // Intentionally NOT logging values or counts in the audit trail; the
      // tally lives on the ballot row only.
      redactedPayload: {
        ballotId: ballot.id,
        threshold: ballot.threshold,
        totalVotes: votes.length,
      },
    });

    logger.info("[SecretBallots] Tallied ballot", {
      ballotId: ballot.id,
      organizationId: ballot.organizationId,
      threshold: ballot.threshold,
      totalVotes: votes.length,
    });

    return { tallied: true, ballot: updated, result: tally };
  }

  async expireBallot(input: {
    ballotId: string;
    organizationId: string;
  }): Promise<SecretBallotRow> {
    const ballot = requireRow(
      await this.repository.getBallot(input.ballotId),
      input.ballotId,
      "expire lookup",
    );
    if (ballot.organizationId !== input.organizationId) {
      throw new Error(
        `Ballot ${ballot.id} does not belong to organization ${input.organizationId}`,
      );
    }
    if (ballot.status !== "open") {
      return ballot;
    }
    const updated = requireRow(
      await this.repository.updateBallot(ballot.id, { status: "expired" }),
      ballot.id,
      "expire update",
    );
    await this.repository.recordEvent({
      ballotId: ballot.id,
      eventName: "ballot.expired",
      redactedPayload: { ballotId: ballot.id },
    });
    return updated;
  }

  async cancel(input: {
    ballotId: string;
    organizationId: string;
    reason?: string;
  }): Promise<SecretBallotRow> {
    const ballot = requireRow(
      await this.repository.getBallot(input.ballotId),
      input.ballotId,
      "cancel lookup",
    );
    if (ballot.organizationId !== input.organizationId) {
      throw new Error(
        `Ballot ${ballot.id} does not belong to organization ${input.organizationId}`,
      );
    }
    if (ballot.status !== "open") {
      throw new Error(`Cannot cancel ballot ${ballot.id}: status "${ballot.status}"`);
    }
    const updated = requireRow(
      await this.repository.updateBallot(ballot.id, { status: "canceled" }),
      ballot.id,
      "cancel update",
    );
    await this.repository.recordEvent({
      ballotId: ballot.id,
      eventName: "ballot.canceled",
      redactedPayload: { ballotId: ballot.id, reason: input.reason },
    });
    logger.info("[SecretBallots] Canceled ballot", {
      ballotId: ballot.id,
      organizationId: ballot.organizationId,
      reason: input.reason,
    });
    return updated;
  }

  async expirePast(now: Date = new Date()): Promise<string[]> {
    const expiredIds = await this.repository.expirePastBallots(now);
    for (const id of expiredIds) {
      await this.repository.recordEvent({
        ballotId: id,
        eventName: "ballot.expired",
        redactedPayload: { ballotId: id },
      });
    }
    if (expiredIds.length > 0) {
      logger.info("[SecretBallots] Expired ballots", { count: expiredIds.length });
    }
    return expiredIds;
  }
}

export function createSecretBallotsService(deps: SecretBallotsServiceDeps): SecretBallotsService {
  return new SecretBallotsServiceImpl(deps);
}

/**
 * Redact a ballot for public consumption. Strips token-hash metadata; the
 * ballot row otherwise contains no sensitive material in v1.
 */
export function redactSecretBallotForPublic(row: SecretBallotRow): SecretBallotRow {
  const { tokenHashByIdentity: _omitted, ...metadata } = row.metadata as Record<string, unknown> & {
    tokenHashByIdentity?: unknown;
  };
  return { ...row, metadata };
}

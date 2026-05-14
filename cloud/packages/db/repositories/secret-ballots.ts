import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { dbWrite as db } from "@/db/client";
import {
  type NewSecretBallot as NewSecretBallotDbRow,
  type NewSecretBallotEvent as NewSecretBallotEventDbRow,
  type NewSecretBallotVote as NewSecretBallotVoteDbRow,
  type SecretBallotEventName,
  type SecretBallotEventRow as SecretBallotEventDbRow,
  type SecretBallotParticipant,
  type SecretBallotRow as SecretBallotDbRow,
  type SecretBallotStatus,
  type SecretBallotTallyResult,
  type SecretBallotVoteRow as SecretBallotVoteDbRow,
  secretBallotEvents,
  secretBallotVotes,
  secretBallots,
} from "@/db/schemas/secret-ballots";

export interface SecretBallotRow {
  id: string;
  organizationId: string;
  agentId: string | null;
  purpose: string;
  participants: SecretBallotParticipant[];
  threshold: number;
  status: SecretBallotStatus;
  tallyResult: SecretBallotTallyResult | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface SecretBallotVoteRow {
  id: string;
  ballotId: string;
  participantTokenHash: string;
  participantIdentityId: string;
  valueCiphertext: string;
  recordedAt: Date;
}

export interface SecretBallotEventRow {
  id: string;
  ballotId: string;
  eventName: SecretBallotEventName;
  redactedPayload: Record<string, unknown>;
  occurredAt: Date;
}

export interface NewSecretBallot {
  organizationId: string;
  agentId?: string | null;
  purpose: string;
  participants: SecretBallotParticipant[];
  threshold: number;
  status?: SecretBallotStatus;
  tallyResult?: SecretBallotTallyResult | null;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ListSecretBallotsFilter {
  organizationId: string;
  status?: SecretBallotStatus;
  agentId?: string;
  limit?: number;
  offset?: number;
}

export interface RecordVoteInput {
  ballotId: string;
  participantTokenHash: string;
  participantIdentityId: string;
  valueCiphertext: string;
}

export type RecordVoteOutcome =
  | { outcome: "recorded"; vote: SecretBallotVoteRow }
  | { outcome: "replay_same_value"; vote: SecretBallotVoteRow }
  | { outcome: "conflict_different_value"; existing: SecretBallotVoteRow }
  | { outcome: "unknown_token" };

function toDomain(row: SecretBallotDbRow): SecretBallotRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    purpose: row.purpose,
    participants: row.participants,
    threshold: row.threshold,
    status: row.status,
    tallyResult: row.tally_result ?? null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata,
  };
}

function voteToDomain(row: SecretBallotVoteDbRow): SecretBallotVoteRow {
  return {
    id: row.id,
    ballotId: row.ballot_id,
    participantTokenHash: row.participant_token_hash,
    participantIdentityId: row.participant_identity_id,
    valueCiphertext: row.value_ciphertext,
    recordedAt: row.recorded_at,
  };
}

function eventToDomain(row: SecretBallotEventDbRow): SecretBallotEventRow {
  return {
    id: row.id,
    ballotId: row.ballot_id,
    eventName: row.event_name,
    redactedPayload: row.redacted_payload,
    occurredAt: row.occurred_at,
  };
}

function toDbInsert(input: NewSecretBallot): NewSecretBallotDbRow {
  return {
    organization_id: input.organizationId,
    agent_id: input.agentId ?? null,
    purpose: input.purpose,
    participants: input.participants,
    threshold: input.threshold,
    status: input.status ?? "open",
    tally_result: input.tallyResult ?? null,
    expires_at: input.expiresAt,
    metadata: input.metadata ?? {},
  };
}

export class SecretBallotsRepository {
  async createBallot(input: NewSecretBallot): Promise<SecretBallotRow> {
    const [row] = await db.insert(secretBallots).values(toDbInsert(input)).returning();
    return toDomain(row);
  }

  async getBallot(id: string): Promise<SecretBallotRow | null> {
    const [row] = await db
      .select()
      .from(secretBallots)
      .where(eq(secretBallots.id, id))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  async listBallots(filter: ListSecretBallotsFilter): Promise<SecretBallotRow[]> {
    const conditions = [eq(secretBallots.organization_id, filter.organizationId)];
    if (filter.status) conditions.push(eq(secretBallots.status, filter.status));
    if (filter.agentId) conditions.push(eq(secretBallots.agent_id, filter.agentId));

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const rows = await db
      .select()
      .from(secretBallots)
      .where(and(...conditions))
      .orderBy(desc(secretBallots.created_at))
      .limit(limit)
      .offset(offset);
    return rows.map(toDomain);
  }

  async updateBallot(
    id: string,
    patch: {
      status?: SecretBallotStatus;
      tallyResult?: SecretBallotTallyResult | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SecretBallotRow | null> {
    const set: Partial<NewSecretBallotDbRow> = { updated_at: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.tallyResult !== undefined) set.tally_result = patch.tallyResult;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;

    const [row] = await db
      .update(secretBallots)
      .set(set)
      .where(eq(secretBallots.id, id))
      .returning();
    return row ? toDomain(row) : null;
  }

  /**
   * Idempotent vote recording.
   *
   * - If no row exists for `(ballotId, participantIdentityId)`, insert a new row.
   * - If a row already exists and `valueCiphertext` matches, return `replay_same_value`.
   * - If a row already exists with a different value, return `conflict_different_value`.
   *
   * The repository never enforces token-to-participant binding here — the service
   * layer validates that the supplied scoped token resolves to the supplied
   * identity before calling `recordVote`.
   */
  async recordVote(input: RecordVoteInput): Promise<RecordVoteOutcome> {
    const existing = await this.findVoteByIdentity(input.ballotId, input.participantIdentityId);
    if (existing) {
      if (existing.valueCiphertext === input.valueCiphertext) {
        return { outcome: "replay_same_value", vote: existing };
      }
      return { outcome: "conflict_different_value", existing };
    }

    const dbRow: NewSecretBallotVoteDbRow = {
      ballot_id: input.ballotId,
      participant_token_hash: input.participantTokenHash,
      participant_identity_id: input.participantIdentityId,
      value_ciphertext: input.valueCiphertext,
    };
    const [inserted] = await db.insert(secretBallotVotes).values(dbRow).returning();
    return { outcome: "recorded", vote: voteToDomain(inserted) };
  }

  async findVoteByIdentity(
    ballotId: string,
    participantIdentityId: string,
  ): Promise<SecretBallotVoteRow | null> {
    const [row] = await db
      .select()
      .from(secretBallotVotes)
      .where(
        and(
          eq(secretBallotVotes.ballot_id, ballotId),
          eq(secretBallotVotes.participant_identity_id, participantIdentityId),
        ),
      )
      .limit(1);
    return row ? voteToDomain(row) : null;
  }

  async listVotes(ballotId: string): Promise<SecretBallotVoteRow[]> {
    const rows = await db
      .select()
      .from(secretBallotVotes)
      .where(eq(secretBallotVotes.ballot_id, ballotId));
    return rows.map(voteToDomain);
  }

  async countVotes(ballotId: string): Promise<number> {
    const rows = await db
      .select({ id: secretBallotVotes.id })
      .from(secretBallotVotes)
      .where(eq(secretBallotVotes.ballot_id, ballotId));
    return rows.length;
  }

  async recordEvent(input: {
    ballotId: string;
    eventName: SecretBallotEventName;
    redactedPayload?: Record<string, unknown>;
  }): Promise<SecretBallotEventRow> {
    const dbRow: NewSecretBallotEventDbRow = {
      ballot_id: input.ballotId,
      event_name: input.eventName,
      redacted_payload: input.redactedPayload ?? {},
    };
    const [row] = await db.insert(secretBallotEvents).values(dbRow).returning();
    return eventToDomain(row);
  }

  async expirePastBallots(now: Date): Promise<string[]> {
    const expirable: SecretBallotStatus[] = ["open"];
    const rows = await db
      .update(secretBallots)
      .set({ status: "expired", updated_at: now })
      .where(
        and(
          inArray(secretBallots.status, expirable),
          lt(secretBallots.expires_at, now),
        ),
      )
      .returning({ id: secretBallots.id });
    return rows.map((r) => r.id);
  }
}

export const secretBallotsRepository = new SecretBallotsRepository();

export type {
  SecretBallotEventName,
  SecretBallotParticipant,
  SecretBallotStatus,
  SecretBallotTallyResult,
};

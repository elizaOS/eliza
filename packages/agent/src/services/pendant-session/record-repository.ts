/**
 * Persists pendant capture sessions in the existing single-agent durable backend.
 * Revision comparison and child-record mutations share one transaction. Reads
 * preserve complete transcripts and reject incompatible or mis-scoped records.
 */
import { type DurableRecordStore, ElizaError } from "@elizaos/core";
import {
  PendantCaptureLeasePublicSchema,
  PendantInsightRefSchema,
  type PendantSegment,
  PendantSegmentSchema,
  PendantSessionSchema,
} from "@elizaos/shared/contracts/pendant-session-sync";
import { z } from "zod";
import {
  type PendantSessionRepository,
  PendantSessionRevisionConflictError,
  type StoredPendantSessionDocument,
} from "./repository.ts";

const RECORDS = "plugin_eliza_pendant_sessions_v1";
const SCHEMA = "plugin_eliza_pendant_sessions_schema";
const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    session: PendantSessionSchema.extend({
      captureLease: PendantCaptureLeasePublicSchema.extend({
        tokenDigest: z.string().min(1),
      }).nullable(),
    }),
    segments: z.array(PendantSegmentSchema),
    insightRefs: z.array(PendantInsightRefSchema),
  })
  .strict();
type Scope = { ownerId: string; agentId: string; sessionId: string };

function invalid(message: string): ElizaError {
  return new ElizaError(message, { code: "PENDANT_RECORD_INVALID" });
}

export class RecordPendantSessionRepository
  implements PendantSessionRepository
{
  constructor(
    private readonly storage: DurableRecordStore,
    runtimeAgentId: string | undefined,
  ) {
    if (storage.version !== 1 || storage.agentId !== runtimeAgentId)
      throw invalid(
        "Pendant storage requires this runtime's agent-bound version 1 database",
      );
  }

  private transaction<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    if (agentId !== this.storage.agentId)
      throw invalid("Cannot select another agent's pendant sessions");
    return this.storage.transaction(async () => {
      const version = await this.storage.get<number>(SCHEMA, "version");
      if (version !== null && version !== 1)
        throw invalid("Pendant record schema requires an explicit migration");
      if (version === null) await this.storage.set(SCHEMA, "version", 1);
      return work();
    });
  }

  private key(scope: Scope): string {
    return JSON.stringify([scope.ownerId, scope.agentId, scope.sessionId]);
  }

  private scope(stored: StoredPendantSessionDocument): Scope {
    return {
      ownerId: stored.session.ownerId,
      agentId: stored.session.agentId,
      sessionId: stored.session.id,
    };
  }

  private validate(value: unknown): StoredPendantSessionDocument {
    const parsed = documentSchema.safeParse(value);
    if (!parsed.success || parsed.data.session.agentId !== this.storage.agentId)
      throw invalid("Pendant record is malformed or belongs to another agent");
    const record = parsed.data;
    const ids = new Set<string>();
    const ordinals = new Set<number>();
    for (const segment of record.segments) {
      if (
        segment.sessionId !== record.session.id ||
        ids.has(segment.id) ||
        ordinals.has(segment.ordinal)
      )
        throw invalid(
          "Pendant segments require matching sessions and unique identifiers and ordinals",
        );
      ids.add(segment.id);
      ordinals.add(segment.ordinal);
    }
    if (
      new Set(record.insightRefs.map((ref) => ref.id)).size !==
      record.insightRefs.length
    )
      throw invalid(
        "Pendant insight identifiers must be unique within a session",
      );
    return record;
  }

  private async read(
    scope: Scope,
  ): Promise<StoredPendantSessionDocument | null> {
    const value = await this.storage.get<unknown>(RECORDS, this.key(scope));
    if (value === null) return null;
    const record = this.validate(value);
    if (this.key(this.scope(record)) !== this.key(scope))
      throw invalid("Pendant record does not match its owner and session key");
    return record;
  }

  async load(scope: Scope): Promise<StoredPendantSessionDocument | null> {
    return this.transaction(scope.agentId, () => this.read(scope));
  }

  async loadLatest(
    scope: Omit<Scope, "sessionId">,
  ): Promise<StoredPendantSessionDocument | null> {
    return this.transaction(scope.agentId, async () => {
      const rows = (await this.storage.getAll<unknown>(RECORDS))
        .map((row) => this.validate(row))
        .filter(
          (row) =>
            row.session.ownerId === scope.ownerId &&
            row.session.state !== "ended",
        );
      rows.sort(
        (a, b) =>
          b.session.startedAt.localeCompare(a.session.startedAt) ||
          b.session.id.localeCompare(a.session.id),
      );
      return rows[0] ?? null;
    });
  }

  async create(stored: StoredPendantSessionDocument): Promise<boolean> {
    return this.transaction(stored.session.agentId, async () => {
      const key = this.key(this.scope(stored));
      if (await this.read(this.scope(stored))) return false;
      const record = this.validate({
        schemaVersion: stored.schemaVersion,
        session: stored.session,
        segments: [],
        insightRefs: [],
      });
      await this.storage.set(RECORDS, key, record);
      return true;
    });
  }

  private async update(
    stored: StoredPendantSessionDocument,
    change: (record: StoredPendantSessionDocument) => void,
  ): Promise<void> {
    await this.transaction(stored.session.agentId, async () => {
      const scope = this.scope(stored);
      const existing = await this.read(scope);
      if (!existing)
        throw invalid("Pendant session disappeared during revision update");
      if (
        !Number.isSafeInteger(stored.session.revision) ||
        stored.session.revision < 1
      )
        throw invalid(
          "Pendant session update requires a positive integer revision",
        );
      if (existing.session.revision !== stored.session.revision - 1)
        throw new PendantSessionRevisionConflictError(
          existing.session.revision,
        );
      existing.session = {
        ...existing.session,
        endedAt: stored.session.endedAt,
        state: stored.session.state,
        processingLocation: stored.session.processingLocation,
        revision: stored.session.revision,
        captureLease: stored.session.captureLease,
      };
      change(existing);
      await this.storage.set(RECORDS, this.key(scope), this.validate(existing));
    });
  }

  async saveSession(stored: StoredPendantSessionDocument): Promise<void> {
    return this.update(stored, () => undefined);
  }

  async saveSegment(
    stored: StoredPendantSessionDocument,
    segment: PendantSegment,
  ): Promise<void> {
    return this.update(stored, (record) => {
      const previous = record.segments.find((item) => item.id === segment.id);
      record.segments = record.segments.filter(
        (item) => item.id !== segment.id,
      );
      record.segments.push({
        ...segment,
        createdAt: previous ? previous.createdAt : segment.createdAt,
      });
      record.segments.sort((a, b) => a.ordinal - b.ordinal);
    });
  }

  async replaceInsightRefs(
    stored: StoredPendantSessionDocument,
  ): Promise<void> {
    return this.update(stored, (record) => {
      record.insightRefs = [...stored.insightRefs].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    });
  }

  async delete(scope: Scope): Promise<void> {
    await this.transaction(scope.agentId, async () => {
      await this.read(scope);
      await this.storage.delete(RECORDS, this.key(scope));
    });
  }
}

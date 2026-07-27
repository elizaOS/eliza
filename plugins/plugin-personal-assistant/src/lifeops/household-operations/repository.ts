/**
 * PostgreSQL persistence for household-operation revisions, observations,
 * service history, responsibility signals, review proposals, and briefs.
 *
 * Identity and relationships stay in the runtime graph. This repository uses
 * append-only revisions and event rows plus transactional head CAS so retries,
 * concurrent writers, and process restarts cannot erase evidence or fabricate
 * a completed household outcome.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlJson,
  sqlQuote,
  type TransactionalDb,
  withRequiredTransaction,
} from "../sql.js";
import {
  contentSha,
  HOUSEHOLD_OPERATION_RECORD_KINDS,
  type HouseholdObservation,
  type HouseholdObservationInput,
  type HouseholdOperationDefinition,
  type HouseholdOperationRecordKind,
  type HouseholdOperationRevision,
  HouseholdOperationsError,
  type HouseholdServiceEvent,
  type HouseholdServiceEventInput,
  type HouseholdWeeklyBrief,
  normalizeObservation,
  normalizeObservationInput,
  normalizeOperationDefinition,
  normalizeOperationRevision,
  normalizeResponsibilityReviewProposal,
  normalizeResponsibilitySignal,
  normalizeResponsibilitySignalInput,
  normalizeServiceEvent,
  normalizeServiceEventInput,
  normalizeWeeklyBrief,
  operationIdentitySha256,
  operationRevisionSha256,
  type ResponsibilityReviewProposal,
  type ResponsibilitySignal,
  type ResponsibilitySignalInput,
  requireOperationsInteger,
  requireOperationsText,
  requireOperationsTimestamp,
  stableOperationsId,
} from "./types.js";

const HOUSEHOLD_OPERATIONS_SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_household_operation_heads (
     agent_id TEXT NOT NULL,
     record_kind TEXT NOT NULL,
     record_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     current_revision INTEGER NOT NULL,
     current_content_sha256 TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, record_kind, record_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_household_operation_heads_household_idx
     ON app_lifeops.life_household_operation_heads
       (agent_id, household_id, record_kind)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_household_operation_revisions (
     agent_id TEXT NOT NULL,
     record_kind TEXT NOT NULL,
     record_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     content_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, record_kind, record_id, revision)
   )`,
  `CREATE INDEX IF NOT EXISTS life_household_operation_revision_history_idx
     ON app_lifeops.life_household_operation_revisions
       (agent_id, household_id, record_kind, record_id, revision)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_household_observations (
     observation_id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     subject_key TEXT NOT NULL,
     observation_kind TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_id TEXT NOT NULL,
     source_revision INTEGER NOT NULL,
     content_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (
       agent_id, household_id, subject_key, observation_kind,
       source_kind, source_id, source_revision
     )
   )`,
  `CREATE INDEX IF NOT EXISTS life_household_observations_subject_idx
     ON app_lifeops.life_household_observations
       (agent_id, household_id, subject_key, observation_kind, created_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_household_service_events (
     event_id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     subject_key TEXT NOT NULL,
     service_kind TEXT NOT NULL,
     event_kind TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_id TEXT NOT NULL,
     source_revision INTEGER NOT NULL,
     event_key TEXT NOT NULL,
     content_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (
       agent_id, household_id, event_key,
       source_kind, source_id, source_revision
     )
   )`,
  `CREATE INDEX IF NOT EXISTS life_household_service_events_subject_idx
     ON app_lifeops.life_household_service_events
       (agent_id, household_id, subject_key, service_kind, created_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_household_responsibility_signals (
     signal_id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     assignment_record_id TEXT NOT NULL,
     assignment_revision INTEGER NOT NULL,
     owner_entity_id TEXT NOT NULL,
     signal_kind TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_id TEXT NOT NULL,
     source_revision INTEGER NOT NULL,
     signal_key TEXT NOT NULL,
     content_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (
       agent_id, assignment_record_id, assignment_revision, signal_key,
       source_kind, source_id, source_revision
     )
   )`,
  `CREATE INDEX IF NOT EXISTS life_household_responsibility_signals_assignment_idx
     ON app_lifeops.life_household_responsibility_signals
       (agent_id, household_id, assignment_record_id, assignment_revision, created_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_household_responsibility_reviews (
     review_id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     assignment_record_id TEXT NOT NULL,
     assignment_revision INTEGER NOT NULL,
     snapshot_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (
       agent_id, assignment_record_id, assignment_revision, snapshot_sha256
     )
   )`,
  `CREATE INDEX IF NOT EXISTS life_household_responsibility_reviews_assignment_idx
     ON app_lifeops.life_household_responsibility_reviews
       (agent_id, household_id, assignment_record_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_household_weekly_briefs (
     brief_id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     window_starts_at TEXT NOT NULL,
     window_ends_at TEXT NOT NULL,
     snapshot_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (
       agent_id, household_id, window_starts_at, window_ends_at, snapshot_sha256
     )
   )`,
  `CREATE INDEX IF NOT EXISTS life_household_weekly_briefs_household_idx
     ON app_lifeops.life_household_weekly_briefs
       (agent_id, household_id, window_starts_at, window_ends_at)`,
] as const;

function persistedInvalid(
  message: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new HouseholdOperationsError(
    message,
    "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
    context,
    cause,
  );
}

function parseJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      // error-policy:J3 persisted JSON is untrusted input; corruption must
      // surface as invalid data rather than a fabricated empty projection.
      return persistedInvalid(
        `Persisted household-operations row has malformed ${field}`,
        { field },
        error,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return persistedInvalid(
      `Persisted household-operations row has invalid ${field}`,
      { field },
    );
  }
  return parsed as Record<string, unknown>;
}

function rowText(
  row: Record<string, unknown>,
  key: string,
  field = key,
): string {
  return requireOperationsText(row[key], field, 2_000);
}

function rowInteger(
  row: Record<string, unknown>,
  key: string,
  field = key,
): number {
  const value = row[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return requireOperationsInteger(parsed, field, 0);
}

function revisionFromRow(
  row: Record<string, unknown>,
): HouseholdOperationRevision {
  const revision = normalizeOperationRevision(
    parseJsonObject(row.value_json, "revision.value"),
  );
  if (
    revision.kind !== rowText(row, "record_kind") ||
    revision.recordId !== rowText(row, "record_id") ||
    revision.householdId !== rowText(row, "household_id") ||
    revision.revision !== rowInteger(row, "revision") ||
    revision.contentSha256 !== rowText(row, "content_sha256")
  ) {
    return persistedInvalid(
      "Persisted household-operation revision columns do not match its contract",
      { recordId: revision.recordId, revision: revision.revision },
    );
  }
  return revision;
}

function observationFromRow(
  row: Record<string, unknown>,
): HouseholdObservation {
  const observation = normalizeObservation(
    parseJsonObject(row.value_json, "observation.value"),
  );
  if (
    observation.observationId !== rowText(row, "observation_id") ||
    observation.householdId !== rowText(row, "household_id") ||
    observation.subjectKey !== rowText(row, "subject_key") ||
    observation.observationKind !== rowText(row, "observation_kind") ||
    observation.provenance.kind !== rowText(row, "source_kind") ||
    observation.provenance.sourceId !== rowText(row, "source_id") ||
    observation.provenance.sourceRevision !==
      rowInteger(row, "source_revision") ||
    observation.contentSha256 !== rowText(row, "content_sha256")
  ) {
    return persistedInvalid(
      "Persisted household observation columns do not match its contract",
      { observationId: observation.observationId },
    );
  }
  return observation;
}

function serviceEventFromRow(
  row: Record<string, unknown>,
): HouseholdServiceEvent {
  const event = normalizeServiceEvent(
    parseJsonObject(row.value_json, "serviceEvent.value"),
  );
  if (
    event.eventId !== rowText(row, "event_id") ||
    event.householdId !== rowText(row, "household_id") ||
    event.subjectKey !== rowText(row, "subject_key") ||
    event.serviceKind !== rowText(row, "service_kind") ||
    event.eventKind !== rowText(row, "event_kind") ||
    event.provenance.kind !== rowText(row, "source_kind") ||
    event.provenance.sourceId !== rowText(row, "source_id") ||
    event.provenance.sourceRevision !== rowInteger(row, "source_revision") ||
    event.contentSha256 !== rowText(row, "content_sha256")
  ) {
    return persistedInvalid(
      "Persisted household service-event columns do not match its contract",
      { eventId: event.eventId },
    );
  }
  return event;
}

function responsibilitySignalFromRow(
  row: Record<string, unknown>,
): ResponsibilitySignal {
  const signal = normalizeResponsibilitySignal(
    parseJsonObject(row.value_json, "responsibilitySignal.value"),
  );
  if (
    signal.signalId !== rowText(row, "signal_id") ||
    signal.householdId !== rowText(row, "household_id") ||
    signal.assignmentRecordId !== rowText(row, "assignment_record_id") ||
    signal.assignmentRevision !== rowInteger(row, "assignment_revision") ||
    signal.ownerEntityId !== rowText(row, "owner_entity_id") ||
    signal.signalKind !== rowText(row, "signal_kind") ||
    signal.provenance.kind !== rowText(row, "source_kind") ||
    signal.provenance.sourceId !== rowText(row, "source_id") ||
    signal.provenance.sourceRevision !== rowInteger(row, "source_revision") ||
    signal.signalKey !== rowText(row, "signal_key") ||
    signal.contentSha256 !== rowText(row, "content_sha256")
  ) {
    return persistedInvalid(
      "Persisted responsibility-signal columns do not match its contract",
      { signalId: signal.signalId },
    );
  }
  return signal;
}

function reviewFromRow(
  row: Record<string, unknown>,
): ResponsibilityReviewProposal {
  const review = normalizeResponsibilityReviewProposal(
    parseJsonObject(row.value_json, "responsibilityReview.value"),
  );
  if (
    review.reviewId !== rowText(row, "review_id") ||
    review.householdId !== rowText(row, "household_id") ||
    review.assignmentRecordId !== rowText(row, "assignment_record_id") ||
    review.assignmentRevision !== rowInteger(row, "assignment_revision") ||
    review.snapshotSha256 !== rowText(row, "snapshot_sha256")
  ) {
    return persistedInvalid(
      "Persisted responsibility-review columns do not match its contract",
      { reviewId: review.reviewId },
    );
  }
  return review;
}

function briefFromRow(row: Record<string, unknown>): HouseholdWeeklyBrief {
  const brief = normalizeWeeklyBrief(
    parseJsonObject(row.value_json, "weeklyBrief.value"),
  );
  if (
    brief.briefId !== rowText(row, "brief_id") ||
    brief.householdId !== rowText(row, "household_id") ||
    brief.window.startsAt !== rowText(row, "window_starts_at") ||
    brief.window.endsAt !== rowText(row, "window_ends_at") ||
    brief.snapshotSha256 !== rowText(row, "snapshot_sha256")
  ) {
    return persistedInvalid(
      "Persisted weekly-brief columns do not match its contract",
      { briefId: brief.briefId },
    );
  }
  return brief;
}

function conflict(message: string, context: Record<string, unknown>): never {
  throw new HouseholdOperationsError(
    message,
    "HOUSEHOLD_OPERATIONS_CONFLICT",
    context,
  );
}

async function selectRevision(
  tx: TransactionalDb,
  agentId: string,
  kind: HouseholdOperationRecordKind,
  recordId: string,
  revision: number,
): Promise<HouseholdOperationRevision | null> {
  const rows = await executeRawSqlTx(
    tx,
    `SELECT * FROM app_lifeops.life_household_operation_revisions
     WHERE agent_id = ${sqlQuote(agentId)}
       AND record_kind = ${sqlQuote(kind)}
       AND record_id = ${sqlQuote(recordId)}
       AND revision = ${sqlInteger(revision)}
     LIMIT 1`,
  );
  return rows[0] ? revisionFromRow(rows[0]) : null;
}

export class HouseholdOperationsRepository {
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        for (const statement of HOUSEHOLD_OPERATIONS_SCHEMA) {
          await executeRawSql(this.runtime, statement);
        }
      })();
    }
    return this.schemaReady;
  }

  async putRevision(
    definitionInput: HouseholdOperationDefinition,
    expectedRevisionInput: number,
    createdAtInput: string,
  ): Promise<HouseholdOperationRevision> {
    await this.ensureSchema();
    const definition = normalizeOperationDefinition(definitionInput);
    const expectedRevision = requireOperationsInteger(
      expectedRevisionInput,
      "expectedRevision",
      0,
    );
    const revision = expectedRevision + 1;
    const createdAt = requireOperationsTimestamp(createdAtInput, "createdAt");
    const record: HouseholdOperationRevision = {
      ...definition,
      revision,
      contentSha256: operationRevisionSha256(definition, revision),
      createdAt,
    };

    return withRequiredTransaction(this.runtime, async (tx) => {
      if (expectedRevision > 0) {
        const previous = await selectRevision(
          tx,
          this.agentId,
          definition.kind,
          definition.recordId,
          expectedRevision,
        );
        if (!previous) {
          return conflict(
            "The expected household-operation revision does not exist",
            {
              kind: definition.kind,
              recordId: definition.recordId,
              expectedRevision,
            },
          );
        }
        if (
          operationIdentitySha256(previous) !==
          operationIdentitySha256(definition)
        ) {
          return conflict(
            "A household-operation record cannot change its canonical subject identity",
            {
              kind: definition.kind,
              recordId: definition.recordId,
              expectedRevision,
            },
          );
        }
      }
      const existing = await selectRevision(
        tx,
        this.agentId,
        definition.kind,
        definition.recordId,
        revision,
      );
      if (existing) {
        if (existing.contentSha256 === record.contentSha256) return existing;
        return conflict(
          "A household-operation revision already exists with different content",
          {
            kind: definition.kind,
            recordId: definition.recordId,
            revision,
          },
        );
      }

      const headRows =
        expectedRevision === 0
          ? await executeRawSqlTx(
              tx,
              `INSERT INTO app_lifeops.life_household_operation_heads (
                 agent_id, record_kind, record_id, household_id,
                 current_revision, current_content_sha256, updated_at
               ) VALUES (
                 ${sqlQuote(this.agentId)}, ${sqlQuote(definition.kind)},
                 ${sqlQuote(definition.recordId)},
                 ${sqlQuote(definition.householdId)}, ${sqlInteger(revision)},
                 ${sqlQuote(record.contentSha256)}, ${sqlQuote(createdAt)}
               )
               ON CONFLICT (agent_id, record_kind, record_id) DO NOTHING
               RETURNING *`,
            )
          : await executeRawSqlTx(
              tx,
              `UPDATE app_lifeops.life_household_operation_heads
               SET household_id = ${sqlQuote(definition.householdId)},
                   current_revision = ${sqlInteger(revision)},
                   current_content_sha256 = ${sqlQuote(record.contentSha256)},
                   updated_at = ${sqlQuote(createdAt)}
               WHERE agent_id = ${sqlQuote(this.agentId)}
                 AND record_kind = ${sqlQuote(definition.kind)}
                 AND record_id = ${sqlQuote(definition.recordId)}
                 AND current_revision = ${sqlInteger(expectedRevision)}
               RETURNING *`,
            );
      if (!headRows[0]) {
        return conflict("Household-operation record changed concurrently", {
          kind: definition.kind,
          recordId: definition.recordId,
          expectedRevision,
        });
      }

      const rows = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_household_operation_revisions (
           agent_id, record_kind, record_id, household_id, revision,
           content_sha256, value_json, created_at
         ) VALUES (
           ${sqlQuote(this.agentId)}, ${sqlQuote(definition.kind)},
           ${sqlQuote(definition.recordId)}, ${sqlQuote(definition.householdId)},
           ${sqlInteger(revision)}, ${sqlQuote(record.contentSha256)},
           ${sqlJson(record)}, ${sqlQuote(createdAt)}
         )
         ON CONFLICT (agent_id, record_kind, record_id, revision) DO NOTHING
         RETURNING *`,
      );
      if (!rows[0]) {
        return conflict("Household-operation revision could not be appended", {
          kind: definition.kind,
          recordId: definition.recordId,
          revision,
        });
      }
      return revisionFromRow(rows[0]);
    });
  }

  async getCurrentRevision(
    kind: HouseholdOperationRecordKind,
    recordId: string,
  ): Promise<HouseholdOperationRevision | null> {
    await this.ensureSchema();
    const checkedKind = HOUSEHOLD_OPERATION_RECORD_KINDS.find(
      (candidate) => candidate === kind,
    );
    if (!checkedKind) {
      throw new HouseholdOperationsError(
        "Unknown household-operation record kind",
        "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
        { kind },
      );
    }
    const rows = await executeRawSql(
      this.runtime,
      `SELECT revisions.*
       FROM app_lifeops.life_household_operation_heads AS heads
       JOIN app_lifeops.life_household_operation_revisions AS revisions
         ON revisions.agent_id = heads.agent_id
        AND revisions.record_kind = heads.record_kind
        AND revisions.record_id = heads.record_id
        AND revisions.revision = heads.current_revision
       WHERE heads.agent_id = ${sqlQuote(this.agentId)}
         AND heads.record_kind = ${sqlQuote(checkedKind)}
         AND heads.record_id = ${sqlQuote(requireOperationsText(recordId, "recordId", 300))}
       LIMIT 1`,
    );
    return rows[0] ? revisionFromRow(rows[0]) : null;
  }

  async listCurrentRevisions(
    householdIdInput: string,
    kind?: HouseholdOperationRecordKind,
  ): Promise<HouseholdOperationRevision[]> {
    await this.ensureSchema();
    const householdId = requireOperationsText(
      householdIdInput,
      "householdId",
      300,
    );
    if (
      kind !== undefined &&
      !HOUSEHOLD_OPERATION_RECORD_KINDS.includes(kind)
    ) {
      throw new HouseholdOperationsError(
        "Unknown household-operation record kind",
        "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
        { kind },
      );
    }
    const rows = await executeRawSql(
      this.runtime,
      `SELECT revisions.*
       FROM app_lifeops.life_household_operation_heads AS heads
       JOIN app_lifeops.life_household_operation_revisions AS revisions
         ON revisions.agent_id = heads.agent_id
        AND revisions.record_kind = heads.record_kind
        AND revisions.record_id = heads.record_id
        AND revisions.revision = heads.current_revision
       WHERE heads.agent_id = ${sqlQuote(this.agentId)}
         AND heads.household_id = ${sqlQuote(householdId)}
         ${kind ? `AND heads.record_kind = ${sqlQuote(kind)}` : ""}
       ORDER BY revisions.record_kind ASC, revisions.record_id ASC`,
    );
    return rows.map(revisionFromRow);
  }

  async listRevisionHistory(
    kind: HouseholdOperationRecordKind,
    recordIdInput: string,
  ): Promise<HouseholdOperationRevision[]> {
    await this.ensureSchema();
    const recordId = requireOperationsText(recordIdInput, "recordId", 300);
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_household_operation_revisions
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND record_kind = ${sqlQuote(kind)}
           AND record_id = ${sqlQuote(recordId)}
         ORDER BY revision ASC`,
      )
    ).map(revisionFromRow);
  }

  async recordObservation(
    inputValue: HouseholdObservationInput,
    createdAtInput: string,
  ): Promise<{ observation: HouseholdObservation; inserted: boolean }> {
    await this.ensureSchema();
    const input = normalizeObservationInput(inputValue);
    const createdAt = requireOperationsTimestamp(createdAtInput, "createdAt");
    const observationId = stableOperationsId("hhobs", {
      agentId: this.agentId,
      householdId: input.householdId,
      subjectKey: input.subjectKey,
      observationKind: input.observationKind,
      sourceKind: input.provenance.kind,
      sourceId: input.provenance.sourceId,
      sourceRevision: input.provenance.sourceRevision,
    });
    if (
      input.supersedesObservationId === observationId ||
      input.correctsObservationId === observationId
    ) {
      throw new HouseholdOperationsError(
        "A household observation may not supersede or correct itself",
        "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
        { observationId },
      );
    }
    for (const targetId of Array.from(
      new Set(
        [input.supersedesObservationId, input.correctsObservationId].filter(
          (id): id is string => id !== null,
        ),
      ),
    )) {
      const target = await this.getObservation(targetId);
      if (!target) {
        throw new HouseholdOperationsError(
          "A correction or supersession target does not exist",
          "HOUSEHOLD_OPERATIONS_NOT_FOUND",
          { targetId },
        );
      }
      if (
        target.householdId !== input.householdId ||
        target.subjectKey !== input.subjectKey ||
        target.observationKind !== input.observationKind
      ) {
        throw new HouseholdOperationsError(
          "A correction or supersession must retain household, subject, and observation kind",
          "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
          { targetId },
        );
      }
    }
    const observation: HouseholdObservation = {
      ...input,
      observationId,
      contentSha256: contentSha(input),
      createdAt,
    };
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_observations (
         observation_id, agent_id, household_id, subject_key, observation_kind,
         source_kind, source_id, source_revision, content_sha256,
         value_json, created_at
       ) VALUES (
         ${sqlQuote(observationId)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(input.householdId)}, ${sqlQuote(input.subjectKey)},
         ${sqlQuote(input.observationKind)}, ${sqlQuote(input.provenance.kind)},
         ${sqlQuote(input.provenance.sourceId)},
         ${sqlInteger(input.provenance.sourceRevision)},
         ${sqlQuote(observation.contentSha256)}, ${sqlJson(observation)},
         ${sqlQuote(createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) {
      return { observation: observationFromRow(rows[0]), inserted: true };
    }
    const existing = await this.getObservation(observationId);
    if (!existing) {
      return conflict(
        "Observation provenance collided with a different event identity",
        { observationId },
      );
    }
    if (existing.contentSha256 !== observation.contentSha256) {
      return conflict(
        "Observation provenance replayed with different content",
        { observationId },
      );
    }
    return { observation: existing, inserted: false };
  }

  async getObservation(
    observationIdInput: string,
  ): Promise<HouseholdObservation | null> {
    await this.ensureSchema();
    const observationId = requireOperationsText(
      observationIdInput,
      "observationId",
      300,
    );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_observations
       WHERE observation_id = ${sqlQuote(observationId)}
         AND agent_id = ${sqlQuote(this.agentId)}
       LIMIT 1`,
    );
    return rows[0] ? observationFromRow(rows[0]) : null;
  }

  async listObservations(
    householdIdInput: string,
    filters?: { subjectKey?: string; observationKind?: string },
  ): Promise<HouseholdObservation[]> {
    await this.ensureSchema();
    const householdId = requireOperationsText(
      householdIdInput,
      "householdId",
      300,
    );
    const subjectFilter = filters?.subjectKey
      ? `AND subject_key = ${sqlQuote(requireOperationsText(filters.subjectKey, "subjectKey", 300))}`
      : "";
    const kindFilter = filters?.observationKind
      ? `AND observation_kind = ${sqlQuote(requireOperationsText(filters.observationKind, "observationKind", 100))}`
      : "";
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_household_observations
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
           ${subjectFilter}
           ${kindFilter}
         ORDER BY created_at ASC, observation_id ASC`,
      )
    ).map(observationFromRow);
  }

  async recordServiceEvent(
    inputValue: HouseholdServiceEventInput,
    createdAtInput: string,
  ): Promise<{ event: HouseholdServiceEvent; inserted: boolean }> {
    await this.ensureSchema();
    const input = normalizeServiceEventInput(inputValue);
    const createdAt = requireOperationsTimestamp(createdAtInput, "createdAt");
    const eventId = stableOperationsId("hhsvc", {
      agentId: this.agentId,
      householdId: input.householdId,
      eventKey: input.eventKey,
      sourceKind: input.provenance.kind,
      sourceId: input.provenance.sourceId,
      sourceRevision: input.provenance.sourceRevision,
    });
    const event: HouseholdServiceEvent = {
      ...input,
      eventId,
      contentSha256: contentSha(input),
      createdAt,
    };
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_service_events (
         event_id, agent_id, household_id, subject_key, service_kind,
         event_kind, source_kind, source_id, source_revision, event_key,
         content_sha256, value_json, created_at
       ) VALUES (
         ${sqlQuote(eventId)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(input.householdId)}, ${sqlQuote(input.subjectKey)},
         ${sqlQuote(input.serviceKind)}, ${sqlQuote(input.eventKind)},
         ${sqlQuote(input.provenance.kind)}, ${sqlQuote(input.provenance.sourceId)},
         ${sqlInteger(input.provenance.sourceRevision)}, ${sqlQuote(input.eventKey)},
         ${sqlQuote(event.contentSha256)}, ${sqlJson(event)},
         ${sqlQuote(createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) return { event: serviceEventFromRow(rows[0]), inserted: true };
    const existingRows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_service_events
       WHERE event_id = ${sqlQuote(eventId)}
         AND agent_id = ${sqlQuote(this.agentId)}
       LIMIT 1`,
    );
    const existing = existingRows[0]
      ? serviceEventFromRow(existingRows[0])
      : null;
    if (!existing) {
      return conflict(
        "Service-event provenance collided with a different event identity",
        { eventId },
      );
    }
    if (existing.contentSha256 !== event.contentSha256) {
      return conflict(
        "Service-event provenance replayed with different content",
        { eventId },
      );
    }
    return { event: existing, inserted: false };
  }

  async listServiceEvents(
    householdIdInput: string,
    filters?: { subjectKey?: string; serviceKind?: string },
  ): Promise<HouseholdServiceEvent[]> {
    await this.ensureSchema();
    const householdId = requireOperationsText(
      householdIdInput,
      "householdId",
      300,
    );
    const subjectFilter = filters?.subjectKey
      ? `AND subject_key = ${sqlQuote(requireOperationsText(filters.subjectKey, "subjectKey", 300))}`
      : "";
    const kindFilter = filters?.serviceKind
      ? `AND service_kind = ${sqlQuote(requireOperationsText(filters.serviceKind, "serviceKind", 300))}`
      : "";
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_household_service_events
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
           ${subjectFilter}
           ${kindFilter}
         ORDER BY created_at ASC, event_id ASC`,
      )
    ).map(serviceEventFromRow);
  }

  async recordResponsibilitySignal(
    inputValue: ResponsibilitySignalInput,
    createdAtInput: string,
  ): Promise<{ signal: ResponsibilitySignal; inserted: boolean }> {
    await this.ensureSchema();
    const input = normalizeResponsibilitySignalInput(inputValue);
    const createdAt = requireOperationsTimestamp(createdAtInput, "createdAt");
    const signalId = stableOperationsId("hhsig", {
      agentId: this.agentId,
      assignmentRecordId: input.assignmentRecordId,
      assignmentRevision: input.assignmentRevision,
      signalKey: input.signalKey,
      sourceKind: input.provenance.kind,
      sourceId: input.provenance.sourceId,
      sourceRevision: input.provenance.sourceRevision,
    });
    const signal: ResponsibilitySignal = {
      ...input,
      signalId,
      contentSha256: contentSha(input),
      createdAt,
    };
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_responsibility_signals (
         signal_id, agent_id, household_id, assignment_record_id,
         assignment_revision, owner_entity_id, signal_kind, source_kind,
         source_id, source_revision, signal_key, content_sha256,
         value_json, created_at
       ) VALUES (
         ${sqlQuote(signalId)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(input.householdId)}, ${sqlQuote(input.assignmentRecordId)},
         ${sqlInteger(input.assignmentRevision)}, ${sqlQuote(input.ownerEntityId)},
         ${sqlQuote(input.signalKind)}, ${sqlQuote(input.provenance.kind)},
         ${sqlQuote(input.provenance.sourceId)},
         ${sqlInteger(input.provenance.sourceRevision)},
         ${sqlQuote(input.signalKey)}, ${sqlQuote(signal.contentSha256)},
         ${sqlJson(signal)}, ${sqlQuote(createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) {
      return {
        signal: responsibilitySignalFromRow(rows[0]),
        inserted: true,
      };
    }
    const existingRows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_responsibility_signals
       WHERE signal_id = ${sqlQuote(signalId)}
         AND agent_id = ${sqlQuote(this.agentId)}
       LIMIT 1`,
    );
    const existing = existingRows[0]
      ? responsibilitySignalFromRow(existingRows[0])
      : null;
    if (!existing) {
      return conflict(
        "Responsibility-signal provenance collided with a different event identity",
        { signalId },
      );
    }
    if (existing.contentSha256 !== signal.contentSha256) {
      return conflict(
        "Responsibility-signal provenance replayed with different content",
        { signalId },
      );
    }
    return { signal: existing, inserted: false };
  }

  async listResponsibilitySignals(
    householdIdInput: string,
    assignmentRecordIdInput: string,
    assignmentRevision?: number,
  ): Promise<ResponsibilitySignal[]> {
    await this.ensureSchema();
    const householdId = requireOperationsText(
      householdIdInput,
      "householdId",
      300,
    );
    const assignmentRecordId = requireOperationsText(
      assignmentRecordIdInput,
      "assignmentRecordId",
      300,
    );
    const revisionFilter =
      assignmentRevision === undefined
        ? ""
        : `AND assignment_revision = ${sqlInteger(
            requireOperationsInteger(
              assignmentRevision,
              "assignmentRevision",
              1,
            ),
          )}`;
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_household_responsibility_signals
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
           AND assignment_record_id = ${sqlQuote(assignmentRecordId)}
           ${revisionFilter}
         ORDER BY created_at ASC, signal_id ASC`,
      )
    ).map(responsibilitySignalFromRow);
  }

  async putResponsibilityReview(
    proposalInput: ResponsibilityReviewProposal,
  ): Promise<{ proposal: ResponsibilityReviewProposal; inserted: boolean }> {
    await this.ensureSchema();
    const proposal = normalizeResponsibilityReviewProposal(proposalInput);
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_responsibility_reviews (
         review_id, agent_id, household_id, assignment_record_id,
         assignment_revision, snapshot_sha256, value_json, created_at
       ) VALUES (
         ${sqlQuote(proposal.reviewId)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(proposal.householdId)},
         ${sqlQuote(proposal.assignmentRecordId)},
         ${sqlInteger(proposal.assignmentRevision)},
         ${sqlQuote(proposal.snapshotSha256)}, ${sqlJson(proposal)},
         ${sqlQuote(proposal.createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) {
      return { proposal: reviewFromRow(rows[0]), inserted: true };
    }
    const existingRows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_responsibility_reviews
       WHERE review_id = ${sqlQuote(proposal.reviewId)}
         AND agent_id = ${sqlQuote(this.agentId)}
       LIMIT 1`,
    );
    const existing = existingRows[0] ? reviewFromRow(existingRows[0]) : null;
    if (!existing) {
      return conflict(
        "Responsibility review collided with a different snapshot",
        { reviewId: proposal.reviewId },
      );
    }
    const { createdAt: _existingCreatedAt, ...existingStable } = existing;
    const { createdAt: _proposalCreatedAt, ...proposalStable } = proposal;
    if (contentSha(existingStable) !== contentSha(proposalStable)) {
      return conflict(
        "Responsibility-review identifier replayed with different content",
        { reviewId: proposal.reviewId },
      );
    }
    return { proposal: existing, inserted: false };
  }

  async listResponsibilityReviews(
    householdIdInput: string,
    assignmentRecordId?: string,
  ): Promise<ResponsibilityReviewProposal[]> {
    await this.ensureSchema();
    const householdId = requireOperationsText(
      householdIdInput,
      "householdId",
      300,
    );
    const assignmentFilter = assignmentRecordId
      ? `AND assignment_record_id = ${sqlQuote(
          requireOperationsText(assignmentRecordId, "assignmentRecordId", 300),
        )}`
      : "";
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_household_responsibility_reviews
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
           ${assignmentFilter}
         ORDER BY created_at ASC, review_id ASC`,
      )
    ).map(reviewFromRow);
  }

  async putWeeklyBrief(
    briefInput: HouseholdWeeklyBrief,
  ): Promise<{ brief: HouseholdWeeklyBrief; inserted: boolean }> {
    await this.ensureSchema();
    const brief = normalizeWeeklyBrief(briefInput);
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_weekly_briefs (
         brief_id, agent_id, household_id, window_starts_at, window_ends_at,
         snapshot_sha256, value_json, created_at
       ) VALUES (
         ${sqlQuote(brief.briefId)}, ${sqlQuote(this.agentId)},
         ${sqlQuote(brief.householdId)}, ${sqlQuote(brief.window.startsAt)},
         ${sqlQuote(brief.window.endsAt)}, ${sqlQuote(brief.snapshotSha256)},
         ${sqlJson(brief)}, ${sqlQuote(brief.createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) return { brief: briefFromRow(rows[0]), inserted: true };
    const existing = await this.getWeeklyBrief(brief.briefId);
    if (!existing) {
      return conflict("Weekly brief collided with a different snapshot", {
        briefId: brief.briefId,
      });
    }
    const {
      createdAt: _existingCreatedAt,
      generatedAt: _existingGeneratedAt,
      ...existingStable
    } = existing;
    const {
      createdAt: _briefCreatedAt,
      generatedAt: _briefGeneratedAt,
      ...briefStable
    } = brief;
    if (contentSha(existingStable) !== contentSha(briefStable)) {
      return conflict(
        "Weekly-brief identifier replayed with different content",
        { briefId: brief.briefId },
      );
    }
    return { brief: existing, inserted: false };
  }

  async getWeeklyBrief(
    briefIdInput: string,
  ): Promise<HouseholdWeeklyBrief | null> {
    await this.ensureSchema();
    const briefId = requireOperationsText(briefIdInput, "briefId", 300);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_household_weekly_briefs
       WHERE brief_id = ${sqlQuote(briefId)}
         AND agent_id = ${sqlQuote(this.agentId)}
       LIMIT 1`,
    );
    return rows[0] ? briefFromRow(rows[0]) : null;
  }
}

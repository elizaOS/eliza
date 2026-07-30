/**
 * PostgreSQL persistence for quarantined voice turns, append-only intent
 * revisions, co-parent delivery events, and redacted child-week snapshots.
 * Canonical people and household grants remain in EntityStore and
 * RelationshipStore; scheduled work remains in the shared ScheduledTask store.
 */
import { randomUUID } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonArray,
  parseJsonValue,
  sqlInteger,
  sqlJson,
  sqlQuote,
  type TransactionalDb,
  withRequiredTransaction,
} from "../sql.js";
import {
  type ChildWeekProjection,
  type CoParentCommunication,
  type CoParentProviderEvent,
  type CoParentProviderEventInput,
  coParentStateRank,
  FAMILY_WEEK_ITEM_KINDS,
  FamilyCommunicationsError,
  type FamilyWeekItemKind,
  type FamilyWeekOmissionCode,
  familySha256,
  isCoParentResponseState,
  isVoiceIntentKind,
  type RecordCoParentEventResult,
  requireFamilyInteger,
  requireFamilyText,
  requireFamilyTimestamp,
  type TrackCoParentMessageInput,
  type UnverifiedVoiceReason,
  type VoiceBundleAuthorizationState,
  type VoiceBundleIngestResult,
  type VoiceCandidateDecision,
  type VoiceIntentBundle,
  type VoiceIntentCandidateRevision,
  type VoiceIntentEffect,
} from "./types.js";

const FAMILY_COMMUNICATIONS_SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_voice_bundles (
     agent_id TEXT NOT NULL,
     bundle_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     transcript_sha256 TEXT NOT NULL,
     input_sha256 TEXT NOT NULL,
     principal_entity_id TEXT,
     authorization_state TEXT NOT NULL,
     quarantine_reason TEXT,
     captured_at TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, bundle_id),
     UNIQUE (agent_id, turn_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_family_voice_bundles_principal_idx
     ON app_lifeops.life_family_voice_bundles
       (agent_id, principal_entity_id, captured_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_voice_candidate_heads (
     agent_id TEXT NOT NULL,
     candidate_id TEXT NOT NULL,
     bundle_id TEXT NOT NULL,
     current_version INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, candidate_id),
     UNIQUE (agent_id, bundle_id, candidate_id)
   )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_voice_candidate_revisions (
     agent_id TEXT NOT NULL,
     candidate_id TEXT NOT NULL,
     bundle_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     content_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, candidate_id, version)
   )`,
  `CREATE INDEX IF NOT EXISTS life_family_voice_candidate_bundle_idx
     ON app_lifeops.life_family_voice_candidate_revisions
       (agent_id, bundle_id, candidate_id, version)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_coparent_communications (
     agent_id TEXT NOT NULL,
     communication_id TEXT NOT NULL,
     sent_by_entity_id TEXT NOT NULL,
     recipient_entity_id TEXT NOT NULL,
     child_subject_entity_ids_json TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     provider_message_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     state TEXT NOT NULL,
     accepted_at TEXT NOT NULL,
     delivered_at TEXT,
     read_at TEXT,
     replied_at TEXT,
     sla_due_at TEXT NOT NULL,
     watcher_task_id TEXT,
     version INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, communication_id),
     UNIQUE (agent_id, provider, provider_message_id),
     UNIQUE (agent_id, idempotency_key)
   )`,
  `CREATE INDEX IF NOT EXISTS life_family_coparent_pending_watcher_idx
     ON app_lifeops.life_family_coparent_communications
       (agent_id, watcher_task_id, state, sla_due_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_coparent_provider_events (
     agent_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     provider_event_id TEXT NOT NULL,
     communication_id TEXT NOT NULL,
     provider_message_id TEXT NOT NULL,
     state TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     actor_entity_id TEXT NOT NULL,
     in_reply_to_provider_message_id TEXT,
     content_sha256 TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, provider, provider_event_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_family_coparent_provider_events_message_idx
     ON app_lifeops.life_family_coparent_provider_events
       (agent_id, provider, provider_message_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_child_week_projections (
     agent_id TEXT NOT NULL,
     projection_id TEXT NOT NULL,
     principal_entity_id TEXT NOT NULL,
     child_entity_id TEXT NOT NULL,
     window_starts_at TEXT NOT NULL,
     window_ends_at TEXT NOT NULL,
     snapshot_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     generated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, projection_id),
     UNIQUE (
       agent_id, principal_entity_id, child_entity_id,
       window_starts_at, window_ends_at, snapshot_sha256
     )
   )`,
] as const;

const VOICE_EFFECTS: ReadonlySet<VoiceIntentEffect> = new Set([
  "read",
  "draft",
  "external_send",
  "external_mutation",
  "purchase",
  "sensitive_read",
]);

const VOICE_DECISIONS: ReadonlySet<VoiceCandidateDecision> = new Set([
  "proposed",
  "requires_explicit_approval",
  "blocked_scope",
  "blocked_private_scope",
]);

const VOICE_AUTH_STATES: ReadonlySet<VoiceBundleAuthorizationState> = new Set([
  "authorized",
  "quarantined",
]);

const QUARANTINE_REASONS: ReadonlySet<
  NonNullable<VoiceIntentBundle["quarantineReason"]>
> = new Set([
  "unknown_profile",
  "unbound_profile",
  "invalid_proof",
  "revoked_binding",
  "ambiguous_match",
  "speaker_not_enrolled",
  "binding_not_verified",
  "confidence_too_low",
  "principal_mismatch",
]);

function persistedInvalid(
  message: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new FamilyCommunicationsError(
    message,
    "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID",
    context,
    cause,
  );
}

function requiredRowText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    return persistedInvalid("Persisted family-communications text is invalid", {
      field,
    });
  }
  return value;
}

function optionalRowText(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    return persistedInvalid(
      "Persisted family-communications optional text is invalid",
      { field },
    );
  }
  return value;
}

function rowInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return persistedInvalid(
      "Persisted family-communications integer is invalid",
      { field, value },
    );
  }
  return parsed;
}

function parseStringArray(value: unknown, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseJsonArray<unknown>(value);
  } catch (error) {
    // error-policy:J3 persisted JSON is untrusted; corruption is explicit.
    return persistedInvalid(
      "Persisted family-communications JSON is malformed",
      { field },
      error,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    return persistedInvalid(
      "Persisted family-communications string array is invalid",
      { field },
    );
  }
  return parsed as string[];
}

function bundleFromRow(row: Record<string, unknown>): VoiceIntentBundle {
  const authorizationState = requiredRowText(
    row,
    "authorization_state",
  ) as VoiceBundleAuthorizationState;
  if (!VOICE_AUTH_STATES.has(authorizationState)) {
    return persistedInvalid("Persisted voice authorization state is invalid", {
      authorizationState,
    });
  }
  const rawReason = optionalRowText(row, "quarantine_reason");
  const quarantineReason = rawReason as
    | UnverifiedVoiceReason
    | "speaker_not_enrolled"
    | "binding_not_verified"
    | "confidence_too_low"
    | "principal_mismatch"
    | null;
  if (
    (authorizationState === "authorized" && quarantineReason !== null) ||
    (authorizationState === "quarantined" &&
      (quarantineReason === null || !QUARANTINE_REASONS.has(quarantineReason)))
  ) {
    return persistedInvalid(
      "Persisted voice quarantine state is inconsistent",
      {
        authorizationState,
        quarantineReason,
      },
    );
  }
  return {
    bundleId: requiredRowText(row, "bundle_id"),
    turnId: requiredRowText(row, "turn_id"),
    transcriptSha256: requiredRowText(row, "transcript_sha256"),
    inputSha256: requiredRowText(row, "input_sha256"),
    principalEntityId: optionalRowText(row, "principal_entity_id"),
    authorizationState,
    quarantineReason,
    capturedAt: requireFamilyTimestamp(
      requiredRowText(row, "captured_at"),
      "captured_at",
    ),
    createdAt: requireFamilyTimestamp(
      requiredRowText(row, "created_at"),
      "created_at",
    ),
  };
}

function candidateFromValue(value: unknown): VoiceIntentCandidateRevision {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = parseJsonValue<unknown>(value, null);
    } catch (error) {
      // error-policy:J3 persisted JSON is untrusted; corruption is explicit.
      return persistedInvalid(
        "Persisted voice candidate JSON is malformed",
        undefined,
        error,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return persistedInvalid("Persisted voice candidate is not an object");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    !isVoiceIntentKind(candidate.kind) ||
    !VOICE_EFFECTS.has(candidate.effect as VoiceIntentEffect) ||
    !VOICE_DECISIONS.has(candidate.decision as VoiceCandidateDecision)
  ) {
    return persistedInvalid("Persisted voice candidate enum is invalid");
  }
  const sourceSpan = candidate.sourceSpan;
  if (
    !sourceSpan ||
    typeof sourceSpan !== "object" ||
    Array.isArray(sourceSpan)
  ) {
    return persistedInvalid("Persisted voice candidate span is invalid");
  }
  const span = sourceSpan as Record<string, unknown>;
  const requiredScopes = candidate.requiredScopes;
  const validScopes = new Set([
    "household.visibility",
    "calendar.freebusy",
    "calendar.details",
    "calendar.mutate",
  ]);
  if (
    !Array.isArray(requiredScopes) ||
    requiredScopes.some(
      (scope) => typeof scope !== "string" || !validScopes.has(scope),
    )
  ) {
    return persistedInvalid("Persisted voice candidate scopes are invalid");
  }
  return {
    candidateId: requireFamilyText(candidate.candidateId, "candidateId", 200),
    bundleId: requireFamilyText(candidate.bundleId, "bundleId", 200),
    version: requireFamilyInteger(candidate.version, "version", 1),
    kind: candidate.kind,
    effect: candidate.effect as VoiceIntentEffect,
    summary: requireFamilyText(candidate.summary, "summary", 1_000),
    subjectEntityIds: parseStringArray(
      candidate.subjectEntityIds,
      "subjectEntityIds",
    ),
    requiredScopes:
      requiredScopes as VoiceIntentCandidateRevision["requiredScopes"],
    sourceSpan: {
      start: requireFamilyInteger(span.start, "sourceSpan.start"),
      end: requireFamilyInteger(span.end, "sourceSpan.end", 1),
      textSha256: requireFamilyText(
        span.textSha256,
        "sourceSpan.textSha256",
        64,
      ),
    },
    decision: candidate.decision as VoiceCandidateDecision,
    correctedByEntityId:
      candidate.correctedByEntityId === null
        ? null
        : requireFamilyText(
            candidate.correctedByEntityId,
            "correctedByEntityId",
            200,
          ),
    contentSha256: requireFamilyText(
      candidate.contentSha256,
      "contentSha256",
      64,
    ),
    createdAt: requireFamilyTimestamp(candidate.createdAt, "createdAt"),
  };
}

function communicationFromRow(
  row: Record<string, unknown>,
): CoParentCommunication {
  const state = requiredRowText(row, "state");
  if (!isCoParentResponseState(state)) {
    return persistedInvalid("Persisted co-parent response state is invalid", {
      state,
    });
  }
  return {
    communicationId: requiredRowText(row, "communication_id"),
    sentByEntityId: requiredRowText(row, "sent_by_entity_id"),
    recipientEntityId: requiredRowText(row, "recipient_entity_id"),
    childSubjectEntityIds: parseStringArray(
      row.child_subject_entity_ids_json,
      "child_subject_entity_ids_json",
    ),
    threadId: requiredRowText(row, "thread_id"),
    provider: requiredRowText(row, "provider"),
    providerMessageId: requiredRowText(row, "provider_message_id"),
    idempotencyKey: requiredRowText(row, "idempotency_key"),
    state,
    acceptedAt: requireFamilyTimestamp(
      requiredRowText(row, "accepted_at"),
      "accepted_at",
    ),
    deliveredAt: optionalRowText(row, "delivered_at"),
    readAt: optionalRowText(row, "read_at"),
    repliedAt: optionalRowText(row, "replied_at"),
    slaDueAt: requireFamilyTimestamp(
      requiredRowText(row, "sla_due_at"),
      "sla_due_at",
    ),
    watcherTaskId: optionalRowText(row, "watcher_task_id"),
    version: rowInteger(row, "version"),
    createdAt: requireFamilyTimestamp(
      requiredRowText(row, "created_at"),
      "created_at",
    ),
    updatedAt: requireFamilyTimestamp(
      requiredRowText(row, "updated_at"),
      "updated_at",
    ),
  };
}

function providerEventFromRow(
  row: Record<string, unknown>,
): CoParentProviderEvent {
  const state = requiredRowText(row, "state");
  if (!isCoParentResponseState(state)) {
    return persistedInvalid("Persisted provider event state is invalid", {
      state,
    });
  }
  return {
    providerEventId: requiredRowText(row, "provider_event_id"),
    provider: requiredRowText(row, "provider"),
    communicationId: requiredRowText(row, "communication_id"),
    providerMessageId: requiredRowText(row, "provider_message_id"),
    state,
    occurredAt: requireFamilyTimestamp(
      requiredRowText(row, "occurred_at"),
      "occurred_at",
    ),
    actorEntityId: requiredRowText(row, "actor_entity_id"),
    inReplyToProviderMessageId: optionalRowText(
      row,
      "in_reply_to_provider_message_id",
    ),
    contentSha256: requiredRowText(row, "content_sha256"),
    createdAt: requireFamilyTimestamp(
      requiredRowText(row, "created_at"),
      "created_at",
    ),
  };
}

async function selectCommunicationByProviderMessage(
  tx: TransactionalDb,
  agentId: string,
  provider: string,
  providerMessageId: string,
): Promise<CoParentCommunication | null> {
  const rows = await executeRawSqlTx(
    tx,
    `SELECT *
       FROM app_lifeops.life_family_coparent_communications
      WHERE agent_id = ${sqlQuote(agentId)}
        AND provider = ${sqlQuote(provider)}
        AND provider_message_id = ${sqlQuote(providerMessageId)}
      LIMIT 1`,
  );
  return rows[0] ? communicationFromRow(rows[0]) : null;
}

export class FamilyCommunicationsRepository {
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        for (const statement of FAMILY_COMMUNICATIONS_SCHEMA) {
          await executeRawSql(this.runtime, statement);
        }
      })();
    }
    return this.schemaReady;
  }

  private async currentCandidatesForBundle(
    bundleId: string,
  ): Promise<VoiceIntentCandidateRevision[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT revisions.value_json
         FROM app_lifeops.life_family_voice_candidate_heads heads
         JOIN app_lifeops.life_family_voice_candidate_revisions revisions
           ON revisions.agent_id = heads.agent_id
          AND revisions.candidate_id = heads.candidate_id
          AND revisions.version = heads.current_version
        WHERE heads.agent_id = ${sqlQuote(this.agentId)}
          AND heads.bundle_id = ${sqlQuote(bundleId)}
        ORDER BY heads.candidate_id`,
    );
    return rows.map((row) => candidateFromValue(row.value_json));
  }

  async getBundleByTurn(
    turnId: string,
  ): Promise<VoiceBundleIngestResult | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_family_voice_bundles
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND turn_id = ${sqlQuote(turnId)}
        LIMIT 1`,
    );
    if (!rows[0]) return null;
    const bundle = bundleFromRow(rows[0]);
    return {
      replayed: true,
      bundle,
      candidates:
        bundle.authorizationState === "authorized"
          ? await this.currentCandidatesForBundle(bundle.bundleId)
          : [],
    };
  }

  async insertVoiceBundle(
    bundle: VoiceIntentBundle,
    candidates: readonly VoiceIntentCandidateRevision[],
  ): Promise<VoiceBundleIngestResult> {
    await this.ensureSchema();
    const inserted = await withRequiredTransaction(this.runtime, async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_family_voice_bundles (
           agent_id, bundle_id, turn_id, transcript_sha256, input_sha256,
           principal_entity_id, authorization_state, quarantine_reason,
           captured_at, created_at
         ) VALUES (
           ${sqlQuote(this.agentId)},
           ${sqlQuote(bundle.bundleId)},
           ${sqlQuote(bundle.turnId)},
           ${sqlQuote(bundle.transcriptSha256)},
           ${sqlQuote(bundle.inputSha256)},
           ${bundle.principalEntityId === null ? "NULL" : sqlQuote(bundle.principalEntityId)},
           ${sqlQuote(bundle.authorizationState)},
           ${bundle.quarantineReason === null ? "NULL" : sqlQuote(bundle.quarantineReason)},
           ${sqlQuote(bundle.capturedAt)},
           ${sqlQuote(bundle.createdAt)}
         )
         ON CONFLICT DO NOTHING
         RETURNING *`,
      );
      if (!rows[0]) return false;
      for (const candidate of candidates) {
        await executeRawSqlTx(
          tx,
          `INSERT INTO app_lifeops.life_family_voice_candidate_revisions (
             agent_id, candidate_id, bundle_id, version, content_sha256,
             value_json, created_at
           ) VALUES (
             ${sqlQuote(this.agentId)},
             ${sqlQuote(candidate.candidateId)},
             ${sqlQuote(candidate.bundleId)},
             ${sqlInteger(candidate.version)},
             ${sqlQuote(candidate.contentSha256)},
             ${sqlJson(candidate)},
             ${sqlQuote(candidate.createdAt)}
           )`,
        );
        await executeRawSqlTx(
          tx,
          `INSERT INTO app_lifeops.life_family_voice_candidate_heads (
             agent_id, candidate_id, bundle_id, current_version, updated_at
           ) VALUES (
             ${sqlQuote(this.agentId)},
             ${sqlQuote(candidate.candidateId)},
             ${sqlQuote(candidate.bundleId)},
             ${sqlInteger(candidate.version)},
             ${sqlQuote(candidate.createdAt)}
           )`,
        );
      }
      return true;
    });
    if (inserted) {
      return { replayed: false, bundle, candidates: [...candidates] };
    }
    const existing = await this.getBundleByTurn(bundle.turnId);
    if (!existing) {
      throw new FamilyCommunicationsError(
        "Voice bundle insert conflicted without a retrievable winner",
        "FAMILY_COMMUNICATIONS_CONFLICT",
        { bundleId: bundle.bundleId, turnId: bundle.turnId },
      );
    }
    if (
      existing.bundle.inputSha256 !== bundle.inputSha256 ||
      existing.bundle.bundleId !== bundle.bundleId
    ) {
      throw new FamilyCommunicationsError(
        "Voice turn replay carries different bytes",
        "FAMILY_COMMUNICATIONS_CONFLICT",
        {
          turnId: bundle.turnId,
          existingBundleId: existing.bundle.bundleId,
          attemptedBundleId: bundle.bundleId,
        },
      );
    }
    return existing;
  }

  async getCurrentCandidate(
    candidateId: string,
  ): Promise<VoiceIntentCandidateRevision | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT revisions.value_json
         FROM app_lifeops.life_family_voice_candidate_heads heads
         JOIN app_lifeops.life_family_voice_candidate_revisions revisions
           ON revisions.agent_id = heads.agent_id
          AND revisions.candidate_id = heads.candidate_id
          AND revisions.version = heads.current_version
        WHERE heads.agent_id = ${sqlQuote(this.agentId)}
          AND heads.candidate_id = ${sqlQuote(candidateId)}
        LIMIT 1`,
    );
    return rows[0] ? candidateFromValue(rows[0].value_json) : null;
  }

  async getBundle(bundleId: string): Promise<VoiceIntentBundle | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_family_voice_bundles
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND bundle_id = ${sqlQuote(bundleId)}
        LIMIT 1`,
    );
    return rows[0] ? bundleFromRow(rows[0]) : null;
  }

  async appendCandidateCorrection(
    revision: VoiceIntentCandidateRevision,
    expectedVersion: number,
  ): Promise<VoiceIntentCandidateRevision> {
    await this.ensureSchema();
    return withRequiredTransaction(this.runtime, async (tx) => {
      const heads = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_family_voice_candidate_heads
            SET current_version = ${sqlInteger(revision.version)},
                updated_at = ${sqlQuote(revision.createdAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND candidate_id = ${sqlQuote(revision.candidateId)}
            AND bundle_id = ${sqlQuote(revision.bundleId)}
            AND current_version = ${sqlInteger(expectedVersion)}
        RETURNING candidate_id`,
      );
      if (!heads[0]) {
        throw new FamilyCommunicationsError(
          "Voice candidate changed concurrently",
          "FAMILY_COMMUNICATIONS_CONFLICT",
          { candidateId: revision.candidateId, expectedVersion },
        );
      }
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_family_voice_candidate_revisions (
           agent_id, candidate_id, bundle_id, version, content_sha256,
           value_json, created_at
         ) VALUES (
           ${sqlQuote(this.agentId)},
           ${sqlQuote(revision.candidateId)},
           ${sqlQuote(revision.bundleId)},
           ${sqlInteger(revision.version)},
           ${sqlQuote(revision.contentSha256)},
           ${sqlJson(revision)},
           ${sqlQuote(revision.createdAt)}
         )`,
      );
      return revision;
    });
  }

  async insertCommunication(
    input: TrackCoParentMessageInput,
    slaDueAt: string,
    createdAt: string,
  ): Promise<CoParentCommunication> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_family_coparent_communications (
         agent_id, communication_id, sent_by_entity_id, recipient_entity_id,
         child_subject_entity_ids_json, thread_id, provider,
         provider_message_id, idempotency_key, state, accepted_at,
         delivered_at, read_at, replied_at, sla_due_at, watcher_task_id,
         version, created_at, updated_at
       ) VALUES (
         ${sqlQuote(this.agentId)},
         ${sqlQuote(input.communicationId)},
         ${sqlQuote(input.sentByEntityId)},
         ${sqlQuote(input.recipientEntityId)},
         ${sqlJson(input.childSubjectEntityIds)},
         ${sqlQuote(input.threadId)},
         ${sqlQuote(input.receipt.provider)},
         ${sqlQuote(input.receipt.providerMessageId)},
         ${sqlQuote(input.receipt.idempotencyKey)},
         'accepted',
         ${sqlQuote(input.receipt.acceptedAt)},
         NULL, NULL, NULL,
         ${sqlQuote(slaDueAt)},
         NULL, 1,
         ${sqlQuote(createdAt)},
         ${sqlQuote(createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) return communicationFromRow(rows[0]);
    const existing = await this.getCommunication(input.communicationId);
    if (
      !existing ||
      existing.provider !== input.receipt.provider ||
      existing.providerMessageId !== input.receipt.providerMessageId ||
      existing.idempotencyKey !== input.receipt.idempotencyKey ||
      existing.sentByEntityId !== input.sentByEntityId ||
      existing.recipientEntityId !== input.recipientEntityId ||
      existing.threadId !== input.threadId ||
      existing.acceptedAt !== input.receipt.acceptedAt ||
      existing.slaDueAt !== slaDueAt ||
      familySha256(existing.childSubjectEntityIds) !==
        familySha256(input.childSubjectEntityIds)
    ) {
      throw new FamilyCommunicationsError(
        "Co-parent communication identity conflicts with an existing row",
        "FAMILY_COMMUNICATIONS_CONFLICT",
        { communicationId: input.communicationId },
      );
    }
    return existing;
  }

  async getCommunication(
    communicationId: string,
  ): Promise<CoParentCommunication | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_family_coparent_communications
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND communication_id = ${sqlQuote(communicationId)}
        LIMIT 1`,
    );
    return rows[0] ? communicationFromRow(rows[0]) : null;
  }

  async listCommunicationsMissingWatchers(): Promise<CoParentCommunication[]> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_family_coparent_communications
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND watcher_task_id IS NULL
          AND state <> 'replied'
        ORDER BY accepted_at`,
    );
    return rows.map(communicationFromRow);
  }

  async attachWatcher(
    communicationId: string,
    watcherTaskId: string,
    updatedAt: string,
  ): Promise<CoParentCommunication> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_family_coparent_communications
          SET watcher_task_id = ${sqlQuote(watcherTaskId)},
              version = version + 1,
              updated_at = ${sqlQuote(updatedAt)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND communication_id = ${sqlQuote(communicationId)}
          AND watcher_task_id IS NULL
      RETURNING *`,
    );
    if (rows[0]) return communicationFromRow(rows[0]);
    const existing = await this.getCommunication(communicationId);
    if (!existing) {
      throw new FamilyCommunicationsError(
        "Co-parent communication disappeared while attaching its watcher",
        "FAMILY_COMMUNICATIONS_CONFLICT",
        { communicationId },
      );
    }
    if (existing.watcherTaskId !== watcherTaskId) {
      throw new FamilyCommunicationsError(
        "Co-parent communication already points at a different watcher",
        "FAMILY_COMMUNICATIONS_CONFLICT",
        {
          communicationId,
          existingWatcherTaskId: existing.watcherTaskId,
          attemptedWatcherTaskId: watcherTaskId,
        },
      );
    }
    return existing;
  }

  async recordProviderEvent(
    input: CoParentProviderEventInput,
    createdAt: string,
  ): Promise<RecordCoParentEventResult> {
    await this.ensureSchema();
    const contentSha256 = familySha256(input);
    return withRequiredTransaction(this.runtime, async (tx) => {
      const communication = await selectCommunicationByProviderMessage(
        tx,
        this.agentId,
        input.provider,
        input.providerMessageId,
      );
      if (!communication) {
        throw new FamilyCommunicationsError(
          "Provider event does not match a tracked co-parent message",
          "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
          {
            provider: input.provider,
            providerMessageId: input.providerMessageId,
          },
        );
      }
      if (
        (input.state === "read" || input.state === "replied") &&
        input.actorEntityId !== communication.recipientEntityId
      ) {
        throw new FamilyCommunicationsError(
          "Read and reply events must name the exact co-parent recipient",
          "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
          {
            communicationId: communication.communicationId,
            actorEntityId: input.actorEntityId,
            recipientEntityId: communication.recipientEntityId,
          },
        );
      }
      if (Date.parse(input.occurredAt) < Date.parse(communication.acceptedAt)) {
        throw new FamilyCommunicationsError(
          "Provider event predates the accepted outbound message",
          "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
          {
            communicationId: communication.communicationId,
            acceptedAt: communication.acceptedAt,
            occurredAt: input.occurredAt,
          },
        );
      }
      if (
        input.state === "replied" &&
        input.inReplyToProviderMessageId !== communication.providerMessageId
      ) {
        throw new FamilyCommunicationsError(
          "Reply event is not correlated to the exact outbound message",
          "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
          {
            communicationId: communication.communicationId,
            inReplyToProviderMessageId: input.inReplyToProviderMessageId,
          },
        );
      }
      const insertedRows = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_family_coparent_provider_events (
           agent_id, provider, provider_event_id, communication_id,
           provider_message_id, state, occurred_at, actor_entity_id,
           in_reply_to_provider_message_id, content_sha256, created_at
         ) VALUES (
           ${sqlQuote(this.agentId)},
           ${sqlQuote(input.provider)},
           ${sqlQuote(input.providerEventId)},
           ${sqlQuote(communication.communicationId)},
           ${sqlQuote(input.providerMessageId)},
           ${sqlQuote(input.state)},
           ${sqlQuote(input.occurredAt)},
           ${sqlQuote(input.actorEntityId)},
           ${
             input.inReplyToProviderMessageId === null
               ? "NULL"
               : sqlQuote(input.inReplyToProviderMessageId)
},
           ${sqlQuote(contentSha256)},
           ${sqlQuote(createdAt)}
         )
         ON CONFLICT (agent_id, provider, provider_event_id) DO NOTHING
         RETURNING *`,
      );
      if (!insertedRows[0]) {
        const existingRows = await executeRawSqlTx(
          tx,
          `SELECT *
             FROM app_lifeops.life_family_coparent_provider_events
            WHERE agent_id = ${sqlQuote(this.agentId)}
              AND provider = ${sqlQuote(input.provider)}
              AND provider_event_id = ${sqlQuote(input.providerEventId)}
            LIMIT 1`,
        );
        if (!existingRows[0]) {
          throw new FamilyCommunicationsError(
            "Provider-event replay conflicted without a retrievable winner",
            "FAMILY_COMMUNICATIONS_CONFLICT",
            { providerEventId: input.providerEventId },
          );
        }
        const existingEvent = providerEventFromRow(existingRows[0]);
        if (existingEvent.contentSha256 !== contentSha256) {
          throw new FamilyCommunicationsError(
            "Provider-event ID replay carries different bytes",
            "FAMILY_COMMUNICATIONS_CONFLICT",
            { providerEventId: input.providerEventId },
          );
        }
        const current = await selectCommunicationByProviderMessage(
          tx,
          this.agentId,
          input.provider,
          input.providerMessageId,
        );
        if (!current) {
          throw new FamilyCommunicationsError(
            "Tracked communication disappeared during provider-event replay",
            "FAMILY_COMMUNICATIONS_CONFLICT",
            { communicationId: communication.communicationId },
          );
        }
        return {
          inserted: false,
          event: existingEvent,
          communication: current,
        };
      }
      const nextState =
        coParentStateRank(input.state) > coParentStateRank(communication.state)
          ? input.state
          : communication.state;
      const deliveredAt =
        input.state === "delivered"
          ? input.occurredAt
          : communication.deliveredAt;
      const readAt =
        input.state === "read" ? input.occurredAt : communication.readAt;
      const repliedAt =
        input.state === "replied" ? input.occurredAt : communication.repliedAt;
      const updatedRows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_family_coparent_communications
            SET state = ${sqlQuote(nextState)},
                delivered_at = ${
                  deliveredAt === null ? "NULL" : sqlQuote(deliveredAt)
                },
                read_at = ${readAt === null ? "NULL" : sqlQuote(readAt)},
                replied_at = ${
                  repliedAt === null ? "NULL" : sqlQuote(repliedAt)
                },
                version = version + 1,
                updated_at = ${sqlQuote(createdAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND communication_id = ${sqlQuote(communication.communicationId)}
            AND version = ${sqlInteger(communication.version)}
        RETURNING *`,
      );
      if (!updatedRows[0]) {
        throw new FamilyCommunicationsError(
          "Co-parent response state changed concurrently",
          "FAMILY_COMMUNICATIONS_CONFLICT",
          {
            communicationId: communication.communicationId,
            expectedVersion: communication.version,
          },
        );
      }
      return {
        inserted: true,
        event: providerEventFromRow(insertedRows[0]),
        communication: communicationFromRow(updatedRows[0]),
      };
    });
  }

  async saveChildWeekProjection(
    projection: ChildWeekProjection,
  ): Promise<ChildWeekProjection> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_family_child_week_projections (
         agent_id, projection_id, principal_entity_id, child_entity_id,
         window_starts_at, window_ends_at, snapshot_sha256, value_json,
         generated_at
       ) VALUES (
         ${sqlQuote(this.agentId)},
         ${sqlQuote(projection.projectionId)},
         ${sqlQuote(projection.principalEntityId)},
         ${sqlQuote(projection.childEntityId)},
         ${sqlQuote(projection.windowStartsAt)},
         ${sqlQuote(projection.windowEndsAt)},
         ${sqlQuote(projection.snapshotSha256)},
         ${sqlJson(projection)},
         ${sqlQuote(projection.generatedAt)}
       )
       ON CONFLICT (
         agent_id, principal_entity_id, child_entity_id,
         window_starts_at, window_ends_at, snapshot_sha256
       ) DO NOTHING
       RETURNING value_json`,
    );
    if (rows[0]) return projection;
    const existingRows = await executeRawSql(
      this.runtime,
      `SELECT value_json
         FROM app_lifeops.life_family_child_week_projections
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND principal_entity_id = ${sqlQuote(projection.principalEntityId)}
          AND child_entity_id = ${sqlQuote(projection.childEntityId)}
          AND window_starts_at = ${sqlQuote(projection.windowStartsAt)}
          AND window_ends_at = ${sqlQuote(projection.windowEndsAt)}
          AND snapshot_sha256 = ${sqlQuote(projection.snapshotSha256)}
        LIMIT 1`,
    );
    if (!existingRows[0]) {
      throw new FamilyCommunicationsError(
        "Child-week projection conflicted without a retrievable winner",
        "FAMILY_COMMUNICATIONS_CONFLICT",
        { projectionId: projection.projectionId },
      );
    }
    return childProjectionFromValue(existingRows[0].value_json);
  }
}

function childProjectionFromValue(value: unknown): ChildWeekProjection {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = parseJsonValue<unknown>(value, null);
    } catch (error) {
      // error-policy:J3 persisted JSON is untrusted; corruption is explicit.
      return persistedInvalid(
        "Persisted child-week projection JSON is malformed",
        undefined,
        error,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return persistedInvalid("Persisted child-week projection is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.items)) {
    return persistedInvalid("Persisted child-week item list is invalid");
  }
  const items = record.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return persistedInvalid("Persisted child-week item is invalid");
    }
    const entry = item as Record<string, unknown>;
    const kind = entry.kind;
    if (
      typeof kind !== "string" ||
      !FAMILY_WEEK_ITEM_KINDS.includes(kind as FamilyWeekItemKind) ||
      [
        "adult_work",
        "finance",
        "medical",
        "relationship",
        "adult_private",
        "teen_private",
      ].includes(kind)
    ) {
      return persistedInvalid("Persisted child-week item kind is unsafe");
    }
    return {
      itemId: requireFamilyText(entry.itemId, "itemId", 200),
      kind: kind as ChildWeekProjection["items"][number]["kind"],
      title: requireFamilyText(entry.title, "title", 1_000),
      startsAt:
        entry.startsAt === null
          ? null
          : requireFamilyTimestamp(entry.startsAt, "startsAt"),
      endsAt:
        entry.endsAt === null
          ? null
          : requireFamilyTimestamp(entry.endsAt, "endsAt"),
      location:
        entry.location === null
          ? null
          : requireFamilyText(entry.location, "location", 500),
      sourceRef: requireFamilyText(entry.sourceRef, "sourceRef", 500),
    };
  });
  const omissions = record.omissions;
  if (!omissions || typeof omissions !== "object" || Array.isArray(omissions)) {
    return persistedInvalid("Persisted child-week omission counts are invalid");
  }
  const omissionRecord = omissions as Record<string, unknown>;
  const omissionCodes: FamilyWeekOmissionCode[] = [
    "not_for_child",
    "principal_not_in_audience",
    "not_household_shared",
    "adult_or_private_kind",
    "sensitive_data_class",
  ];
  const parsedOmissions = Object.fromEntries(
    omissionCodes.map((code) => [
      code,
      requireFamilyInteger(omissionRecord[code], `omissions.${code}`),
    ]),
  ) as Record<FamilyWeekOmissionCode, number>;
  return {
    projectionId: requireFamilyText(record.projectionId, "projectionId", 200),
    principalEntityId: requireFamilyText(
      record.principalEntityId,
      "principalEntityId",
      200,
    ),
    childEntityId: requireFamilyText(
      record.childEntityId,
      "childEntityId",
      200,
    ),
    windowStartsAt: requireFamilyTimestamp(
      record.windowStartsAt,
      "windowStartsAt",
    ),
    windowEndsAt: requireFamilyTimestamp(record.windowEndsAt, "windowEndsAt"),
    items,
    omissions: parsedOmissions,
    snapshotSha256: requireFamilyText(
      record.snapshotSha256,
      "snapshotSha256",
      64,
    ),
    generatedAt: requireFamilyTimestamp(record.generatedAt, "generatedAt"),
  };
}

export function newFamilyProjectionId(): string {
  return `family_week_${randomUUID()}`;
}

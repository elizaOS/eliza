/**
 * Durable canonical-identity authority tables for account-scoped claims,
 * authenticated person-link evidence, non-destructive principal redirects,
 * and reversible merge/split journals. These tables preserve provenance
 * independently from legacy entity metadata while keeping OWNER authority
 * tied to an explicit binding.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { authOwnerBindingTable } from "./authOwnerBinding";
import { connectorAccountsTable } from "./connectorAccounts";
import { entityTable } from "./entity";

export const identityClaimTable = pgTable(
  "identity_claims",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    agentId: uuid("agent_id").notNull(),
    principalEntityId: uuid("principal_entity_id").notNull(),
    namespace: text("namespace").notNull(),
    connectorId: text("connector_id").notNull(),
    connectorAccountId: uuid("connector_account_id").notNull(),
    externalSubjectId: text("external_subject_id").notNull(),
    handle: text("handle"),
    displayName: text("display_name"),
    verification: text("verification").notNull().default("unverified"),
    ownerBindingId: text("owner_binding_id"),
    status: text("status").notNull().default("active"),
    confidence: real("confidence").notNull().default(0),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().default(sql`now()`),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("identity_claim_active_scope_subject_unique")
      .on(
        table.agentId,
        table.namespace,
        table.connectorId,
        table.connectorAccountId,
        table.externalSubjectId
      )
      .where(sql`${table.status} = 'active'`),
    index("identity_claim_principal_idx").on(table.agentId, table.principalEntityId),
    index("identity_claim_lookup_idx").on(
      table.agentId,
      table.namespace,
      table.connectorId,
      table.connectorAccountId,
      table.externalSubjectId
    ),
    index("identity_claim_status_idx").on(table.agentId, table.status),
    foreignKey({
      name: "fk_identity_claim_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_identity_claim_principal",
      columns: [table.principalEntityId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_claim_connector_account",
      columns: [table.connectorAccountId, table.agentId],
      foreignColumns: [connectorAccountsTable.id, connectorAccountsTable.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_claim_owner_binding",
      columns: [table.ownerBindingId],
      foreignColumns: [authOwnerBindingTable.id],
    }).onDelete("restrict"),
    check(
      "identity_claim_verification_check",
      sql`${table.verification} IN ('unverified', 'observed', 'verified', 'owner_bound')`
    ),
    check(
      "identity_claim_status_check",
      sql`${table.status} IN ('active', 'revoked', 'superseded', 'disputed')`
    ),
    check(
      "identity_claim_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`
    ),
    check(
      "identity_claim_owner_binding_check",
      sql`${table.verification} <> 'owner_bound' OR (${table.ownerBindingId} IS NOT NULL AND ${table.verifiedAt} IS NOT NULL)`
    ),
  ]
);

export const identityAuthorityStateTable = pgTable(
  "identity_authority_state",
  {
    agentId: uuid("agent_id").primaryKey().notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    foreignKey({
      name: "fk_identity_authority_state_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    check("identity_authority_state_generation_check", sql`${table.generation} >= 0`),
  ]
);

export const identityPersonLinkAttestationTable = pgTable(
  "identity_person_link_attestations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    agentId: uuid("agent_id").notNull(),
    leftPrincipalId: uuid("left_principal_id").notNull(),
    rightPrincipalId: uuid("right_principal_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    actorRole: text("actor_role").notNull(),
    authority: text("authority").notNull(),
    transport: text("transport").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    expectedGeneration: bigint("expected_generation", { mode: "number" }).notNull(),
    committedGeneration: bigint("committed_generation", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    unique("identity_person_link_attestation_idempotency_unique").on(
      table.agentId,
      table.idempotencyKey
    ),
    index("identity_person_link_attestation_pair_idx").on(
      table.agentId,
      table.leftPrincipalId,
      table.rightPrincipalId,
      table.createdAt
    ),
    foreignKey({
      name: "fk_identity_person_link_attestation_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_identity_person_link_attestation_left",
      columns: [table.leftPrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_person_link_attestation_right",
      columns: [table.rightPrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_person_link_attestation_actor",
      columns: [table.actorPrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    check(
      "identity_person_link_attestation_order_check",
      sql`${table.leftPrincipalId} < ${table.rightPrincipalId}`
    ),
    check(
      "identity_person_link_attestation_actor_role_check",
      sql`${table.actorRole} IN ('OWNER', 'ADMIN')`
    ),
    check(
      "identity_person_link_attestation_authority_check",
      sql`${table.authority} = 'authenticated_private_route'`
    ),
    check(
      "identity_person_link_attestation_transport_check",
      sql`${table.transport} IN ('http', 'in_process')`
    ),
    check(
      "identity_person_link_attestation_generation_check",
      sql`${table.expectedGeneration} >= 0 AND ${table.committedGeneration} = ${table.expectedGeneration} + 1`
    ),
    check("identity_person_link_attestation_reason_check", sql`length(trim(${table.reason})) > 0`),
    check(
      "identity_person_link_attestation_idempotency_check",
      sql`length(trim(${table.idempotencyKey})) > 0`
    ),
  ]
);

export const identityMergeJournalTable = pgTable(
  "identity_merge_journal",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    agentId: uuid("agent_id").notNull(),
    operation: text("operation").notNull(),
    status: text("status").notNull().default("planned"),
    parentJournalId: uuid("parent_journal_id"),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    canonicalPrincipalId: uuid("canonical_principal_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    commitIdempotencyKey: text("commit_idempotency_key"),
    commitRequestDigest: text("commit_request_digest"),
    planDigest: text("plan_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    expectedGeneration: bigint("expected_generation", { mode: "number" }).notNull(),
    sourcePrincipalIds: jsonb("source_principal_ids").$type<string[]>().notNull(),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    beforeState: jsonb("before_state").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("identity_merge_journal_agent_status_idx").on(table.agentId, table.status),
    index("identity_merge_journal_canonical_idx").on(table.agentId, table.canonicalPrincipalId),
    index("identity_merge_journal_parent_idx").on(table.parentJournalId),
    uniqueIndex("identity_merge_journal_commit_idempotency_unique")
      .on(table.agentId, table.commitIdempotencyKey)
      .where(sql`${table.commitIdempotencyKey} IS NOT NULL`),
    unique("identity_merge_journal_idempotency_unique").on(
      table.agentId,
      table.operation,
      table.idempotencyKey
    ),
    unique("identity_merge_journal_id_agent_unique").on(table.id, table.agentId),
    foreignKey({
      name: "fk_identity_merge_journal_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_identity_merge_journal_parent",
      columns: [table.parentJournalId, table.agentId],
      foreignColumns: [table.id, table.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_merge_journal_actor",
      columns: [table.actorPrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_merge_journal_canonical",
      columns: [table.canonicalPrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    check("identity_merge_journal_operation_check", sql`${table.operation} IN ('merge', 'split')`),
    check(
      "identity_merge_journal_status_check",
      sql`${table.status} IN ('planned', 'committed', 'completed', 'reverted', 'failed')`
    ),
    check("identity_merge_journal_generation_check", sql`${table.expectedGeneration} >= 0`),
    check("identity_merge_journal_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ]
);

export const identityMergeConfirmationTable = pgTable(
  "identity_merge_confirmations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    agentId: uuid("agent_id").notNull(),
    journalId: uuid("journal_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    planDigest: text("plan_digest").notNull(),
    expectedGeneration: bigint("expected_generation", { mode: "number" }).notNull(),
    status: text("status").notNull().default("active"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    unique("identity_merge_confirmation_journal_unique").on(table.agentId, table.journalId),
    index("identity_merge_confirmation_expiry_idx").on(table.status, table.expiresAt),
    foreignKey({
      name: "fk_identity_merge_confirmation_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_identity_merge_confirmation_journal",
      columns: [table.journalId, table.agentId],
      foreignColumns: [identityMergeJournalTable.id, identityMergeJournalTable.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_merge_confirmation_actor",
      columns: [table.actorPrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    check(
      "identity_merge_confirmation_status_check",
      sql`${table.status} IN ('active', 'consumed', 'expired', 'revoked')`
    ),
    check("identity_merge_confirmation_generation_check", sql`${table.expectedGeneration} >= 0`),
    check("identity_merge_confirmation_time_check", sql`${table.expiresAt} > ${table.confirmedAt}`),
    check(
      "identity_merge_confirmation_consumed_check",
      sql`(${table.status} = 'consumed' AND ${table.consumedAt} IS NOT NULL) OR (${table.status} <> 'consumed' AND ${table.consumedAt} IS NULL)`
    ),
  ]
);

export const identityCanonicalRedirectTable = pgTable(
  "identity_canonical_redirects",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    agentId: uuid("agent_id").notNull(),
    sourcePrincipalId: uuid("source_principal_id").notNull(),
    canonicalPrincipalId: uuid("canonical_principal_id").notNull(),
    mergeJournalId: uuid("merge_journal_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => [
    unique("identity_canonical_redirect_version_unique").on(
      table.agentId,
      table.sourcePrincipalId,
      table.version
    ),
    uniqueIndex("identity_canonical_redirect_active_unique")
      .on(table.agentId, table.sourcePrincipalId)
      .where(sql`${table.status} = 'active'`),
    index("identity_canonical_redirect_target_idx").on(
      table.agentId,
      table.canonicalPrincipalId,
      table.status
    ),
    index("identity_redirect_journal_idx").on(table.agentId, table.mergeJournalId, table.status),
    foreignKey({
      name: "fk_identity_canonical_redirect_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_identity_canonical_redirect_source",
      columns: [table.sourcePrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_canonical_redirect_target",
      columns: [table.canonicalPrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_identity_canonical_redirect_journal",
      columns: [table.mergeJournalId, table.agentId],
      foreignColumns: [identityMergeJournalTable.id, identityMergeJournalTable.agentId],
    }).onDelete("restrict"),
    check(
      "identity_canonical_redirect_status_check",
      sql`${table.status} IN ('active', 'superseded', 'reverted')`
    ),
    check(
      "identity_canonical_redirect_distinct_check",
      sql`${table.sourcePrincipalId} <> ${table.canonicalPrincipalId}`
    ),
    check("identity_canonical_redirect_version_check", sql`${table.version} > 0`),
  ]
);

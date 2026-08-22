/**
 * Portable descriptors for the canonical identity authority: account-scoped
 * claims, generation fencing, durable confirmations, reversible merge/split
 * journals, and non-destructive redirects. Adapters materialize these tables
 * without making authorization depend on lossy entity rewrites.
 */

import type { SchemaTable } from "../types/schema.ts";

const agentForeignKey = (
	name: string,
	tableFrom: string,
): SchemaTable["foreignKeys"][string] => ({
	name,
	tableFrom,
	tableTo: "agents",
	columnsFrom: ["agent_id"],
	columnsTo: ["id"],
	onDelete: "cascade",
	schemaTo: "",
});

export const identityClaimSchema: SchemaTable = {
	name: "identity_claims",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: { name: "agent_id", type: "uuid", notNull: true },
		principal_entity_id: {
			name: "principal_entity_id",
			type: "uuid",
			notNull: true,
		},
		namespace: { name: "namespace", type: "text", notNull: true },
		connector_id: { name: "connector_id", type: "text", notNull: true },
		connector_account_id: {
			name: "connector_account_id",
			type: "uuid",
			notNull: true,
		},
		external_subject_id: {
			name: "external_subject_id",
			type: "text",
			notNull: true,
		},
		handle: { name: "handle", type: "text" },
		display_name: { name: "display_name", type: "text" },
		verification: {
			name: "verification",
			type: "text",
			notNull: true,
			default: "'unverified'",
		},
		owner_binding_id: { name: "owner_binding_id", type: "text" },
		verification_authority_kind: {
			name: "verification_authority_kind",
			type: "text",
		},
		verification_authority_id: {
			name: "verification_authority_id",
			type: "text",
		},
		status: {
			name: "status",
			type: "text",
			notNull: true,
			default: "'active'",
		},
		confidence: {
			name: "confidence",
			type: "real",
			notNull: true,
			default: 0,
		},
		version: { name: "version", type: "bigint", notNull: true, default: 1 },
		provenance: {
			name: "provenance",
			type: "jsonb",
			notNull: true,
			default: "'{}'::jsonb",
		},
		evidence: {
			name: "evidence",
			type: "jsonb",
			notNull: true,
			default: "'{}'::jsonb",
		},
		first_seen_at: {
			name: "first_seen_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		last_seen_at: {
			name: "last_seen_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		verified_at: { name: "verified_at", type: "timestamp" },
		revoked_at: { name: "revoked_at", type: "timestamp" },
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		updated_at: {
			name: "updated_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {
		identity_claim_active_scope_subject_unique: {
			name: "identity_claim_active_scope_subject_unique",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "namespace", isExpression: false },
				{ expression: "connector_id", isExpression: false },
				{ expression: "connector_account_id", isExpression: false },
				{ expression: "external_subject_id", isExpression: false },
			],
			isUnique: true,
			where: "status = 'active'",
		},
		identity_claim_principal_idx: {
			name: "identity_claim_principal_idx",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "principal_entity_id", isExpression: false },
			],
			isUnique: false,
		},
		identity_claim_lookup_idx: {
			name: "identity_claim_lookup_idx",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "namespace", isExpression: false },
				{ expression: "connector_id", isExpression: false },
				{ expression: "connector_account_id", isExpression: false },
				{ expression: "external_subject_id", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_identity_claim_agent: agentForeignKey(
			"fk_identity_claim_agent",
			"identity_claims",
		),
		fk_identity_claim_principal: {
			name: "fk_identity_claim_principal",
			tableFrom: "identity_claims",
			tableTo: "entities",
			columnsFrom: ["principal_entity_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
		fk_identity_claim_connector_account: {
			name: "fk_identity_claim_connector_account",
			tableFrom: "identity_claims",
			tableTo: "connector_accounts",
			columnsFrom: ["connector_account_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
		fk_identity_claim_owner_binding: {
			name: "fk_identity_claim_owner_binding",
			tableFrom: "identity_claims",
			tableTo: "auth_owner_bindings",
			columnsFrom: ["owner_binding_id"],
			columnsTo: ["id"],
			onDelete: "restrict",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		identity_claim_id_agent_unique: {
			name: "identity_claim_id_agent_unique",
			columns: ["id", "agent_id"],
		},
	},
	checkConstraints: {
		identity_claim_verification_check: {
			name: "identity_claim_verification_check",
			value:
				"verification IN ('unverified', 'observed', 'verified', 'owner_bound')",
		},
		identity_claim_status_check: {
			name: "identity_claim_status_check",
			value: "status IN ('active', 'revoked', 'superseded', 'disputed')",
		},
		identity_claim_confidence_check: {
			name: "identity_claim_confidence_check",
			value: "confidence >= 0 AND confidence <= 1",
		},
		identity_claim_owner_binding_check: {
			name: "identity_claim_owner_binding_check",
			value:
				"verification <> 'owner_bound' OR (owner_binding_id IS NOT NULL AND verified_at IS NOT NULL)",
		},
		identity_claim_version_check: {
			name: "identity_claim_version_check",
			value: "version > 0",
		},
	},
};

export const identityClaimJournalSchema: SchemaTable = {
	name: "identity_claim_journal",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: { name: "agent_id", type: "uuid", notNull: true },
		claim_id: { name: "claim_id", type: "uuid", notNull: true },
		principal_entity_id: {
			name: "principal_entity_id",
			type: "uuid",
			notNull: true,
		},
		event_kind: { name: "event_kind", type: "text", notNull: true },
		prior_version: { name: "prior_version", type: "bigint" },
		resulting_version: {
			name: "resulting_version",
			type: "bigint",
			notNull: true,
		},
		actor_principal_id: {
			name: "actor_principal_id",
			type: "uuid",
			notNull: true,
		},
		idempotency_key: { name: "idempotency_key", type: "text", notNull: true },
		request_digest: { name: "request_digest", type: "text", notNull: true },
		reason: { name: "reason", type: "text", notNull: true },
		provenance: {
			name: "provenance",
			type: "jsonb",
			notNull: true,
			default: "'{}'::jsonb",
		},
		evidence: {
			name: "evidence",
			type: "jsonb",
			notNull: true,
			default: "'{}'::jsonb",
		},
		before_claim: { name: "before_claim", type: "jsonb" },
		after_claim: { name: "after_claim", type: "jsonb", notNull: true },
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {
		identity_claim_journal_claim_version_idx: {
			name: "identity_claim_journal_claim_version_idx",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "claim_id", isExpression: false },
				{ expression: "resulting_version", isExpression: false },
			],
			isUnique: true,
		},
		identity_claim_journal_agent_created_idx: {
			name: "identity_claim_journal_agent_created_idx",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "created_at", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_identity_claim_journal_agent: {
			name: "fk_identity_claim_journal_agent",
			tableFrom: "identity_claim_journal",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		identity_claim_journal_idempotency_unique: {
			name: "identity_claim_journal_idempotency_unique",
			columns: ["agent_id", "idempotency_key"],
		},
	},
	checkConstraints: {
		identity_claim_journal_event_check: {
			name: "identity_claim_journal_event_check",
			value:
				"event_kind IN ('observed', 'refreshed', 'verified', 'disputed', 'revoked')",
		},
		identity_claim_journal_version_check: {
			name: "identity_claim_journal_version_check",
			value:
				"resulting_version > 0 AND (prior_version IS NULL OR prior_version > 0)",
		},
	},
};

export const identityClaimRetentionLedgerSchema: SchemaTable = {
	name: "identity_claim_retention_ledger",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		event_kind: { name: "event_kind", type: "text", notNull: true },
		prior_version: { name: "prior_version", type: "bigint" },
		resulting_version: {
			name: "resulting_version",
			type: "bigint",
			notNull: true,
		},
	},
	indexes: {},
	foreignKeys: {},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {
		identity_claim_retention_ledger_event_check: {
			name: "identity_claim_retention_ledger_event_check",
			value:
				"event_kind IN ('observed', 'refreshed', 'verified', 'disputed', 'revoked')",
		},
		identity_claim_retention_ledger_version_check: {
			name: "identity_claim_retention_ledger_version_check",
			value:
				"resulting_version > 0 AND (prior_version IS NULL OR prior_version > 0)",
		},
	},
};

export const identityAuthorityStateSchema: SchemaTable = {
	name: "identity_authority_state",
	schema: "",
	columns: {
		agent_id: {
			name: "agent_id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		},
		generation: {
			name: "generation",
			type: "bigint",
			notNull: true,
			default: 0,
		},
		updated_at: {
			name: "updated_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {},
	foreignKeys: {
		fk_identity_authority_state_agent: agentForeignKey(
			"fk_identity_authority_state_agent",
			"identity_authority_state",
		),
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {
		identity_authority_state_generation_check: {
			name: "identity_authority_state_generation_check",
			value: "generation >= 0",
		},
	},
};

export const identityMergeJournalSchema: SchemaTable = {
	name: "identity_merge_journal",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: { name: "agent_id", type: "uuid", notNull: true },
		operation: { name: "operation", type: "text", notNull: true },
		status: {
			name: "status",
			type: "text",
			notNull: true,
			default: "'planned'",
		},
		parent_journal_id: { name: "parent_journal_id", type: "uuid" },
		actor_principal_id: {
			name: "actor_principal_id",
			type: "uuid",
			notNull: true,
		},
		canonical_principal_id: {
			name: "canonical_principal_id",
			type: "uuid",
			notNull: true,
		},
		idempotency_key: {
			name: "idempotency_key",
			type: "text",
			notNull: true,
		},
		request_digest: {
			name: "request_digest",
			type: "text",
			notNull: true,
		},
		commit_idempotency_key: {
			name: "commit_idempotency_key",
			type: "text",
		},
		commit_request_digest: {
			name: "commit_request_digest",
			type: "text",
		},
		plan_digest: { name: "plan_digest", type: "text", notNull: true },
		expires_at: { name: "expires_at", type: "timestamp", notNull: true },
		expected_generation: {
			name: "expected_generation",
			type: "bigint",
			notNull: true,
		},
		source_principal_ids: {
			name: "source_principal_ids",
			type: "jsonb",
			notNull: true,
		},
		plan: { name: "plan", type: "jsonb", notNull: true },
		before_state: { name: "before_state", type: "jsonb", notNull: true },
		result: { name: "result", type: "jsonb" },
		reason: { name: "reason", type: "text", notNull: true },
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		committed_at: { name: "committed_at", type: "timestamp" },
		completed_at: { name: "completed_at", type: "timestamp" },
	},
	indexes: {
		identity_merge_journal_agent_status_idx: {
			name: "identity_merge_journal_agent_status_idx",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "status", isExpression: false },
			],
			isUnique: false,
		},
		identity_merge_journal_parent_idx: {
			name: "identity_merge_journal_parent_idx",
			columns: [{ expression: "parent_journal_id", isExpression: false }],
			isUnique: false,
		},
		identity_merge_journal_commit_idempotency_unique: {
			name: "identity_merge_journal_commit_idempotency_unique",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "commit_idempotency_key", isExpression: false },
			],
			isUnique: true,
			where: "commit_idempotency_key IS NOT NULL",
		},
	},
	foreignKeys: {
		fk_identity_merge_journal_agent: agentForeignKey(
			"fk_identity_merge_journal_agent",
			"identity_merge_journal",
		),
		fk_identity_merge_journal_parent: {
			name: "fk_identity_merge_journal_parent",
			tableFrom: "identity_merge_journal",
			tableTo: "identity_merge_journal",
			columnsFrom: ["parent_journal_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
		fk_identity_merge_journal_actor: {
			name: "fk_identity_merge_journal_actor",
			tableFrom: "identity_merge_journal",
			tableTo: "entities",
			columnsFrom: ["actor_principal_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
		fk_identity_merge_journal_canonical: {
			name: "fk_identity_merge_journal_canonical",
			tableFrom: "identity_merge_journal",
			tableTo: "entities",
			columnsFrom: ["canonical_principal_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		identity_merge_journal_idempotency_unique: {
			name: "identity_merge_journal_idempotency_unique",
			columns: ["agent_id", "operation", "idempotency_key"],
		},
		identity_merge_journal_id_agent_unique: {
			name: "identity_merge_journal_id_agent_unique",
			columns: ["id", "agent_id"],
		},
	},
	checkConstraints: {
		identity_merge_journal_operation_check: {
			name: "identity_merge_journal_operation_check",
			value: "operation IN ('merge', 'split')",
		},
		identity_merge_journal_status_check: {
			name: "identity_merge_journal_status_check",
			value:
				"status IN ('planned', 'committed', 'completed', 'reverted', 'failed')",
		},
		identity_merge_journal_generation_check: {
			name: "identity_merge_journal_generation_check",
			value: "expected_generation >= 0",
		},
		identity_merge_journal_expiry_check: {
			name: "identity_merge_journal_expiry_check",
			value: "expires_at > created_at",
		},
	},
};

export const identityMergeConfirmationSchema: SchemaTable = {
	name: "identity_merge_confirmations",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: { name: "agent_id", type: "uuid", notNull: true },
		journal_id: { name: "journal_id", type: "uuid", notNull: true },
		actor_principal_id: {
			name: "actor_principal_id",
			type: "uuid",
			notNull: true,
		},
		plan_digest: { name: "plan_digest", type: "text", notNull: true },
		expected_generation: {
			name: "expected_generation",
			type: "bigint",
			notNull: true,
		},
		status: {
			name: "status",
			type: "text",
			notNull: true,
			default: "'active'",
		},
		confirmed_at: {
			name: "confirmed_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		expires_at: { name: "expires_at", type: "timestamp", notNull: true },
		consumed_at: { name: "consumed_at", type: "timestamp" },
	},
	indexes: {
		identity_merge_confirmation_expiry_idx: {
			name: "identity_merge_confirmation_expiry_idx",
			columns: [
				{ expression: "status", isExpression: false },
				{ expression: "expires_at", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_identity_merge_confirmation_agent: agentForeignKey(
			"fk_identity_merge_confirmation_agent",
			"identity_merge_confirmations",
		),
		fk_identity_merge_confirmation_journal: {
			name: "fk_identity_merge_confirmation_journal",
			tableFrom: "identity_merge_confirmations",
			tableTo: "identity_merge_journal",
			columnsFrom: ["journal_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
		fk_identity_merge_confirmation_actor: {
			name: "fk_identity_merge_confirmation_actor",
			tableFrom: "identity_merge_confirmations",
			tableTo: "entities",
			columnsFrom: ["actor_principal_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		identity_merge_confirmation_journal_unique: {
			name: "identity_merge_confirmation_journal_unique",
			columns: ["agent_id", "journal_id"],
		},
	},
	checkConstraints: {
		identity_merge_confirmation_status_check: {
			name: "identity_merge_confirmation_status_check",
			value: "status IN ('active', 'consumed', 'expired', 'revoked')",
		},
		identity_merge_confirmation_generation_check: {
			name: "identity_merge_confirmation_generation_check",
			value: "expected_generation >= 0",
		},
		identity_merge_confirmation_time_check: {
			name: "identity_merge_confirmation_time_check",
			value: "expires_at > confirmed_at",
		},
		identity_merge_confirmation_consumed_check: {
			name: "identity_merge_confirmation_consumed_check",
			value:
				"(status = 'consumed' AND consumed_at IS NOT NULL) OR (status <> 'consumed' AND consumed_at IS NULL)",
		},
	},
};

export const identityCanonicalRedirectSchema: SchemaTable = {
	name: "identity_canonical_redirects",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: { name: "agent_id", type: "uuid", notNull: true },
		source_principal_id: {
			name: "source_principal_id",
			type: "uuid",
			notNull: true,
		},
		canonical_principal_id: {
			name: "canonical_principal_id",
			type: "uuid",
			notNull: true,
		},
		merge_journal_id: {
			name: "merge_journal_id",
			type: "uuid",
			notNull: true,
		},
		version: { name: "version", type: "bigint", notNull: true },
		status: {
			name: "status",
			type: "text",
			notNull: true,
			default: "'active'",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		superseded_at: { name: "superseded_at", type: "timestamp" },
	},
	indexes: {
		identity_canonical_redirect_active_unique: {
			name: "identity_canonical_redirect_active_unique",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "source_principal_id", isExpression: false },
			],
			isUnique: true,
			where: "status = 'active'",
		},
		identity_canonical_redirect_target_idx: {
			name: "identity_canonical_redirect_target_idx",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "canonical_principal_id", isExpression: false },
				{ expression: "status", isExpression: false },
			],
			isUnique: false,
		},
		identity_redirect_journal_idx: {
			name: "identity_redirect_journal_idx",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "merge_journal_id", isExpression: false },
				{ expression: "status", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_identity_canonical_redirect_agent: agentForeignKey(
			"fk_identity_canonical_redirect_agent",
			"identity_canonical_redirects",
		),
		fk_identity_canonical_redirect_source: {
			name: "fk_identity_canonical_redirect_source",
			tableFrom: "identity_canonical_redirects",
			tableTo: "entities",
			columnsFrom: ["source_principal_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
		fk_identity_canonical_redirect_target: {
			name: "fk_identity_canonical_redirect_target",
			tableFrom: "identity_canonical_redirects",
			tableTo: "entities",
			columnsFrom: ["canonical_principal_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
		fk_identity_canonical_redirect_journal: {
			name: "fk_identity_canonical_redirect_journal",
			tableFrom: "identity_canonical_redirects",
			tableTo: "identity_merge_journal",
			columnsFrom: ["merge_journal_id", "agent_id"],
			columnsTo: ["id", "agent_id"],
			onDelete: "restrict",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		identity_canonical_redirect_version_unique: {
			name: "identity_canonical_redirect_version_unique",
			columns: ["agent_id", "source_principal_id", "version"],
		},
	},
	checkConstraints: {
		identity_canonical_redirect_status_check: {
			name: "identity_canonical_redirect_status_check",
			value: "status IN ('active', 'superseded', 'reverted')",
		},
		identity_canonical_redirect_distinct_check: {
			name: "identity_canonical_redirect_distinct_check",
			value: "source_principal_id <> canonical_principal_id",
		},
		identity_canonical_redirect_version_check: {
			name: "identity_canonical_redirect_version_check",
			value: "version > 0",
		},
	},
};

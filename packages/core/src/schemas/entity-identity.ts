import type { SchemaTable } from "../types/schema.ts";

/**
 * Strengthened, normalized record of a (platform, handle) claim attached to an
 * entity. Lives alongside (and is more authoritative than) the legacy
 * `metadata.platformIdentities` array on entity rows.
 *
 * Each row carries provenance: which messages observed the claim, what the
 * source extractor scored its confidence at, and when it was first/last seen.
 * The (platform, handle) pair is unique per entity so re-observations bump
 * confidence + evidence rather than producing duplicate rows.
 */
export const entityIdentitySchema: SchemaTable = {
	name: "entity_identities",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		entity_id: {
			name: "entity_id",
			type: "uuid",
			notNull: true,
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		platform: {
			name: "platform",
			type: "text",
			notNull: true,
		},
		handle: {
			name: "handle",
			type: "text",
			notNull: true,
		},
		verified: {
			name: "verified",
			type: "boolean",
			notNull: true,
			default: false,
		},
		confidence: {
			name: "confidence",
			type: "real",
			notNull: true,
			default: 0,
		},
		source: {
			name: "source",
			type: "text",
		},
		first_seen: {
			name: "first_seen",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		last_seen: {
			name: "last_seen",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		evidence_message_ids: {
			name: "evidence_message_ids",
			type: "jsonb",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {
		idx_entity_identities_entity: {
			name: "idx_entity_identities_entity",
			columns: [{ expression: "entity_id", isExpression: false }],
			isUnique: false,
		},
		idx_entity_identities_platform_handle: {
			name: "idx_entity_identities_platform_handle",
			columns: [
				{ expression: "platform", isExpression: false },
				{ expression: "handle", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_entity_identities_entity: {
			name: "fk_entity_identities_entity",
			tableFrom: "entity_identities",
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_entity_identities_agent: {
			name: "fk_entity_identities_agent",
			tableFrom: "entity_identities",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		unique_entity_identity: {
			name: "unique_entity_identity",
			columns: ["entity_id", "platform", "handle", "agent_id"],
		},
	},
	checkConstraints: {},
};

/**
 * Pending merge proposals between two entities. Created when an identity claim
 * collision indicates two distinct entity rows actually represent the same
 * person. A human (or auto-merge threshold) flips `status` to "accepted" /
 * "rejected"; on accept the merge is applied transactionally.
 */
export const entityMergeCandidateSchema: SchemaTable = {
	name: "entity_merge_candidates",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		entity_a: {
			name: "entity_a",
			type: "uuid",
			notNull: true,
		},
		entity_b: {
			name: "entity_b",
			type: "uuid",
			notNull: true,
		},
		confidence: {
			name: "confidence",
			type: "real",
			notNull: true,
			default: 0,
		},
		evidence: {
			name: "evidence",
			type: "jsonb",
		},
		status: {
			name: "status",
			type: "text",
			notNull: true,
			default: "'pending'",
		},
		proposed_at: {
			name: "proposed_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		resolved_at: {
			name: "resolved_at",
			type: "timestamp",
		},
	},
	indexes: {
		idx_entity_merge_candidates_status: {
			name: "idx_entity_merge_candidates_status",
			columns: [{ expression: "status", isExpression: false }],
			isUnique: false,
		},
		idx_entity_merge_candidates_pair: {
			name: "idx_entity_merge_candidates_pair",
			columns: [
				{ expression: "entity_a", isExpression: false },
				{ expression: "entity_b", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_entity_merge_candidates_a: {
			name: "fk_entity_merge_candidates_a",
			tableFrom: "entity_merge_candidates",
			tableTo: "entities",
			columnsFrom: ["entity_a"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_entity_merge_candidates_b: {
			name: "fk_entity_merge_candidates_b",
			tableFrom: "entity_merge_candidates",
			tableTo: "entities",
			columnsFrom: ["entity_b"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_entity_merge_candidates_agent: {
			name: "fk_entity_merge_candidates_agent",
			tableFrom: "entity_merge_candidates",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};

export type EntityMergeCandidateStatus = "pending" | "accepted" | "rejected";

/**
 * Fact refinement candidates. When the FactRefinementEvaluator detects a
 * contradiction or merge opportunity that we cannot apply automatically, it
 * writes a row here for the user to resolve in the Facts tab.
 */
export const factCandidateSchema: SchemaTable = {
	name: "fact_candidates",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		entity_id: {
			name: "entity_id",
			type: "uuid",
			notNull: true,
		},
		kind: {
			name: "kind",
			type: "text",
			notNull: true,
		},
		existing_fact_id: {
			name: "existing_fact_id",
			type: "uuid",
		},
		proposed_text: {
			name: "proposed_text",
			type: "text",
			notNull: true,
		},
		confidence: {
			name: "confidence",
			type: "real",
			notNull: true,
			default: 0,
		},
		evidence: {
			name: "evidence",
			type: "jsonb",
		},
		status: {
			name: "status",
			type: "text",
			notNull: true,
			default: "'pending'",
		},
		proposed_at: {
			name: "proposed_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		resolved_at: {
			name: "resolved_at",
			type: "timestamp",
		},
	},
	indexes: {
		idx_fact_candidates_status: {
			name: "idx_fact_candidates_status",
			columns: [{ expression: "status", isExpression: false }],
			isUnique: false,
		},
		idx_fact_candidates_entity: {
			name: "idx_fact_candidates_entity",
			columns: [{ expression: "entity_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_fact_candidates_entity: {
			name: "fk_fact_candidates_entity",
			tableFrom: "fact_candidates",
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_fact_candidates_agent: {
			name: "fk_fact_candidates_agent",
			tableFrom: "fact_candidates",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};

export type FactCandidateKind = "contradict" | "merge";
export type FactCandidateStatus = "pending" | "accepted" | "rejected";

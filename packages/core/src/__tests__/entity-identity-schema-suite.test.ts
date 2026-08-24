/**
 * Unit tests for entity resolution and identity claim schema definitions.
 * Exercises table structure, column types, default values, foreign keys,
 * unique constraints, and index configurations.
 */
import { describe, expect, it } from "vitest";
import {
	entityIdentitySchema,
	entityMergeCandidateSchema,
	factCandidateSchema,
} from "../schemas/entity-identity.ts";

describe("entity-identity schemas", () => {
	describe("entityIdentitySchema", () => {
		it("defines correct table metadata", () => {
			expect(entityIdentitySchema.name).toBe("entity_identities");
			expect(entityIdentitySchema.schema).toBe("");
		});

		it("defines required columns with types and constraints", () => {
			const cols = entityIdentitySchema.columns;
			expect(cols.id.type).toBe("uuid");
			expect(cols.id.primaryKey).toBe(true);
			expect(cols.id.notNull).toBe(true);

			expect(cols.entity_id.type).toBe("uuid");
			expect(cols.entity_id.notNull).toBe(true);

			expect(cols.agent_id.type).toBe("uuid");
			expect(cols.agent_id.notNull).toBe(true);

			expect(cols.platform.type).toBe("text");
			expect(cols.platform.notNull).toBe(true);

			expect(cols.handle.type).toBe("text");
			expect(cols.handle.notNull).toBe(true);

			expect(cols.verified.type).toBe("boolean");
			expect(cols.verified.default).toBe(false);

			expect(cols.confidence.type).toBe("real");
			expect(cols.confidence.default).toBe(0);

			expect(cols.evidence_message_ids.type).toBe("jsonb");
			expect(cols.created_at.type).toBe("timestamp");
		});

		it("defines expected indexes and constraints", () => {
			expect(
				entityIdentitySchema.indexes.idx_entity_identities_entity,
			).toBeDefined();
			expect(
				entityIdentitySchema.indexes.idx_entity_identities_platform_handle,
			).toBeDefined();

			const uniqueConstraint =
				entityIdentitySchema.uniqueConstraints.unique_entity_identity;
			expect(uniqueConstraint).toBeDefined();
			expect(uniqueConstraint.columns).toEqual([
				"entity_id",
				"platform",
				"handle",
				"agent_id",
			]);
		});

		it("configures foreign keys with cascading delete", () => {
			const fkEntity =
				entityIdentitySchema.foreignKeys.fk_entity_identities_entity;
			expect(fkEntity.tableTo).toBe("entities");
			expect(fkEntity.columnsFrom).toEqual(["entity_id"]);
			expect(fkEntity.columnsTo).toEqual(["id"]);
			expect(fkEntity.onDelete).toBe("cascade");

			const fkAgent =
				entityIdentitySchema.foreignKeys.fk_entity_identities_agent;
			expect(fkAgent.tableTo).toBe("agents");
			expect(fkAgent.columnsFrom).toEqual(["agent_id"]);
			expect(fkAgent.columnsTo).toEqual(["id"]);
			expect(fkAgent.onDelete).toBe("cascade");
		});
	});

	describe("entityMergeCandidateSchema", () => {
		it("defines correct table metadata", () => {
			expect(entityMergeCandidateSchema.name).toBe("entity_merge_candidates");
		});

		it("defines columns with proper defaults and nullability", () => {
			const cols = entityMergeCandidateSchema.columns;
			expect(cols.id.primaryKey).toBe(true);
			expect(cols.agent_id.notNull).toBe(true);
			expect(cols.entity_a.notNull).toBe(true);
			expect(cols.entity_b.notNull).toBe(true);
			expect(cols.confidence.default).toBe(0);
			expect(cols.status.default).toBe("'pending'");
			expect(cols.evidence.type).toBe("jsonb");
		});

		it("defines pair and status indexes", () => {
			expect(
				entityMergeCandidateSchema.indexes.idx_entity_merge_candidates_status,
			).toBeDefined();
			expect(
				entityMergeCandidateSchema.indexes.idx_entity_merge_candidates_pair,
			).toBeDefined();
		});

		it("defines cascading foreign keys to entities and agents", () => {
			expect(
				entityMergeCandidateSchema.foreignKeys.fk_entity_merge_candidates_a
					.tableTo,
			).toBe("entities");
			expect(
				entityMergeCandidateSchema.foreignKeys.fk_entity_merge_candidates_b
					.tableTo,
			).toBe("entities");
			expect(
				entityMergeCandidateSchema.foreignKeys.fk_entity_merge_candidates_agent
					.tableTo,
			).toBe("agents");
		});
	});

	describe("factCandidateSchema", () => {
		it("defines correct table metadata", () => {
			expect(factCandidateSchema.name).toBe("fact_candidates");
		});

		it("defines columns for contradiction and merge tracking", () => {
			const cols = factCandidateSchema.columns;
			expect(cols.id.primaryKey).toBe(true);
			expect(cols.agent_id.notNull).toBe(true);
			expect(cols.entity_id.notNull).toBe(true);
			expect(cols.kind.type).toBe("text");
			expect(cols.existing_fact_id.type).toBe("uuid");
			expect(cols.proposed_text.notNull).toBe(true);
			expect(cols.confidence.default).toBe(0);
			expect(cols.status.default).toBe("'pending'");
		});

		it("defines indexes and foreign keys", () => {
			expect(
				factCandidateSchema.indexes.idx_fact_candidates_status,
			).toBeDefined();
			expect(
				factCandidateSchema.indexes.idx_fact_candidates_entity,
			).toBeDefined();
			expect(
				factCandidateSchema.foreignKeys.fk_fact_candidates_entity.tableTo,
			).toBe("entities");
			expect(
				factCandidateSchema.foreignKeys.fk_fact_candidates_agent.tableTo,
			).toBe("agents");
		});
	});
});

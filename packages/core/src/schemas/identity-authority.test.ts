/**
 * Verifies the portable identity schema preserves account scope, immutable
 * attribution, generation fencing, and reversible redirect history.
 */

import { describe, expect, it } from "vitest";
import type { SchemaTable } from "../types/schema";
import {
	identityAuthorityStateSchema,
	identityCanonicalRedirectSchema,
	identityClaimJournalSchema,
	identityClaimSchema,
	identityMergeConfirmationSchema,
	identityMergeJournalSchema,
} from "./identity-authority";

const CHECK_CONSTRAINT_KEYWORDS = new Set([
	"and",
	"in",
	"is",
	"not",
	"null",
	"or",
]);

function findMissingColumnReferences(schema: SchemaTable): string[] {
	const columnNames = new Set(Object.keys(schema.columns));
	const references: Array<{ owner: string; column: string }> = [];

	for (const index of Object.values(schema.indexes)) {
		for (const column of index.columns) {
			if (!column.isExpression) {
				references.push({
					owner: `index:${index.name}`,
					column: column.expression,
				});
			}
		}
	}
	for (const foreignKey of Object.values(schema.foreignKeys)) {
		for (const column of foreignKey.columnsFrom) {
			references.push({ owner: `foreign-key:${foreignKey.name}`, column });
		}
	}
	for (const primaryKey of Object.values(schema.compositePrimaryKeys)) {
		for (const column of primaryKey.columns) {
			references.push({ owner: `primary-key:${primaryKey.name}`, column });
		}
	}
	for (const uniqueConstraint of Object.values(schema.uniqueConstraints)) {
		for (const column of uniqueConstraint.columns) {
			references.push({ owner: `unique:${uniqueConstraint.name}`, column });
		}
	}
	for (const checkConstraint of Object.values(schema.checkConstraints)) {
		const expressionWithoutLiterals = checkConstraint.value.replace(
			/'(?:''|[^'])*'/g,
			"",
		);
		for (const identifier of expressionWithoutLiterals.match(
			/[a-z_][a-z0-9_]*/gi,
		) ?? []) {
			if (!CHECK_CONSTRAINT_KEYWORDS.has(identifier.toLowerCase())) {
				references.push({
					owner: `check:${checkConstraint.name}`,
					column: identifier,
				});
			}
		}
	}

	return references
		.filter(({ column }) => !columnNames.has(column))
		.map(({ owner, column }) => `${owner}:${column}`)
		.sort();
}

describe("portable identity authority schemas", () => {
	it("allows historical claims while uniquely fencing active scoped subjects", () => {
		const active =
			identityClaimSchema.indexes.identity_claim_active_scope_subject_unique;
		expect(active?.isUnique).toBe(true);
		expect(active?.where).toBe("status = 'active'");
		expect(identityClaimSchema.columns.connector_account_id?.type).toBe("uuid");
		expect(
			identityClaimSchema.columns.verification_authority_kind?.notNull,
		).not.toBe(true);
		expect(
			identityClaimSchema.foreignKeys.fk_identity_claim_owner_binding?.onDelete,
		).toBe("restrict");
	});

	it("fences every mutation with a durable generation and exact replay key", () => {
		expect(identityAuthorityStateSchema.columns.generation?.notNull).toBe(true);
		expect(
			identityMergeJournalSchema.uniqueConstraints
				.identity_merge_journal_idempotency_unique?.columns,
		).toEqual(["agent_id", "operation", "idempotency_key"]);
		expect(identityMergeJournalSchema.columns.request_digest?.notNull).toBe(
			true,
		);
		expect(identityMergeJournalSchema.columns.actor_principal_id?.notNull).toBe(
			true,
		);
	});

	it("journals tenant transitions at the agent lifecycle boundary", () => {
		expect(identityClaimSchema.columns.version?.default).toBe(1);
		expect(
			identityClaimJournalSchema.uniqueConstraints
				.identity_claim_journal_idempotency_unique?.columns,
		).toEqual(["agent_id", "idempotency_key"]);
		expect(identityClaimJournalSchema.columns.after_claim?.notNull).toBe(true);
		expect(
			identityClaimJournalSchema.foreignKeys.fk_identity_claim_journal_agent
				?.onDelete,
		).toBe("cascade");
	});

	it("keeps the portable journal columns in parity with persisted lifecycle rows", () => {
		expect(Object.keys(identityClaimJournalSchema.columns)).toEqual([
			"id",
			"agent_id",
			"claim_id",
			"principal_entity_id",
			"event_kind",
			"prior_version",
			"resulting_version",
			"actor_principal_id",
			"idempotency_key",
			"request_digest",
			"reason",
			"provenance",
			"evidence",
			"before_claim",
			"after_claim",
			"created_at",
		]);
		expect(identityClaimJournalSchema.columns.event_kind).toEqual({
			name: "event_kind",
			type: "text",
			notNull: true,
		});
		expect(identityClaimJournalSchema.columns.prior_version).toEqual({
			name: "prior_version",
			type: "bigint",
		});
		expect(identityClaimJournalSchema.columns.resulting_version).toEqual({
			name: "resulting_version",
			type: "bigint",
			notNull: true,
		});
	});

	it("rejects portable journal constraints that reference absent columns", () => {
		expect(findMissingColumnReferences(identityClaimJournalSchema)).toEqual([]);

		const { resulting_version: _omitted, ...columns } =
			identityClaimJournalSchema.columns;
		const malformedSchema = { ...identityClaimJournalSchema, columns };
		expect(findMissingColumnReferences(malformedSchema)).toEqual([
			"check:identity_claim_journal_version_check:resulting_version",
			"index:identity_claim_journal_claim_version_idx:resulting_version",
		]);
	});

	it("binds a bounded confirmation to the exact plan and generation", () => {
		expect(identityMergeConfirmationSchema.columns.plan_digest?.notNull).toBe(
			true,
		);
		expect(
			identityMergeConfirmationSchema.columns.expected_generation?.notNull,
		).toBe(true);
		expect(
			identityMergeConfirmationSchema.uniqueConstraints
				.identity_merge_confirmation_journal_unique?.columns,
		).toEqual(["agent_id", "journal_id"]);
	});

	it("retains versioned, journal-backed redirects without deleting principals", () => {
		expect(
			identityCanonicalRedirectSchema.uniqueConstraints
				.identity_canonical_redirect_version_unique?.columns,
		).toEqual(["agent_id", "source_principal_id", "version"]);
		expect(
			identityCanonicalRedirectSchema.foreignKeys
				.fk_identity_canonical_redirect_source?.onDelete,
		).toBe("restrict");
		expect(
			identityCanonicalRedirectSchema.foreignKeys
				.fk_identity_canonical_redirect_journal?.onDelete,
		).toBe("restrict");
	});
});

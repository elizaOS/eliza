/**
 * Verifies the portable identity schema preserves account scope, immutable
 * attribution, generation fencing, and reversible redirect history.
 */

import { describe, expect, it } from "vitest";
import {
	identityAuthorityStateSchema,
	identityCanonicalRedirectSchema,
	identityClaimSchema,
	identityMergeConfirmationSchema,
	identityMergeJournalSchema,
} from "./identity-authority";

describe("portable identity authority schemas", () => {
	it("allows historical claims while uniquely fencing active scoped subjects", () => {
		const active =
			identityClaimSchema.indexes.identity_claim_active_scope_subject_unique;
		expect(active?.isUnique).toBe(true);
		expect(active?.where).toBe("status = 'active'");
		expect(identityClaimSchema.columns.connector_account_id?.type).toBe("uuid");
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

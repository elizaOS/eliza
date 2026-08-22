/**
 * Deterministically verifies the relational invariants for canonical identity
 * claims, reversible merge journals, and non-destructive redirects.
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  identityAuthorityStateTable,
  identityCanonicalRedirectTable,
  identityClaimJournalTable,
  identityClaimTable,
  identityMergeConfirmationTable,
  identityMergeJournalTable,
  identityPersonLinkAttestationTable,
} from "../schema/identityAuthority";

describe("canonical identity authority schema", () => {
  it("account-scopes one external subject and separates OWNER binding", () => {
    const config = getTableConfig(identityClaimTable);

    expect(config.name).toBe("identity_claims");
    expect(config.indexes.map((entry) => entry.config.name)).toContain(
      "identity_claim_active_scope_subject_unique"
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "identity_claim_verification_check",
        "identity_claim_status_check",
        "identity_claim_confidence_check",
        "identity_claim_owner_binding_check",
        "identity_claim_version_check",
      ])
    );
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "agent_id",
        "principal_entity_id",
        "connector_id",
        "connector_account_id",
        "external_subject_id",
        "owner_binding_id",
        "verification_authority_kind",
        "verification_authority_id",
        "version",
      ])
    );
  });

  it("keeps a tenant journal that only cascades through its agent", () => {
    const config = getTableConfig(identityClaimJournalTable);
    expect(config.name).toBe("identity_claim_journal");
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "identity_claim_journal_idempotency_unique"
    );
    expect(config.foreignKeys).toHaveLength(1);
    expect(
      config.foreignKeys.find((key) => key.getName() === "fk_identity_claim_journal_agent")
        ?.onDelete
    ).toBe("cascade");
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "identity_claim_journal_event_check",
        "identity_claim_journal_version_check",
      ])
    );
  });

  it("retains merge and split plans with lineage and before-state", () => {
    const config = getTableConfig(identityMergeJournalTable);

    expect(config.name).toBe("identity_merge_journal");
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "operation",
        "status",
        "parent_journal_id",
        "idempotency_key",
        "request_digest",
        "expected_generation",
        "actor_principal_id",
        "canonical_principal_id",
        "source_principal_ids",
        "plan",
        "before_state",
        "result",
      ])
    );
    expect(config.foreignKeys).toHaveLength(4);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "identity_merge_journal_operation_check",
        "identity_merge_journal_status_check",
      ])
    );
  });

  it("persists authority generation and bounded confirmation state", () => {
    const state = getTableConfig(identityAuthorityStateTable);
    const confirmation = getTableConfig(identityMergeConfirmationTable);

    expect(state.columns.map((column) => column.name)).toContain("generation");
    expect(confirmation.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "journal_id",
        "plan_digest",
        "expected_generation",
        "expires_at",
        "consumed_at",
      ])
    );
    expect(confirmation.foreignKeys).toHaveLength(3);
  });

  it("binds immutable person-link evidence to an operator and generation", () => {
    const config = getTableConfig(identityPersonLinkAttestationTable);

    expect(config.name).toBe("identity_person_link_attestations");
    expect(config.foreignKeys).toHaveLength(4);
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "identity_person_link_attestation_idempotency_unique"
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "identity_person_link_attestation_order_check",
        "identity_person_link_attestation_actor_role_check",
        "identity_person_link_attestation_authority_check",
        "identity_person_link_attestation_generation_check",
      ])
    );
  });

  it("keeps versioned redirects and forbids self-canonicalization", () => {
    const config = getTableConfig(identityCanonicalRedirectTable);

    expect(config.name).toBe("identity_canonical_redirects");
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "identity_canonical_redirect_version_unique"
    );
    expect(config.foreignKeys).toHaveLength(4);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "identity_canonical_redirect_status_check",
        "identity_canonical_redirect_distinct_check",
        "identity_canonical_redirect_version_check",
      ])
    );
  });
});

/**
 * Deterministically verifies the canonical membership tables and plugin
 * registration expose one durable authority with relational fencing and no
 * model-callable mutation surface.
 */
import { MembershipService } from "@elizaos/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { plugin, SqlMembershipService } from "../index";
import {
  membershipAuthorityJournalTable,
  membershipAuthorityScopeTable,
  membershipAuthorityTable,
} from "../schema/membershipAuthority";

describe("canonical membership authority schema", () => {
  it("registers one canonical service without a model-callable action", () => {
    expect(
      plugin.services?.filter((service) => service.serviceType === MembershipService.serviceType)
    ).toEqual([SqlMembershipService]);
    expect(plugin.actions).toBeUndefined();
  });

  it("keys current state by the complete connector-room-principal tuple", () => {
    const config = getTableConfig(membershipAuthorityTable);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "agent_id",
      "connector_id",
      "connector_account_id",
      "external_world_id",
      "external_room_id",
      "canonical_principal_id",
    ]);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "membership_authority_state_check",
        "membership_authority_reason_check",
        "membership_authority_state_reason_check",
        "membership_authority_evidence_check",
        "membership_authority_version_check",
      ])
    );
    expect(
      config.foreignKeys.map((constraint) => constraint.reference().foreignTable)
    ).toHaveLength(3);
  });

  it("persists publisher fencing, bounded freshness, and exact command receipts", () => {
    const scope = getTableConfig(membershipAuthorityScopeTable);
    const journal = getTableConfig(membershipAuthorityJournalTable);
    expect(scope.checks.map((constraint) => constraint.name)).toContain(
      "membership_authority_scope_health_check"
    );
    expect(scope.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "health",
        "generation",
        "source_version",
        "source_cursor",
        "valid_until",
        "publisher_instance_id",
        "publisher_generation",
        "evidence_mode",
      ])
    );
    expect(journal.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "membership_authority_journal_idempotency_unique"
    );
    expect(journal.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "membership_authority_journal_operation_check",
        "membership_authority_journal_generation_check",
      ])
    );
    expect(scope.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "membership_authority_scope_publisher_check",
        "membership_authority_scope_current_check",
      ])
    );
  });
});

/**
 * PostgreSQL persistence for household access grants and versioned schedule
 * agreements. Identity stays in EntityStore/RelationshipStore, approvals stay
 * in the shared approval queue, and this repository atomically advances only
 * the household coordination state that neither subsystem owns.
 */
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsCommitmentLedgerRecord } from "../commitments/index.js";
import {
  asObject,
  executeRawSql,
  executeRawSqlTx,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  toNumber,
  toText,
  withTransaction,
} from "../sql.js";
import {
  HOUSEHOLD_AUDIT_KINDS,
  type HouseholdAccessGrant,
  type HouseholdAccessScope,
  type HouseholdAuditKind,
  type HouseholdAuditRecord,
  HouseholdCoordinationError,
  type HouseholdCoordinationHead,
  type HouseholdProposalApproval,
  type HouseholdRole,
  type HouseholdScheduleAgreement,
  type HouseholdScheduleProposal,
  type HouseholdScheduleTerms,
  isHouseholdAccessScope,
  isHouseholdAuditKind,
  isHouseholdProposalStatus,
  isHouseholdRole,
  normalizeScheduleTerms,
} from "./types.js";

type AuditWrite = Omit<HouseholdAuditRecord, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

function requiredText(value: unknown, field: string): string {
  const text = toText(value).trim();
  if (!text) {
    throw new HouseholdCoordinationError(
      `Persisted household row is missing ${field}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field },
    );
  }
  return text;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return toText(value);
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = toNumber(value, Number.NaN);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HouseholdCoordinationError(
      `Persisted household row has invalid ${field}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field, value: toText(value) },
    );
  }
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") {
    return true;
  }
  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }
  throw new HouseholdCoordinationError(
    `Persisted household row has invalid ${field}`,
    "HOUSEHOLD_INVALID_CONTRACT",
    { field, value: toText(value) },
  );
}

function stringArray(value: unknown, field: string): string[] {
  const parsed = parseJsonArray<unknown>(value);
  if (parsed.some((entry) => typeof entry !== "string")) {
    throw new HouseholdCoordinationError(
      `Persisted household row has invalid ${field}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field },
    );
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function roleValue(value: unknown): HouseholdRole {
  const text = requiredText(value, "role");
  if (!isHouseholdRole(text)) {
    throw new HouseholdCoordinationError(
      `Unknown persisted household role: ${text}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { role: text },
    );
  }
  return text;
}

function scopeArray(value: unknown): HouseholdAccessScope[] {
  const values = stringArray(value, "scopes");
  const invalid = values.filter((scope) => !isHouseholdAccessScope(scope));
  if (invalid.length > 0) {
    throw new HouseholdCoordinationError(
      `Unknown persisted household scopes: ${invalid.join(", ")}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { invalid },
    );
  }
  return values.filter(isHouseholdAccessScope);
}

function termsValue(value: unknown): HouseholdScheduleTerms {
  const row = parseJsonRecord(value);
  const children = row.childEntityIds;
  if (
    !Array.isArray(children) ||
    children.some((entry) => typeof entry !== "string")
  ) {
    throw new HouseholdCoordinationError(
      "Persisted schedule terms have invalid childEntityIds",
      "HOUSEHOLD_INVALID_CONTRACT",
    );
  }
  const custody = row.custodyException;
  const custodyRecord = custody === null ? null : asObject(custody);
  if (custody !== null && !custodyRecord) {
    throw new HouseholdCoordinationError(
      "Persisted schedule terms have invalid custodyException",
      "HOUSEHOLD_INVALID_CONTRACT",
    );
  }
  return normalizeScheduleTerms({
    summary: requiredText(row.summary, "terms.summary"),
    startAt: requiredText(row.startAt, "terms.startAt"),
    endAt: requiredText(row.endAt, "terms.endAt"),
    timezone: requiredText(row.timezone, "terms.timezone"),
    childEntityIds: children,
    location: optionalText(row.location),
    notes: optionalText(row.notes),
    custodyException: custodyRecord
      ? {
          childEntityId: requiredText(
            custodyRecord.childEntityId,
            "custody.childEntityId",
          ),
          fromAt: requiredText(custodyRecord.fromAt, "custody.fromAt"),
          toAt: requiredText(custodyRecord.toAt, "custody.toAt"),
          normalCustodianEntityId: requiredText(
            custodyRecord.normalCustodianEntityId,
            "custody.normalCustodianEntityId",
          ),
          substituteCustodianEntityId: requiredText(
            custodyRecord.substituteCustodianEntityId,
            "custody.substituteCustodianEntityId",
          ),
          reason: requiredText(custodyRecord.reason, "custody.reason"),
        }
      : null,
  });
}

function grantFromRow(row: Record<string, unknown>): HouseholdAccessGrant {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    principalEntityId: requiredText(
      row.principal_entity_id,
      "principalEntityId",
    ),
    relationshipId: optionalText(row.relationship_id),
    role: roleValue(row.role),
    subjectEntityIds: stringArray(
      row.subject_entity_ids_json,
      "subjectEntityIds",
    ),
    scopes: scopeArray(row.scopes_json),
    issuedByEntityId: requiredText(row.issued_by_entity_id, "issuedByEntityId"),
    expiresAt: optionalText(row.expires_at),
    revokedAt: optionalText(row.revoked_at),
    revokedByEntityId: optionalText(row.revoked_by_entity_id),
    revocationReason: optionalText(row.revocation_reason),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function proposalFromRow(
  row: Record<string, unknown>,
): HouseholdScheduleProposal {
  const status = requiredText(row.status, "status");
  if (!isHouseholdProposalStatus(status)) {
    throw new HouseholdCoordinationError(
      `Unknown persisted household proposal status: ${status}`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { status },
    );
  }
  return {
    proposalId: requiredText(row.proposal_id, "proposalId"),
    agentId: requiredText(row.agent_id, "agentId"),
    version: requiredInteger(row.version, "version"),
    coordinationId: requiredText(row.coordination_id, "coordinationId"),
    baseAgreementVersion: requiredInteger(
      row.base_agreement_version,
      "baseAgreementVersion",
    ),
    terms: termsValue(row.terms_json),
    affectedPartyEntityIds: stringArray(
      row.affected_party_entity_ids_json,
      "affectedPartyEntityIds",
    ),
    requiredApproverEntityIds: stringArray(
      row.required_approver_entity_ids_json,
      "requiredApproverEntityIds",
    ),
    createdByEntityId: requiredText(
      row.created_by_entity_id,
      "createdByEntityId",
    ),
    contentSha256: requiredText(row.content_sha256, "contentSha256"),
    status,
    materialChange: requiredBoolean(row.material_change, "materialChange"),
    expiresAt: optionalText(row.expires_at),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function approvalFromRow(
  row: Record<string, unknown>,
): HouseholdProposalApproval {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    proposalId: requiredText(row.proposal_id, "proposalId"),
    proposalVersion: requiredInteger(row.proposal_version, "proposalVersion"),
    partyEntityId: requiredText(row.party_entity_id, "partyEntityId"),
    approvalRequestId: requiredText(
      row.approval_request_id,
      "approvalRequestId",
    ),
    invalidatedAt: optionalText(row.invalidated_at),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function headFromRow(row: Record<string, unknown>): HouseholdCoordinationHead {
  return {
    id: requiredText(row.id, "id"),
    agentId: requiredText(row.agent_id, "agentId"),
    coordinationId: requiredText(row.coordination_id, "coordinationId"),
    currentAgreementVersion: requiredInteger(
      row.current_agreement_version,
      "currentAgreementVersion",
    ),
    currentAgreementId: optionalText(row.current_agreement_id),
    createdAt: requiredText(row.created_at, "createdAt"),
    updatedAt: requiredText(row.updated_at, "updatedAt"),
  };
}

function agreementFromRow(
  row: Record<string, unknown>,
  currentAgreementId: string | null,
): HouseholdScheduleAgreement {
  const id = requiredText(row.id, "id");
  return {
    id,
    agentId: requiredText(row.agent_id, "agentId"),
    coordinationId: requiredText(row.coordination_id, "coordinationId"),
    version: requiredInteger(row.version, "version"),
    proposalId: requiredText(row.proposal_id, "proposalId"),
    proposalVersion: requiredInteger(row.proposal_version, "proposalVersion"),
    terms: termsValue(row.terms_json),
    affectedPartyEntityIds: stringArray(
      row.affected_party_entity_ids_json,
      "affectedPartyEntityIds",
    ),
    approvedByEntityIds: stringArray(
      row.approved_by_entity_ids_json,
      "approvedByEntityIds",
    ),
    activatedAt: requiredText(row.activated_at, "activatedAt"),
    createdAt: requiredText(row.created_at, "createdAt"),
    isCurrent: id === currentAgreementId,
  };
}

function ownerTypeFor(kind: HouseholdAuditKind): string {
  if (kind === "household_role_bound") return "household_role";
  if (kind === "household_grant_issued" || kind === "household_grant_revoked") {
    return "household_grant";
  }
  if (
    kind === "household_proposal_created" ||
    kind === "household_proposal_revised" ||
    kind === "household_proposal_approved" ||
    kind === "household_proposal_invalidated"
  ) {
    return "household_proposal";
  }
  if (kind === "household_agreement_activated") {
    return "household_agreement";
  }
  return "household_export";
}

async function insertAudit(
  target: IAgentRuntime | TransactionalDb,
  agentId: string,
  event: AuditWrite,
): Promise<void> {
  const id = event.id ?? `haudit_${crypto.randomUUID()}`;
  const createdAt = event.createdAt ?? new Date().toISOString();
  const query = `INSERT INTO app_lifeops.life_audit_events (
      id, agent_id, event_type, owner_type, owner_id, reason,
      inputs_json, decision_json, actor, created_at
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(agentId)},
      ${sqlQuote(event.kind)},
      ${sqlQuote(ownerTypeFor(event.kind))},
      ${sqlQuote(event.ownerId)},
      ${sqlQuote(event.reason)},
      ${sqlJson(event.inputs)},
      ${sqlJson(event.decision)},
      ${sqlQuote(event.actor)},
      ${sqlQuote(createdAt)}
    )`;
  if ("adapter" in target) {
    await executeRawSql(target, query);
    return;
  }
  await executeRawSqlTx(target, query);
}

export class HouseholdCoordinationRepository {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  async appendAudit(event: AuditWrite): Promise<void> {
    await insertAudit(this.runtime, this.agentId, event);
  }

  async insertGrant(
    grant: HouseholdAccessGrant,
    audit: AuditWrite,
  ): Promise<void> {
    await withTransaction(this.runtime, async (tx) => {
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_household_access_grants (
          id, agent_id, principal_entity_id, relationship_id, role,
          subject_entity_ids_json, scopes_json, issued_by_entity_id,
          expires_at, revoked_at, revoked_by_entity_id, revocation_reason,
          created_at, updated_at
        ) VALUES (
          ${sqlQuote(grant.id)},
          ${sqlQuote(this.agentId)},
          ${sqlQuote(grant.principalEntityId)},
          ${sqlText(grant.relationshipId)},
          ${sqlQuote(grant.role)},
          ${sqlJson(grant.subjectEntityIds)},
          ${sqlJson(grant.scopes)},
          ${sqlQuote(grant.issuedByEntityId)},
          ${sqlText(grant.expiresAt)},
          NULL,
          NULL,
          NULL,
          ${sqlQuote(grant.createdAt)},
          ${sqlQuote(grant.updatedAt)}
        )`,
      );
      await insertAudit(tx, this.agentId, audit);
    });
  }

  async getGrant(id: string): Promise<HouseholdAccessGrant | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_access_grants
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    return rows[0] ? grantFromRow(rows[0]) : null;
  }

  async listGrants(
    principalEntityId?: string,
  ): Promise<HouseholdAccessGrant[]> {
    const principalClause = principalEntityId
      ? `AND principal_entity_id = ${sqlQuote(principalEntityId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_access_grants
        WHERE agent_id = ${sqlQuote(this.agentId)}
          ${principalClause}
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(grantFromRow);
  }

  async revokeGrant(input: {
    id: string;
    revokedAt: string;
    revokedByEntityId: string;
    reason: string;
  }): Promise<HouseholdAccessGrant> {
    return await withTransaction(this.runtime, async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_access_grants
            SET revoked_at = ${sqlQuote(input.revokedAt)},
                revoked_by_entity_id = ${sqlQuote(input.revokedByEntityId)},
                revocation_reason = ${sqlQuote(input.reason)},
                updated_at = ${sqlQuote(input.revokedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND id = ${sqlQuote(input.id)}
            AND revoked_at IS NULL
        RETURNING *`,
      );
      const row = rows[0];
      if (!row) {
        throw new HouseholdCoordinationError(
          `Grant ${input.id} is missing or already revoked`,
          "HOUSEHOLD_GRANT_REVOKED",
          { grantId: input.id },
        );
      }
      const grant = grantFromRow(row);
      await insertAudit(tx, this.agentId, {
        kind: "household_grant_revoked",
        ownerId: grant.id,
        reason: input.reason,
        inputs: {
          principalEntityId: grant.principalEntityId,
          scopes: grant.scopes,
        },
        decision: {
          revokedAt: grant.revokedAt,
          revokedByEntityId: grant.revokedByEntityId,
        },
        actor: "user",
        createdAt: input.revokedAt,
      });
      return grant;
    });
  }

  async ensureHead(
    coordinationId: string,
    now: string,
  ): Promise<HouseholdCoordinationHead> {
    const id = `hcoord_${crypto
      .createHash("sha256")
      .update(`${this.agentId}\0${coordinationId}`)
      .digest("hex")
      .slice(0, 24)}`;
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_coordination_heads (
        id, agent_id, coordination_id, current_agreement_version,
        current_agreement_id, created_at, updated_at
      ) VALUES (
        ${sqlQuote(id)},
        ${sqlQuote(this.agentId)},
        ${sqlQuote(coordinationId)},
        0,
        NULL,
        ${sqlQuote(now)},
        ${sqlQuote(now)}
      )
      ON CONFLICT(agent_id, coordination_id) DO NOTHING`,
    );
    const head = await this.getHead(coordinationId);
    if (!head) {
      throw new HouseholdCoordinationError(
        `Failed to create coordination head ${coordinationId}`,
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        { coordinationId },
      );
    }
    return head;
  }

  async getHead(
    coordinationId: string,
  ): Promise<HouseholdCoordinationHead | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_coordination_heads
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND coordination_id = ${sqlQuote(coordinationId)}
        LIMIT 1`,
    );
    return rows[0] ? headFromRow(rows[0]) : null;
  }

  async insertProposal(
    proposal: HouseholdScheduleProposal,
    audit: AuditWrite,
  ): Promise<void> {
    await withTransaction(this.runtime, async (tx) => {
      const headRows = await executeRawSqlTx(
        tx,
        `SELECT *
           FROM app_lifeops.life_household_coordination_heads
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND coordination_id = ${sqlQuote(proposal.coordinationId)}
          FOR UPDATE`,
      );
      const head = headRows[0] ? headFromRow(headRows[0]) : null;
      if (
        !head ||
        head.currentAgreementVersion !== proposal.baseAgreementVersion
      ) {
        throw new HouseholdCoordinationError(
          `Proposal base agreement ${proposal.baseAgreementVersion} is stale`,
          "HOUSEHOLD_STALE_BASE_AGREEMENT",
          {
            coordinationId: proposal.coordinationId,
            baseAgreementVersion: proposal.baseAgreementVersion,
            currentAgreementVersion: head?.currentAgreementVersion,
          },
        );
      }
      await this.insertProposalTx(tx, proposal);
      await insertAudit(tx, this.agentId, audit);
    });
  }

  private async insertProposalTx(
    tx: TransactionalDb,
    proposal: HouseholdScheduleProposal,
  ): Promise<void> {
    const rowId = `hproposalrow_${crypto
      .createHash("sha256")
      .update(`${this.agentId}\0${proposal.proposalId}\0${proposal.version}`)
      .digest("hex")}`;
    await executeRawSqlTx(
      tx,
      `INSERT INTO app_lifeops.life_household_schedule_proposals (
        row_id, agent_id, proposal_id, version, coordination_id,
        base_agreement_version, terms_json, affected_party_entity_ids_json,
        required_approver_entity_ids_json, created_by_entity_id,
        content_sha256, status, material_change, expires_at, created_at,
        updated_at
      ) VALUES (
        ${sqlQuote(rowId)},
        ${sqlQuote(this.agentId)},
        ${sqlQuote(proposal.proposalId)},
        ${sqlInteger(proposal.version)},
        ${sqlQuote(proposal.coordinationId)},
        ${sqlInteger(proposal.baseAgreementVersion)},
        ${sqlJson(proposal.terms)},
        ${sqlJson(proposal.affectedPartyEntityIds)},
        ${sqlJson(proposal.requiredApproverEntityIds)},
        ${sqlQuote(proposal.createdByEntityId)},
        ${sqlQuote(proposal.contentSha256)},
        ${sqlQuote(proposal.status)},
        ${sqlBoolean(proposal.materialChange)},
        ${sqlText(proposal.expiresAt)},
        ${sqlQuote(proposal.createdAt)},
        ${sqlQuote(proposal.updatedAt)}
      )`,
    );
  }

  async reviseProposal(
    previous: HouseholdScheduleProposal,
    next: HouseholdScheduleProposal,
  ): Promise<string[]> {
    return await withTransaction(this.runtime, async (tx) => {
      const headRows = await executeRawSqlTx(
        tx,
        `SELECT *
           FROM app_lifeops.life_household_coordination_heads
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND coordination_id = ${sqlQuote(previous.coordinationId)}
          FOR UPDATE`,
      );
      const head = headRows[0] ? headFromRow(headRows[0]) : null;
      if (
        !head ||
        head.currentAgreementVersion !== previous.baseAgreementVersion
      ) {
        throw new HouseholdCoordinationError(
          `Proposal ${previous.proposalId} is based on a stale agreement`,
          "HOUSEHOLD_STALE_BASE_AGREEMENT",
          {
            proposalId: previous.proposalId,
            proposalVersion: previous.version,
          },
        );
      }
      const changed = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'superseded',
                updated_at = ${sqlQuote(next.updatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(previous.proposalId)}
            AND version = ${sqlInteger(previous.version)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      if (changed.length !== 1) {
        throw new HouseholdCoordinationError(
          `Proposal ${previous.proposalId} v${previous.version} changed concurrently`,
          "HOUSEHOLD_PROPOSAL_CONFLICT",
          {
            proposalId: previous.proposalId,
            proposalVersion: previous.version,
          },
        );
      }
      const invalidatedApprovals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals
            SET invalidated_at = ${sqlQuote(next.updatedAt)},
                updated_at = ${sqlQuote(next.updatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(previous.proposalId)}
            AND proposal_version = ${sqlInteger(previous.version)}
            AND invalidated_at IS NULL
        RETURNING approval_request_id`,
      );
      await this.insertProposalTx(tx, next);
      await insertAudit(tx, this.agentId, {
        kind: "household_proposal_invalidated",
        ownerId: previous.proposalId,
        reason: "A newer proposal version replaced the approved bytes.",
        inputs: {
          proposalVersion: previous.version,
          materialChange: next.materialChange,
        },
        decision: {
          invalidatedAt: next.updatedAt,
          replacementVersion: next.version,
        },
        actor: "user",
        createdAt: next.updatedAt,
      });
      await insertAudit(tx, this.agentId, {
        kind: "household_proposal_revised",
        ownerId: next.proposalId,
        reason: "Household schedule proposal revised.",
        inputs: {
          previousVersion: previous.version,
          materialChange: next.materialChange,
          affectedPartyEntityIds: next.affectedPartyEntityIds,
        },
        decision: {
          proposalVersion: next.version,
          baseAgreementVersion: next.baseAgreementVersion,
          contentSha256: next.contentSha256,
        },
        actor: "user",
        createdAt: next.updatedAt,
      });
      return invalidatedApprovals.map((row) =>
        requiredText(row.approval_request_id, "approvalRequestId"),
      );
    });
  }

  async getProposal(
    proposalId: string,
    version?: number,
  ): Promise<HouseholdScheduleProposal | null> {
    const versionClause =
      version === undefined ? "" : `AND version = ${sqlInteger(version)}`;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_schedule_proposals
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND proposal_id = ${sqlQuote(proposalId)}
          ${versionClause}
        ORDER BY version DESC
        LIMIT 1`,
    );
    return rows[0] ? proposalFromRow(rows[0]) : null;
  }

  async listProposals(): Promise<HouseholdScheduleProposal[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_schedule_proposals
        WHERE agent_id = ${sqlQuote(this.agentId)}
        ORDER BY created_at ASC, proposal_id ASC, version ASC`,
    );
    return rows.map(proposalFromRow);
  }

  async insertApprovalLink(
    approval: HouseholdProposalApproval,
  ): Promise<HouseholdProposalApproval> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_household_proposal_approvals (
        id, agent_id, proposal_id, proposal_version, party_entity_id,
        approval_request_id, invalidated_at, created_at, updated_at
      ) VALUES (
        ${sqlQuote(approval.id)},
        ${sqlQuote(this.agentId)},
        ${sqlQuote(approval.proposalId)},
        ${sqlInteger(approval.proposalVersion)},
        ${sqlQuote(approval.partyEntityId)},
        ${sqlQuote(approval.approvalRequestId)},
        ${sqlText(approval.invalidatedAt)},
        ${sqlQuote(approval.createdAt)},
        ${sqlQuote(approval.updatedAt)}
      )
      ON CONFLICT(agent_id, proposal_id, proposal_version, party_entity_id)
      DO NOTHING
      RETURNING *`,
    );
    if (rows[0]) return approvalFromRow(rows[0]);
    const existing = (
      await this.listApprovalLinks(
        approval.proposalId,
        approval.proposalVersion,
      )
    ).find((candidate) => candidate.partyEntityId === approval.partyEntityId);
    if (!existing) {
      throw new HouseholdCoordinationError(
        "Approval link conflict did not resolve to a persisted row",
        "HOUSEHOLD_PROPOSAL_CONFLICT",
        {
          proposalId: approval.proposalId,
          proposalVersion: approval.proposalVersion,
          partyEntityId: approval.partyEntityId,
        },
      );
    }
    return existing;
  }

  async listApprovalLinks(
    proposalId: string,
    proposalVersion: number,
  ): Promise<HouseholdProposalApproval[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_household_proposal_approvals
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND proposal_id = ${sqlQuote(proposalId)}
          AND proposal_version = ${sqlInteger(proposalVersion)}
        ORDER BY party_entity_id ASC`,
    );
    return rows.map(approvalFromRow);
  }

  async listInvalidatedApprovalRequestIds(): Promise<string[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT DISTINCT approval_request_id
         FROM app_lifeops.life_household_proposal_approvals
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND invalidated_at IS NOT NULL
        ORDER BY approval_request_id ASC`,
    );
    return rows.map((row) =>
      requiredText(row.approval_request_id, "approvalRequestId"),
    );
  }

  async rejectProposal(input: {
    proposalId: string;
    proposalVersion: number;
    partyEntityId: string;
    reason: string;
    rejectedAt: string;
  }): Promise<string[]> {
    return await withTransaction(this.runtime, async (tx) => {
      const changed = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'rejected',
                updated_at = ${sqlQuote(input.rejectedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(input.proposalId)}
            AND version = ${sqlInteger(input.proposalVersion)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      if (changed.length !== 1) {
        throw new HouseholdCoordinationError(
          `Proposal ${input.proposalId} v${input.proposalVersion} is no longer pending`,
          "HOUSEHOLD_PROPOSAL_CONFLICT",
          {
            proposalId: input.proposalId,
            proposalVersion: input.proposalVersion,
          },
        );
      }
      const invalidatedApprovals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals
            SET invalidated_at = ${sqlQuote(input.rejectedAt)},
                updated_at = ${sqlQuote(input.rejectedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(input.proposalId)}
            AND proposal_version = ${sqlInteger(input.proposalVersion)}
            AND invalidated_at IS NULL
        RETURNING approval_request_id`,
      );
      await insertAudit(tx, this.agentId, {
        kind: "household_proposal_invalidated",
        ownerId: input.proposalId,
        reason: input.reason,
        inputs: {
          proposalVersion: input.proposalVersion,
          partyEntityId: input.partyEntityId,
        },
        decision: {
          status: "rejected",
          rejectedAt: input.rejectedAt,
        },
        actor: "user",
        createdAt: input.rejectedAt,
      });
      return invalidatedApprovals.map((row) =>
        requiredText(row.approval_request_id, "approvalRequestId"),
      );
    });
  }

  async expireProposal(input: {
    proposalId: string;
    proposalVersion: number;
    expiredAt: string;
  }): Promise<string[]> {
    return await withTransaction(this.runtime, async (tx) => {
      const changed = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'expired',
                updated_at = ${sqlQuote(input.expiredAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(input.proposalId)}
            AND version = ${sqlInteger(input.proposalVersion)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      const invalidatedApprovals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals
            SET invalidated_at = COALESCE(invalidated_at, ${sqlQuote(input.expiredAt)}),
                updated_at = CASE
                  WHEN invalidated_at IS NULL THEN ${sqlQuote(input.expiredAt)}
                  ELSE updated_at
                END
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(input.proposalId)}
            AND proposal_version = ${sqlInteger(input.proposalVersion)}
        RETURNING approval_request_id`,
      );
      if (changed.length === 1) {
        await insertAudit(tx, this.agentId, {
          kind: "household_proposal_invalidated",
          ownerId: input.proposalId,
          reason: "The affected-party approval window expired.",
          inputs: {
            proposalVersion: input.proposalVersion,
          },
          decision: {
            status: "expired",
            expiredAt: input.expiredAt,
          },
          actor: "workflow",
          createdAt: input.expiredAt,
        });
      }
      if (changed.length === 0) {
        const rows = await executeRawSqlTx(
          tx,
          `SELECT status
             FROM app_lifeops.life_household_schedule_proposals
            WHERE agent_id = ${sqlQuote(this.agentId)}
              AND proposal_id = ${sqlQuote(input.proposalId)}
              AND version = ${sqlInteger(input.proposalVersion)}
            LIMIT 1`,
        );
        const status = rows[0] ? requiredText(rows[0].status, "status") : null;
        if (status !== "expired") {
          throw new HouseholdCoordinationError(
            `Proposal ${input.proposalId} v${input.proposalVersion} cannot expire from ${status ?? "missing"}`,
            "HOUSEHOLD_PROPOSAL_CONFLICT",
            {
              proposalId: input.proposalId,
              proposalVersion: input.proposalVersion,
              status,
            },
          );
        }
      }
      return invalidatedApprovals.map((row) =>
        requiredText(row.approval_request_id, "approvalRequestId"),
      );
    });
  }

  async activateAgreement(
    agreement: HouseholdScheduleAgreement,
    commitment: LifeOpsCommitmentLedgerRecord,
  ): Promise<{
    invalidatedProposalIds: string[];
    invalidatedApprovalRequestIds: string[];
  }> {
    return await withTransaction(this.runtime, async (tx) => {
      const proposalRows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'accepted',
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND proposal_id = ${sqlQuote(agreement.proposalId)}
            AND version = ${sqlInteger(agreement.proposalVersion)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      if (proposalRows.length !== 1) {
        throw new HouseholdCoordinationError(
          `Proposal ${agreement.proposalId} v${agreement.proposalVersion} is no longer pending`,
          "HOUSEHOLD_PROPOSAL_CONFLICT",
          {
            proposalId: agreement.proposalId,
            proposalVersion: agreement.proposalVersion,
          },
        );
      }
      const headRows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_coordination_heads
            SET current_agreement_version = ${sqlInteger(agreement.version)},
                current_agreement_id = ${sqlQuote(agreement.id)},
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND coordination_id = ${sqlQuote(agreement.coordinationId)}
            AND current_agreement_version = ${sqlInteger(agreement.version - 1)}
        RETURNING id`,
      );
      if (headRows.length !== 1) {
        throw new HouseholdCoordinationError(
          `Coordination ${agreement.coordinationId} advanced while the proposal was awaiting approval`,
          "HOUSEHOLD_STALE_BASE_AGREEMENT",
          {
            coordinationId: agreement.coordinationId,
            expectedVersion: agreement.version - 1,
          },
        );
      }
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_household_schedule_agreements (
          id, agent_id, coordination_id, version, proposal_id,
          proposal_version, terms_json, affected_party_entity_ids_json,
          approved_by_entity_ids_json, activated_at, created_at
        ) VALUES (
          ${sqlQuote(agreement.id)},
          ${sqlQuote(this.agentId)},
          ${sqlQuote(agreement.coordinationId)},
          ${sqlInteger(agreement.version)},
          ${sqlQuote(agreement.proposalId)},
          ${sqlInteger(agreement.proposalVersion)},
          ${sqlJson(agreement.terms)},
          ${sqlJson(agreement.affectedPartyEntityIds)},
          ${sqlJson(agreement.approvedByEntityIds)},
          ${sqlQuote(agreement.activatedAt)},
          ${sqlQuote(agreement.createdAt)}
        )`,
      );
      await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_commitment_ledger
            SET status = 'superseded',
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND status IN ('open', 'tracked')
            AND metadata_json::jsonb ->> 'householdCoordinationId' =
                ${sqlQuote(agreement.coordinationId)}`,
      );
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_commitment_ledger (
          id, agent_id, source, source_key, kind, summary, counterparty,
          due_at, confidence, status, scheduled_task_id, metadata_json,
          created_at, updated_at
        ) VALUES (
          ${sqlQuote(commitment.id)},
          ${sqlQuote(commitment.agentId)},
          ${sqlQuote(commitment.source)},
          ${sqlQuote(commitment.sourceKey)},
          ${sqlQuote(commitment.kind)},
          ${sqlQuote(commitment.summary)},
          ${sqlText(commitment.counterparty)},
          ${sqlText(commitment.dueAt)},
          ${sqlNumber(commitment.confidence)},
          ${sqlQuote(commitment.status)},
          ${sqlText(commitment.scheduledTaskId)},
          ${sqlJson(commitment.metadata)},
          ${sqlQuote(commitment.createdAt)},
          ${sqlQuote(commitment.updatedAt)}
        )`,
      );
      const invalidated = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_schedule_proposals
            SET status = 'invalidated',
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND coordination_id = ${sqlQuote(agreement.coordinationId)}
            AND base_agreement_version < ${sqlInteger(agreement.version)}
            AND status = 'pending'
        RETURNING proposal_id`,
      );
      const invalidatedApprovals = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_household_proposal_approvals AS approval
            SET invalidated_at = ${sqlQuote(agreement.activatedAt)},
                updated_at = ${sqlQuote(agreement.activatedAt)}
          WHERE approval.agent_id = ${sqlQuote(this.agentId)}
            AND approval.invalidated_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM app_lifeops.life_household_schedule_proposals AS proposal
               WHERE proposal.agent_id = approval.agent_id
                 AND proposal.proposal_id = approval.proposal_id
                 AND proposal.version = approval.proposal_version
                 AND proposal.coordination_id = ${sqlQuote(agreement.coordinationId)}
                 AND proposal.status = 'invalidated'
            )
        RETURNING approval_request_id`,
      );
      await insertAudit(tx, this.agentId, {
        kind: "household_proposal_approved",
        ownerId: agreement.proposalId,
        reason:
          "Every required affected-party approval matched this proposal version.",
        inputs: {
          proposalVersion: agreement.proposalVersion,
          approvedByEntityIds: agreement.approvedByEntityIds,
        },
        decision: {
          agreementId: agreement.id,
          agreementVersion: agreement.version,
        },
        actor: "workflow",
        createdAt: agreement.activatedAt,
      });
      await insertAudit(tx, this.agentId, {
        kind: "household_agreement_activated",
        ownerId: agreement.id,
        reason: "The approved proposal became the current household agreement.",
        inputs: {
          proposalId: agreement.proposalId,
          proposalVersion: agreement.proposalVersion,
          affectedPartyEntityIds: agreement.affectedPartyEntityIds,
        },
        decision: {
          coordinationId: agreement.coordinationId,
          agreementVersion: agreement.version,
        },
        actor: "workflow",
        createdAt: agreement.activatedAt,
      });
      for (const row of invalidated) {
        await insertAudit(tx, this.agentId, {
          kind: "household_proposal_invalidated",
          ownerId: requiredText(row.proposal_id, "proposalId"),
          reason: "A competing proposal activated a newer agreement version.",
          inputs: {
            coordinationId: agreement.coordinationId,
          },
          decision: {
            invalidatedAt: agreement.activatedAt,
            currentAgreementVersion: agreement.version,
          },
          actor: "workflow",
          createdAt: agreement.activatedAt,
        });
      }
      return {
        invalidatedProposalIds: invalidated.map((row) =>
          requiredText(row.proposal_id, "proposalId"),
        ),
        invalidatedApprovalRequestIds: invalidatedApprovals.map((row) =>
          requiredText(row.approval_request_id, "approvalRequestId"),
        ),
      };
    });
  }

  async listAgreements(): Promise<HouseholdScheduleAgreement[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT agreement.*, head.current_agreement_id
         FROM app_lifeops.life_household_schedule_agreements AS agreement
         JOIN app_lifeops.life_household_coordination_heads AS head
           ON head.agent_id = agreement.agent_id
          AND head.coordination_id = agreement.coordination_id
        WHERE agreement.agent_id = ${sqlQuote(this.agentId)}
        ORDER BY agreement.activated_at ASC, agreement.id ASC`,
    );
    return rows.map((row) =>
      agreementFromRow(row, optionalText(row.current_agreement_id)),
    );
  }

  async listAudit(): Promise<HouseholdAuditRecord[]> {
    const kinds = HOUSEHOLD_AUDIT_KINDS.map(sqlQuote).join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_audit_events
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND event_type IN (${kinds})
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map((row) => {
      const kind = requiredText(row.event_type, "eventType");
      if (!isHouseholdAuditKind(kind)) {
        throw new HouseholdCoordinationError(
          `Unknown persisted household audit kind: ${kind}`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { kind },
        );
      }
      const actor = requiredText(row.actor, "actor");
      if (actor !== "agent" && actor !== "user" && actor !== "workflow") {
        throw new HouseholdCoordinationError(
          `Unknown persisted household audit actor: ${actor}`,
          "HOUSEHOLD_INVALID_CONTRACT",
          { actor },
        );
      }
      return {
        id: requiredText(row.id, "id"),
        kind,
        ownerId: requiredText(row.owner_id, "ownerId"),
        reason: toText(row.reason),
        inputs: parseJsonRecord(row.inputs_json),
        decision: parseJsonRecord(row.decision_json),
        actor,
        createdAt: requiredText(row.created_at, "createdAt"),
      };
    });
  }
}

/**
 * PostgreSQL persistence for household resources and immutable capacity
 * proposals.
 *
 * Resource definitions use append-only revisions with a transactional head
 * CAS. Proposals are idempotent snapshots; approval and ScheduledTask IDs are
 * attached separately so crash recovery can complete those shared-system
 * artifacts without changing approved bytes.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlJson,
  sqlQuote,
  type TransactionalDb,
  withRequiredTransaction,
} from "../sql.js";
import {
  type HouseholdResourceDefinition,
  type HouseholdResourceRevision,
  normalizeCapacityProposal,
  normalizeResourceDefinition,
  normalizeResourceRevision,
  type ResourceCapacityApprovalLink,
  ResourceCapacityError,
  type ResourceCapacityProposal,
  requireCapacityInteger,
  requireCapacityText,
  requireCapacityTimestamp,
  resourceIdentitySha256,
  resourceRevisionSha256,
} from "./types.js";

const RESOURCE_CAPACITY_SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_resource_capacity_heads (
     agent_id TEXT NOT NULL,
     resource_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     resource_kind TEXT NOT NULL,
     current_revision INTEGER NOT NULL,
     current_content_sha256 TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, resource_id)
   )`,
  `CREATE INDEX IF NOT EXISTS life_resource_capacity_heads_household_idx
     ON app_lifeops.life_resource_capacity_heads
       (agent_id, household_id, resource_kind)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_resource_capacity_revisions (
     agent_id TEXT NOT NULL,
     resource_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     resource_kind TEXT NOT NULL,
     revision INTEGER NOT NULL,
     content_sha256 TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, resource_id, revision)
   )`,
  `CREATE INDEX IF NOT EXISTS life_resource_capacity_revision_history_idx
     ON app_lifeops.life_resource_capacity_revisions
       (agent_id, household_id, resource_id, revision)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_resource_capacity_proposals (
     agent_id TEXT NOT NULL,
     proposal_id TEXT NOT NULL,
     household_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     input_sha256 TEXT NOT NULL,
     content_sha256 TEXT NOT NULL,
     status TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     value_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, proposal_id),
     UNIQUE (agent_id, idempotency_key)
   )`,
  `CREATE INDEX IF NOT EXISTS life_resource_capacity_proposals_household_idx
     ON app_lifeops.life_resource_capacity_proposals
       (agent_id, household_id, status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_resource_capacity_approvals (
     agent_id TEXT NOT NULL,
     proposal_id TEXT NOT NULL,
     proposal_version INTEGER NOT NULL,
     party_entity_id TEXT NOT NULL,
     approval_request_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (
       agent_id, proposal_id, proposal_version, party_entity_id
     ),
     UNIQUE (agent_id, approval_request_id)
   )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_resource_capacity_tasks (
     agent_id TEXT NOT NULL,
     proposal_id TEXT NOT NULL,
     scheduled_task_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, proposal_id),
     UNIQUE (agent_id, scheduled_task_id)
   )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_resource_capacity_task_claims (
     agent_id TEXT NOT NULL,
     proposal_id TEXT NOT NULL,
     attempt_token TEXT NOT NULL,
     lease_expires_at TEXT NOT NULL,
     completed_task_id TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (agent_id, proposal_id)
   )`,
] as const;

function conflict(message: string, context: Record<string, unknown>): never {
  throw new ResourceCapacityError(
    message,
    "RESOURCE_CAPACITY_CONFLICT",
    context,
  );
}

function persistedInvalid(
  message: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ResourceCapacityError(
    message,
    "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
    context,
    cause,
  );
}

function parseJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      // error-policy:J3 Persisted JSON is untrusted input; corruption is an
      // explicit invalid-data result rather than an empty capacity record.
      return persistedInvalid(
        `Persisted resource-capacity row has malformed ${field}`,
        { field },
        error,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return persistedInvalid(
      `Persisted resource-capacity row has invalid ${field}`,
      { field },
    );
  }
  return parsed as Record<string, unknown>;
}

function rowText(
  row: Record<string, unknown>,
  key: string,
  field = key,
): string {
  return requireCapacityText(row[key], field, 2_000);
}

function rowInteger(
  row: Record<string, unknown>,
  key: string,
  field = key,
): number {
  const raw = row[key];
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : Number.NaN;
  return requireCapacityInteger(value, field, 0);
}

function revisionFromRow(
  row: Record<string, unknown>,
): HouseholdResourceRevision {
  const revision = normalizeResourceRevision(
    parseJsonObject(row.value_json, "resource revision"),
  );
  if (
    revision.resourceId !== rowText(row, "resource_id") ||
    revision.householdId !== rowText(row, "household_id") ||
    revision.kind !== rowText(row, "resource_kind") ||
    revision.revision !== rowInteger(row, "revision") ||
    revision.contentSha256 !== rowText(row, "content_sha256")
  ) {
    return persistedInvalid(
      "Persisted resource revision columns do not match its value",
      { resourceId: revision.resourceId, revision: revision.revision },
    );
  }
  return revision;
}

function proposalFromRow(
  row: Record<string, unknown>,
): ResourceCapacityProposal {
  const proposal = normalizeCapacityProposal(
    parseJsonObject(row.value_json, "proposal"),
  );
  if (
    proposal.proposalId !== rowText(row, "proposal_id") ||
    proposal.householdId !== rowText(row, "household_id") ||
    proposal.idempotencyKey !== rowText(row, "idempotency_key") ||
    proposal.inputSha256 !== rowText(row, "input_sha256") ||
    proposal.contentSha256 !== rowText(row, "content_sha256") ||
    proposal.status !== rowText(row, "status") ||
    proposal.expiresAt !==
      requireCapacityTimestamp(row.expires_at, "proposal.expiresAt") ||
    proposal.createdAt !==
      requireCapacityTimestamp(row.created_at, "proposal.createdAt")
  ) {
    return persistedInvalid(
      "Persisted capacity-proposal columns do not match its value",
      { proposalId: proposal.proposalId },
    );
  }
  return proposal;
}

function approvalLinkFromRow(
  row: Record<string, unknown>,
): ResourceCapacityApprovalLink {
  const proposalVersion = rowInteger(
    row,
    "proposal_version",
    "approval.proposalVersion",
  );
  if (proposalVersion !== 1) {
    return persistedInvalid("Capacity approval has an unsupported version", {
      proposalVersion,
    });
  }
  return {
    proposalId: rowText(row, "proposal_id", "approval.proposalId"),
    proposalVersion: 1,
    partyEntityId: rowText(row, "party_entity_id", "approval.partyEntityId"),
    approvalRequestId: rowText(
      row,
      "approval_request_id",
      "approval.approvalRequestId",
    ),
    createdAt: requireCapacityTimestamp(row.created_at, "approval.createdAt"),
  };
}

async function selectRevision(
  tx: TransactionalDb,
  agentId: string,
  resourceId: string,
  revision: number,
): Promise<HouseholdResourceRevision | null> {
  const rows = await executeRawSqlTx(
    tx,
    `SELECT * FROM app_lifeops.life_resource_capacity_revisions
     WHERE agent_id = ${sqlQuote(agentId)}
       AND resource_id = ${sqlQuote(resourceId)}
       AND revision = ${sqlInteger(revision)}
     LIMIT 1`,
  );
  return rows[0] ? revisionFromRow(rows[0]) : null;
}

export class ResourceCapacityRepository {
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        for (const statement of RESOURCE_CAPACITY_SCHEMA) {
          await executeRawSql(this.runtime, statement);
        }
      })();
    }
    return this.schemaReady;
  }

  async putResource(
    definitionValue: HouseholdResourceDefinition,
    expectedRevisionValue: number,
    createdAtValue: string,
  ): Promise<HouseholdResourceRevision> {
    await this.ensureSchema();
    const definition = normalizeResourceDefinition(definitionValue);
    const expectedRevision = requireCapacityInteger(
      expectedRevisionValue,
      "expectedRevision",
      0,
    );
    const createdAt = requireCapacityTimestamp(createdAtValue, "createdAt");
    const revisionNumber = expectedRevision + 1;
    const revision: HouseholdResourceRevision = {
      ...definition,
      revision: revisionNumber,
      contentSha256: resourceRevisionSha256(definition, revisionNumber),
      createdAt,
    };
    return withRequiredTransaction(this.runtime, async (tx) => {
      if (expectedRevision > 0) {
        const previous = await selectRevision(
          tx,
          this.agentId,
          definition.resourceId,
          expectedRevision,
        );
        if (!previous) {
          return conflict("Expected resource revision does not exist", {
            resourceId: definition.resourceId,
            expectedRevision,
          });
        }
        if (
          resourceIdentitySha256(previous) !==
          resourceIdentitySha256(definition)
        ) {
          return conflict(
            "A resource revision cannot change household, id, or kind",
            {
              resourceId: definition.resourceId,
              expectedRevision,
            },
          );
        }
      }
      const existing = await selectRevision(
        tx,
        this.agentId,
        definition.resourceId,
        revisionNumber,
      );
      if (existing) {
        if (existing.contentSha256 === revision.contentSha256) return existing;
        return conflict(
          "A resource revision already exists with different content",
          {
            resourceId: definition.resourceId,
            revision: revisionNumber,
          },
        );
      }
      const heads =
        expectedRevision === 0
          ? await executeRawSqlTx(
              tx,
              `INSERT INTO app_lifeops.life_resource_capacity_heads (
                 agent_id, resource_id, household_id, resource_kind,
                 current_revision, current_content_sha256, updated_at
               ) VALUES (
                 ${sqlQuote(this.agentId)}, ${sqlQuote(definition.resourceId)},
                 ${sqlQuote(definition.householdId)}, ${sqlQuote(definition.kind)},
                 ${sqlInteger(revisionNumber)},
                 ${sqlQuote(revision.contentSha256)}, ${sqlQuote(createdAt)}
               )
               ON CONFLICT (agent_id, resource_id) DO NOTHING
               RETURNING *`,
            )
          : await executeRawSqlTx(
              tx,
              `UPDATE app_lifeops.life_resource_capacity_heads
               SET household_id = ${sqlQuote(definition.householdId)},
                   resource_kind = ${sqlQuote(definition.kind)},
                   current_revision = ${sqlInteger(revisionNumber)},
                   current_content_sha256 = ${sqlQuote(revision.contentSha256)},
                   updated_at = ${sqlQuote(createdAt)}
               WHERE agent_id = ${sqlQuote(this.agentId)}
                 AND resource_id = ${sqlQuote(definition.resourceId)}
                 AND current_revision = ${sqlInteger(expectedRevision)}
               RETURNING *`,
            );
      if (!heads[0]) {
        return conflict("Resource changed concurrently", {
          resourceId: definition.resourceId,
          expectedRevision,
        });
      }
      const rows = await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_resource_capacity_revisions (
           agent_id, resource_id, household_id, resource_kind, revision,
           content_sha256, value_json, created_at
         ) VALUES (
           ${sqlQuote(this.agentId)}, ${sqlQuote(definition.resourceId)},
           ${sqlQuote(definition.householdId)}, ${sqlQuote(definition.kind)},
           ${sqlInteger(revisionNumber)}, ${sqlQuote(revision.contentSha256)},
           ${sqlJson(revision)}, ${sqlQuote(createdAt)}
         )
         RETURNING *`,
      );
      if (!rows[0]) {
        return persistedInvalid("Resource revision insert returned no row", {
          resourceId: definition.resourceId,
          revision: revisionNumber,
        });
      }
      return revisionFromRow(rows[0]);
    });
  }

  async getCurrentResource(
    resourceIdValue: string,
  ): Promise<HouseholdResourceRevision | null> {
    await this.ensureSchema();
    const resourceId = requireCapacityText(resourceIdValue, "resourceId");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT revisions.*
       FROM app_lifeops.life_resource_capacity_heads AS heads
       JOIN app_lifeops.life_resource_capacity_revisions AS revisions
         ON revisions.agent_id = heads.agent_id
        AND revisions.resource_id = heads.resource_id
        AND revisions.revision = heads.current_revision
       WHERE heads.agent_id = ${sqlQuote(this.agentId)}
         AND heads.resource_id = ${sqlQuote(resourceId)}
       LIMIT 1`,
    );
    return rows[0] ? revisionFromRow(rows[0]) : null;
  }

  async listCurrentResources(
    householdIdValue: string,
  ): Promise<HouseholdResourceRevision[]> {
    await this.ensureSchema();
    const householdId = requireCapacityText(householdIdValue, "householdId");
    return (
      await executeRawSql(
        this.runtime,
        `SELECT revisions.*
         FROM app_lifeops.life_resource_capacity_heads AS heads
         JOIN app_lifeops.life_resource_capacity_revisions AS revisions
           ON revisions.agent_id = heads.agent_id
          AND revisions.resource_id = heads.resource_id
          AND revisions.revision = heads.current_revision
         WHERE heads.agent_id = ${sqlQuote(this.agentId)}
           AND heads.household_id = ${sqlQuote(householdId)}
         ORDER BY heads.resource_kind ASC, heads.resource_id ASC`,
      )
    ).map(revisionFromRow);
  }

  async insertProposal(
    proposalValue: ResourceCapacityProposal,
  ): Promise<{ proposal: ResourceCapacityProposal; inserted: boolean }> {
    await this.ensureSchema();
    const proposal = normalizeCapacityProposal(proposalValue);
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_resource_capacity_proposals (
         agent_id, proposal_id, household_id, idempotency_key, input_sha256,
         content_sha256, status, expires_at, value_json, created_at
       ) VALUES (
         ${sqlQuote(this.agentId)}, ${sqlQuote(proposal.proposalId)},
         ${sqlQuote(proposal.householdId)}, ${sqlQuote(proposal.idempotencyKey)},
         ${sqlQuote(proposal.inputSha256)}, ${sqlQuote(proposal.contentSha256)},
         ${sqlQuote(proposal.status)}, ${sqlQuote(proposal.expiresAt)},
         ${sqlJson(proposal)}, ${sqlQuote(proposal.createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) {
      return { proposal: proposalFromRow(rows[0]), inserted: true };
    }
    const idempotentRows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_resource_capacity_proposals
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND idempotency_key = ${sqlQuote(proposal.idempotencyKey)}
       LIMIT 1`,
    );
    const existing = idempotentRows[0]
      ? proposalFromRow(idempotentRows[0])
      : null;
    if (!existing) {
      return conflict("Proposal identifier collided with another request", {
        proposalId: proposal.proposalId,
        idempotencyKey: proposal.idempotencyKey,
      });
    }
    if (existing.inputSha256 !== proposal.inputSha256) {
      return conflict(
        "Proposal idempotency key was reused for different capacity input",
        {
          proposalId: existing.proposalId,
          idempotencyKey: proposal.idempotencyKey,
        },
      );
    }
    return { proposal: existing, inserted: false };
  }

  async getProposal(
    proposalIdValue: string,
  ): Promise<ResourceCapacityProposal | null> {
    await this.ensureSchema();
    const proposalId = requireCapacityText(proposalIdValue, "proposalId");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_resource_capacity_proposals
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND proposal_id = ${sqlQuote(proposalId)}
       LIMIT 1`,
    );
    return rows[0] ? proposalFromRow(rows[0]) : null;
  }

  async getProposalByIdempotencyKey(
    idempotencyKeyValue: string,
  ): Promise<ResourceCapacityProposal | null> {
    await this.ensureSchema();
    const idempotencyKey = requireCapacityText(
      idempotencyKeyValue,
      "idempotencyKey",
    );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_resource_capacity_proposals
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND idempotency_key = ${sqlQuote(idempotencyKey)}
       LIMIT 1`,
    );
    return rows[0] ? proposalFromRow(rows[0]) : null;
  }

  async listUnexpiredReviewProposals(
    householdIdValue: string,
    atValue: string,
  ): Promise<ResourceCapacityProposal[]> {
    await this.ensureSchema();
    const householdId = requireCapacityText(householdIdValue, "householdId");
    const at = requireCapacityTimestamp(atValue, "at");
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_resource_capacity_proposals
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND household_id = ${sqlQuote(householdId)}
           AND status = 'pending_review'
           AND expires_at > ${sqlQuote(at)}
         ORDER BY created_at ASC, proposal_id ASC`,
      )
    ).map(proposalFromRow);
  }

  async insertApprovalLink(
    linkValue: ResourceCapacityApprovalLink,
  ): Promise<ResourceCapacityApprovalLink> {
    await this.ensureSchema();
    const link: ResourceCapacityApprovalLink = {
      proposalId: requireCapacityText(
        linkValue.proposalId,
        "approval.proposalId",
      ),
      proposalVersion: 1,
      partyEntityId: requireCapacityText(
        linkValue.partyEntityId,
        "approval.partyEntityId",
      ),
      approvalRequestId: requireCapacityText(
        linkValue.approvalRequestId,
        "approval.approvalRequestId",
      ),
      createdAt: requireCapacityTimestamp(
        linkValue.createdAt,
        "approval.createdAt",
      ),
    };
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_resource_capacity_approvals (
         agent_id, proposal_id, proposal_version, party_entity_id,
         approval_request_id, created_at
       ) VALUES (
         ${sqlQuote(this.agentId)}, ${sqlQuote(link.proposalId)}, 1,
         ${sqlQuote(link.partyEntityId)}, ${sqlQuote(link.approvalRequestId)},
         ${sqlQuote(link.createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
    );
    if (rows[0]) return approvalLinkFromRow(rows[0]);
    const existingRows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_resource_capacity_approvals
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND proposal_id = ${sqlQuote(link.proposalId)}
         AND proposal_version = 1
         AND party_entity_id = ${sqlQuote(link.partyEntityId)}
       LIMIT 1`,
    );
    const existing = existingRows[0]
      ? approvalLinkFromRow(existingRows[0])
      : null;
    if (!existing || existing.approvalRequestId !== link.approvalRequestId) {
      return conflict("Proposal approval link collided", {
        proposalId: link.proposalId,
        partyEntityId: link.partyEntityId,
      });
    }
    return existing;
  }

  async listApprovalLinks(
    proposalIdValue: string,
  ): Promise<ResourceCapacityApprovalLink[]> {
    await this.ensureSchema();
    const proposalId = requireCapacityText(proposalIdValue, "proposalId");
    return (
      await executeRawSql(
        this.runtime,
        `SELECT * FROM app_lifeops.life_resource_capacity_approvals
         WHERE agent_id = ${sqlQuote(this.agentId)}
           AND proposal_id = ${sqlQuote(proposalId)}
           AND proposal_version = 1
         ORDER BY party_entity_id ASC`,
      )
    ).map(approvalLinkFromRow);
  }

  async attachReviewTask(
    proposalIdValue: string,
    scheduledTaskIdValue: string,
    createdAtValue: string,
  ): Promise<string> {
    await this.ensureSchema();
    const proposalId = requireCapacityText(proposalIdValue, "proposalId");
    const scheduledTaskId = requireCapacityText(
      scheduledTaskIdValue,
      "scheduledTaskId",
    );
    const createdAt = requireCapacityTimestamp(createdAtValue, "createdAt");
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_resource_capacity_tasks (
         agent_id, proposal_id, scheduled_task_id, created_at
       ) VALUES (
         ${sqlQuote(this.agentId)}, ${sqlQuote(proposalId)},
         ${sqlQuote(scheduledTaskId)}, ${sqlQuote(createdAt)}
       )
       ON CONFLICT DO NOTHING
       RETURNING scheduled_task_id`,
    );
    if (rows[0]) {
      return rowText(rows[0], "scheduled_task_id", "scheduledTaskId");
    }
    const existing = await this.getReviewTaskId(proposalId);
    if (existing !== scheduledTaskId) {
      return conflict("Proposal review task link collided", {
        proposalId,
        scheduledTaskId,
        existing,
      });
    }
    return existing;
  }

  async getReviewTaskId(proposalIdValue: string): Promise<string | null> {
    await this.ensureSchema();
    const proposalId = requireCapacityText(proposalIdValue, "proposalId");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT scheduled_task_id
       FROM app_lifeops.life_resource_capacity_tasks
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND proposal_id = ${sqlQuote(proposalId)}
       LIMIT 1`,
    );
    return rows[0]
      ? rowText(rows[0], "scheduled_task_id", "scheduledTaskId")
      : null;
  }

  async claimReviewTask(input: {
    proposalId: string;
    attemptToken: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<
    | { kind: "claimed" }
    | { kind: "busy" }
    | { kind: "complete"; scheduledTaskId: string }
  > {
    await this.ensureSchema();
    const proposalId = requireCapacityText(input.proposalId, "proposalId");
    const attemptToken = requireCapacityText(
      input.attemptToken,
      "attemptToken",
    );
    const now = requireCapacityTimestamp(input.now, "now");
    const leaseExpiresAt = requireCapacityTimestamp(
      input.leaseExpiresAt,
      "leaseExpiresAt",
    );
    const completed = await this.getReviewTaskId(proposalId);
    if (completed) {
      return { kind: "complete", scheduledTaskId: completed };
    }
    const inserted = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_resource_capacity_task_claims (
         agent_id, proposal_id, attempt_token, lease_expires_at,
         completed_task_id, updated_at
       ) VALUES (
         ${sqlQuote(this.agentId)}, ${sqlQuote(proposalId)},
         ${sqlQuote(attemptToken)}, ${sqlQuote(leaseExpiresAt)},
         NULL, ${sqlQuote(now)}
       )
       ON CONFLICT DO NOTHING
       RETURNING attempt_token`,
    );
    if (inserted[0]) return { kind: "claimed" };
    const claimed = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_resource_capacity_task_claims
       SET attempt_token = ${sqlQuote(attemptToken)},
           lease_expires_at = ${sqlQuote(leaseExpiresAt)},
           updated_at = ${sqlQuote(now)}
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND proposal_id = ${sqlQuote(proposalId)}
         AND completed_task_id IS NULL
         AND lease_expires_at <= ${sqlQuote(now)}
       RETURNING attempt_token`,
    );
    if (claimed[0]) return { kind: "claimed" };
    const rows = await executeRawSql(
      this.runtime,
      `SELECT completed_task_id
       FROM app_lifeops.life_resource_capacity_task_claims
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND proposal_id = ${sqlQuote(proposalId)}
       LIMIT 1`,
    );
    const completedTaskId =
      rows[0]?.completed_task_id === null ||
      rows[0]?.completed_task_id === undefined
        ? null
        : requireCapacityText(rows[0].completed_task_id, "completedTaskId");
    return completedTaskId
      ? { kind: "complete", scheduledTaskId: completedTaskId }
      : { kind: "busy" };
  }

  async completeReviewTaskClaim(input: {
    proposalId: string;
    attemptToken: string;
    scheduledTaskId: string;
    completedAt: string;
  }): Promise<string> {
    await this.ensureSchema();
    const proposalId = requireCapacityText(input.proposalId, "proposalId");
    const attemptToken = requireCapacityText(
      input.attemptToken,
      "attemptToken",
    );
    const scheduledTaskId = requireCapacityText(
      input.scheduledTaskId,
      "scheduledTaskId",
    );
    const completedAt = requireCapacityTimestamp(
      input.completedAt,
      "completedAt",
    );
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_resource_capacity_task_claims
       SET completed_task_id = ${sqlQuote(scheduledTaskId)},
           updated_at = ${sqlQuote(completedAt)}
       WHERE agent_id = ${sqlQuote(this.agentId)}
         AND proposal_id = ${sqlQuote(proposalId)}
         AND attempt_token = ${sqlQuote(attemptToken)}
         AND completed_task_id IS NULL
       RETURNING completed_task_id`,
    );
    if (rows[0]) {
      return rowText(rows[0], "completed_task_id", "completedTaskId");
    }
    const existing = await this.getReviewTaskId(proposalId);
    if (existing === scheduledTaskId) return existing;
    return conflict("Review task claim was lost before completion", {
      proposalId,
      scheduledTaskId,
    });
  }
}

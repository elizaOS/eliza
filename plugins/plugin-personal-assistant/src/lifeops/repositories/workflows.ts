/** Owns workflow definitions and atomic idempotency claims for workflow runs. */
import { ElizaError } from "@elizaos/core";
import type {
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowRun,
} from "../../contracts/index.js";
import type { LifeOpsDatabaseContext } from "../sql.js";
import { executeRawSql, sqlJson, sqlQuote, sqlText } from "../sql.js";
import {
  assertValidWorkflowRunIdempotencyKey,
  parseWorkflowDefinition,
  parseWorkflowRun,
  TERMINAL_WORKFLOW_RUN_STATUSES,
} from "./workflow-records.js";
export class WorkflowRepository {
  constructor(private readonly runtime: LifeOpsDatabaseContext) {}
  async createWorkflow(definition: LifeOpsWorkflowDefinition): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_workflow_definitions (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, title, trigger_type, schedule_json, action_plan_json,
        permission_policy_json, status, created_by, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(definition.id)},
        ${sqlQuote(definition.agentId)},
        ${sqlQuote(definition.domain)},
        ${sqlQuote(definition.subjectType)},
        ${sqlQuote(definition.subjectId)},
        ${sqlQuote(definition.visibilityScope)},
        ${sqlQuote(definition.contextPolicy)},
        ${sqlQuote(definition.title)},
        ${sqlQuote(definition.triggerType)},
        ${sqlJson(definition.schedule)},
        ${sqlJson(definition.actionPlan)},
        ${sqlJson(definition.permissionPolicy)},
        ${sqlQuote(definition.status)},
        ${sqlQuote(definition.createdBy)},
        ${sqlJson(definition.metadata)},
        ${sqlQuote(definition.createdAt)},
        ${sqlQuote(definition.updatedAt)}
      )`,
    );
  }

  async updateWorkflow(definition: LifeOpsWorkflowDefinition): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_definitions
          SET domain = ${sqlQuote(definition.domain)},
              subject_type = ${sqlQuote(definition.subjectType)},
              subject_id = ${sqlQuote(definition.subjectId)},
              visibility_scope = ${sqlQuote(definition.visibilityScope)},
              context_policy = ${sqlQuote(definition.contextPolicy)},
              title = ${sqlQuote(definition.title)},
              trigger_type = ${sqlQuote(definition.triggerType)},
              schedule_json = ${sqlJson(definition.schedule)},
              action_plan_json = ${sqlJson(definition.actionPlan)},
              permission_policy_json = ${sqlJson(definition.permissionPolicy)},
              status = ${sqlQuote(definition.status)},
              metadata_json = ${sqlJson(definition.metadata)},
              updated_at = ${sqlQuote(definition.updatedAt)}
        WHERE id = ${sqlQuote(definition.id)}
          AND agent_id = ${sqlQuote(definition.agentId)}`,
    );
  }

  async listWorkflows(agentId: string): Promise<LifeOpsWorkflowDefinition[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_workflow_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC`,
    );
    return rows.map(parseWorkflowDefinition);
  }

  async deleteWorkflow(agentId: string, workflowId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_workflow_runs
        WHERE agent_id = ${sqlQuote(agentId)}
          AND workflow_id = ${sqlQuote(workflowId)}`,
    );
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_browser_sessions
         SET workflow_id = NULL
       WHERE agent_id = ${sqlQuote(agentId)}
         AND workflow_id = ${sqlQuote(workflowId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_workflow_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(workflowId)}`,
    );
  }

  async getWorkflow(
    agentId: string,
    workflowId: string,
  ): Promise<LifeOpsWorkflowDefinition | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_workflow_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(workflowId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseWorkflowDefinition(row) : null;
  }

  async createWorkflowRun(run: LifeOpsWorkflowRun): Promise<void> {
    assertValidWorkflowRunIdempotencyKey(run.idempotencyKey);
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_workflow_runs (
        id, agent_id, workflow_id, idempotency_key, started_at, finished_at,
        status, result_json, audit_ref
      ) VALUES (
        ${sqlQuote(run.id)},
        ${sqlQuote(run.agentId)},
        ${sqlQuote(run.workflowId)},
        ${sqlText(run.idempotencyKey)},
        ${sqlQuote(run.startedAt)},
        ${sqlText(run.finishedAt)},
        ${sqlQuote(run.status)},
        ${sqlJson(run.result)},
        ${sqlText(run.auditRef)}
      )`,
    );
  }

  async claimWorkflowRun(run: LifeOpsWorkflowRun): Promise<boolean> {
    assertValidWorkflowRunIdempotencyKey(run.idempotencyKey);
    if (run.status !== "running" || run.finishedAt !== null) {
      throw new ElizaError(
        "[LifeOpsRepository] Workflow run claims must be unfinished running records",
        {
          code: "LIFEOPS_WORKFLOW_RUN_CLAIM_INVALID",
          context: {
            runId: run.id,
            status: run.status,
            finishedAt: run.finishedAt,
          },
        },
      );
    }
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_workflow_runs (
        id, agent_id, workflow_id, idempotency_key, started_at, finished_at,
        status, result_json, audit_ref
      ) VALUES (
        ${sqlQuote(run.id)},
        ${sqlQuote(run.agentId)},
        ${sqlQuote(run.workflowId)},
        ${sqlText(run.idempotencyKey)},
        ${sqlQuote(run.startedAt)},
        NULL,
        'running',
        ${sqlJson(run.result)},
        ${sqlText(run.auditRef)}
      )
      ON CONFLICT (agent_id, workflow_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id`,
    );
    return rows.length === 1;
  }

  async getWorkflowRunByIdempotencyKey(
    agentId: string,
    workflowId: string,
    idempotencyKey: string,
  ): Promise<LifeOpsWorkflowRun | null> {
    assertValidWorkflowRunIdempotencyKey(idempotencyKey);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_workflow_runs
        WHERE agent_id = ${sqlQuote(agentId)}
          AND workflow_id = ${sqlQuote(workflowId)}
          AND idempotency_key = ${sqlQuote(idempotencyKey)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseWorkflowRun(row) : null;
  }

  async completeWorkflowRun(run: LifeOpsWorkflowRun): Promise<boolean> {
    assertValidWorkflowRunIdempotencyKey(run.idempotencyKey);
    if (
      !TERMINAL_WORKFLOW_RUN_STATUSES.has(run.status) ||
      run.finishedAt === null
    ) {
      throw new ElizaError(
        "[LifeOpsRepository] Workflow run completion requires a terminal status and finish time",
        {
          code: "LIFEOPS_WORKFLOW_RUN_COMPLETION_INVALID",
          context: {
            runId: run.id,
            status: run.status,
            finishedAt: run.finishedAt,
          },
        },
      );
    }
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_runs
          SET finished_at = ${sqlQuote(run.finishedAt)},
              status = ${sqlQuote(run.status)},
              result_json = ${sqlJson(run.result)},
              audit_ref = ${sqlText(run.auditRef)}
        WHERE id = ${sqlQuote(run.id)}
          AND agent_id = ${sqlQuote(run.agentId)}
          AND workflow_id = ${sqlQuote(run.workflowId)}
          AND idempotency_key IS NOT DISTINCT FROM ${sqlText(run.idempotencyKey)}
          AND status = 'running'
          AND finished_at IS NULL
      RETURNING id`,
    );
    return rows.length === 1;
  }

  async listWorkflowRuns(
    agentId: string,
    workflowId: string,
  ): Promise<LifeOpsWorkflowRun[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_workflow_runs
        WHERE agent_id = ${sqlQuote(agentId)}
          AND workflow_id = ${sqlQuote(workflowId)}
        ORDER BY started_at DESC`,
    );
    return rows.map(parseWorkflowRun);
  }
}

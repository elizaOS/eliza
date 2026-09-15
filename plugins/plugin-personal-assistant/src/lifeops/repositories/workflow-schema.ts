/** Defines and validates the workflow-run idempotency index used by compatibility repair. */
import { ElizaError } from "@elizaos/core";

export const WORKFLOW_RUN_IDEMPOTENCY_BACKFILL_MARKER =
  "elizaos:life_workflow_runs:idempotency-backfill:v1";

export const WORKFLOW_RUN_IDEMPOTENCY_BACKFILL_BATCH_SIZE = 500;

export const WORKFLOW_RUN_IDEMPOTENCY_INDEX_DEFINITION_QUERY = `SELECT
       pg_catalog.pg_get_indexdef(index_catalog.indexrelid) AS indexdef,
       index_catalog.indisunique AS is_unique,
       index_catalog.indisvalid AS is_valid,
       index_catalog.indisready AS is_ready
  FROM pg_catalog.pg_index AS index_catalog
  JOIN pg_catalog.pg_class AS index_class
    ON index_class.oid = index_catalog.indexrelid
  JOIN pg_catalog.pg_namespace AS index_namespace
    ON index_namespace.oid = index_class.relnamespace
  JOIN pg_catalog.pg_class AS table_class
    ON table_class.oid = index_catalog.indrelid
  JOIN pg_catalog.pg_namespace AS table_namespace
    ON table_namespace.oid = table_class.relnamespace
 WHERE index_namespace.nspname = 'app_lifeops'
   AND index_class.relname = 'idx_life_workflow_runs_idempotency'
   AND table_namespace.nspname = 'app_lifeops'
   AND table_class.relname = 'life_workflow_runs'`;

export function assertWorkflowRunIdempotencyIndexDefinition(
  rows: Array<Record<string, unknown>>,
): void {
  const indexDefinition =
    typeof rows[0]?.indexdef === "string" ? rows[0].indexdef : "";
  const indexDefinitionIsExpected =
    rows[0]?.is_unique === true &&
    rows[0]?.is_valid === true &&
    rows[0]?.is_ready === true &&
    /\bUNIQUE INDEX\b/i.test(indexDefinition) &&
    /\(agent_id, workflow_id, idempotency_key\)/i.test(indexDefinition) &&
    /WHERE \(idempotency_key IS NOT NULL\)/i.test(indexDefinition);
  if (!indexDefinitionIsExpected) {
    throw new ElizaError(
      "[LifeOpsRepository] idx_life_workflow_runs_idempotency exists but is not the expected partial unique index or is not usable — drop or rename the conflicting index so the workflow-run claim election can be installed",
      {
        code: "LIFEOPS_WORKFLOW_RUN_IDEMPOTENCY_INDEX_MISMATCH",
        context: {
          indexDefinition,
          isUnique: rows[0]?.is_unique,
          isValid: rows[0]?.is_valid,
          isReady: rows[0]?.is_ready,
        },
      },
    );
  }
}

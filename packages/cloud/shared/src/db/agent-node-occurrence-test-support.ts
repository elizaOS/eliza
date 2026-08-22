/** Test-only helpers for exercising migration-owned Docker-node occurrence authority. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_OCCURRENCE_MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations/0301_agent_node_occurrence_trigger.sql",
);

/**
 * Install only the function and trigger that `pushSchema` cannot derive from
 * the Drizzle schema. Reading them from the migration prevents test fixtures
 * from drifting away from the production occurrence-token authority.
 */
export async function installAgentNodeOccurrenceTriggerForTests(
  executeStatement: (statement: string) => Promise<unknown>,
): Promise<void> {
  const statements = readFileSync(NODE_OCCURRENCE_MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.includes('CREATE OR REPLACE FUNCTION "journal_agent_node_incarnation"()') ||
        statement.includes('CREATE TRIGGER "docker_nodes_incarnation_history"'),
    );
  if (
    statements.length !== 2 ||
    !statements[0]?.includes('CREATE OR REPLACE FUNCTION "journal_agent_node_incarnation"()') ||
    !statements[1]?.includes('CREATE TRIGGER "docker_nodes_incarnation_history"')
  ) {
    throw new Error("node occurrence migration trigger statements are missing or reordered");
  }
  for (const statement of statements) await executeStatement(statement);
}

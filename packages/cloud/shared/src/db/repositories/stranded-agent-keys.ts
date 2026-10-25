/** Atomically identifies and removes expired sandbox credentials with no live sandbox. */
import { and, eq, like, lt, sql } from "drizzle-orm";
import { dbWrite } from "../helpers";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { type ApiKey, apiKeys } from "../schemas/api-keys";

const KEY_PREFIX = "agent-sandbox:";

export const strandedAgentKeyRepository = {
  /** The correlated guard is evaluated in the delete statement, preventing a select/delete race. */
  async deleteOlderThan(olderThan: Date): Promise<ApiKey[]> {
    return dbWrite
      .delete(apiKeys)
      .where(
        and(
          eq(apiKeys.is_active, true),
          like(apiKeys.name, `${KEY_PREFIX}%`),
          lt(apiKeys.created_at, olderThan),
          sql`NOT EXISTS (
            SELECT 1 FROM ${agentSandboxes}
            WHERE ${agentSandboxes.id}::text = substring(${apiKeys.name} from ${sql.raw(
              String(KEY_PREFIX.length + 1),
            )})
          )`,
        ),
      )
      .returning();
  },
};

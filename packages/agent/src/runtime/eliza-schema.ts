/**
 * Canonical database schema owned by the runtime's `eliza` plugin. Consumers
 * that must rerun this migration identity use the complete schema so they
 * cannot interpret another runtime-owned table as removed.
 */

import { knowledgeGraphSchema } from "../services/knowledge-graph/index.ts";
import { pendantSessionSchema } from "../services/pendant-session/index.ts";

export const elizaPluginSchema = {
  ...knowledgeGraphSchema,
  ...pendantSessionSchema,
} as const;

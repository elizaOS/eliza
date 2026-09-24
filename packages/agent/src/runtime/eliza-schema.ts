/** Host schema ownership, including retained tables from retired services. */
import { knowledgeGraphSchema } from "@elizaos/plugin-relationships/knowledge-graph";
import { pendantSessionSchema } from "./legacy-pendant-schema.ts";

export const elizaSchema = {
  ...knowledgeGraphSchema,
  ...pendantSessionSchema,
};

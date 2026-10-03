/** Host schema ownership, including retained tables from retired services. */
import { knowledgeGraphSchema } from "@elizaos/plugin-relationships";
import { pendantSessionSchema } from "./legacy-pendant-schema.ts";

export const elizaSchema = {
  ...knowledgeGraphSchema,
  ...pendantSessionSchema,
};

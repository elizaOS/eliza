export { entityAction } from "./actions/entity.js";
export type { EntityActionParameters } from "./actions/entity.js";
export {
  entitiesTable,
  type EntityInsert,
  type EntityRow,
  relationshipsSchema,
  relationshipsTable,
  type RelationshipInsert,
  type RelationshipRow,
} from "./db/schema.js";
export { relationshipsPlugin } from "./plugin.js";
export { entityGraphProvider } from "./providers/entity-graph.js";
export * from "./types.js";

import { relationshipsPlugin } from "./plugin.js";

export default relationshipsPlugin;

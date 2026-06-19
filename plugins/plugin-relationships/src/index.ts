export type { EntityActionParameters } from "./actions/entity.js";
export { entityAction } from "./actions/entity.js";
export {
  type EntityInsert,
  type EntityRow,
  entitiesTable,
  type RelationshipInsert,
  type RelationshipRow,
  relationshipsSchema,
  relationshipsTable,
} from "./db/schema.js";
export { relationshipsPlugin } from "./plugin.js";
export { entityGraphProvider } from "./providers/entity-graph.js";
export * from "./types.js";

import { relationshipsPlugin } from "./plugin.js";

export default relationshipsPlugin;

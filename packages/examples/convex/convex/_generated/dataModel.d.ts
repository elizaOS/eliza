/* eslint-disable */
/**
 * Stable local data model types for TypeScript checks before Convex codegen
 * has run. `npx convex dev` regenerates the runtime files in this directory.
 */

import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  SystemTableNames,
  TableNamesInDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type TableNames = TableNamesInDataModel<DataModel>;
export type Doc<TableName extends TableNames> = DocumentByName<
  DataModel,
  TableName
>;
export type Id<TableName extends TableNames | SystemTableNames> =
  GenericId<TableName>;

import type { SchemaSnapshot } from "../types";
import type { SchemaDiff } from "./diff-calculator";
/**
 * Data loss detection result
 * Based on Drizzle's pgPushUtils approach
 */
export interface DataLossCheck {
  hasDataLoss: boolean;
  tablesToRemove: string[];
  columnsToRemove: string[];
  tablesToTruncate: string[];
  typeChanges: Array<{
    table: string;
    column: string;
    from: string;
    to: string;
  }>;
  warnings: string[];
  requiresConfirmation: boolean;
}
/**
 * Check for potential data loss in schema changes
 * Based on Drizzle's pgSuggestions function
 */
export declare function checkForDataLoss(diff: SchemaDiff): DataLossCheck;
/**
 * Generate SQL statements from a schema diff
 * This follows Drizzle's approach: create all tables first, then add foreign keys
 */
export declare function generateMigrationSQL(
  previousSnapshot: SchemaSnapshot | null,
  currentSnapshot: SchemaSnapshot,
  diff?: SchemaDiff,
): Promise<string[]>;
/**
 * Generate SQL for renaming a table
 */
export declare function generateRenameTableSQL(
  oldName: string,
  newName: string,
): string;
/**
 * Generate SQL for renaming a column
 */
export declare function generateRenameColumnSQL(
  table: string,
  oldName: string,
  newName: string,
): string;
//# sourceMappingURL=sql-generator.d.ts.map

import type { SchemaSnapshot } from "../types";
export interface SchemaDiff {
  tables: {
    created: string[];
    deleted: string[];
    modified: Array<{
      name: string;
      changes: any;
    }>;
  };
  columns: {
    added: Array<{
      table: string;
      column: string;
      definition: any;
    }>;
    deleted: Array<{
      table: string;
      column: string;
    }>;
    modified: Array<{
      table: string;
      column: string;
      changes: any;
    }>;
  };
  indexes: {
    created: any[];
    deleted: any[];
    altered: Array<{
      old: any;
      new: any;
    }>;
  };
  foreignKeys: {
    created: any[];
    deleted: any[];
    altered: Array<{
      old: any;
      new: any;
    }>;
  };
  uniqueConstraints: {
    created: any[];
    deleted: any[];
  };
  checkConstraints: {
    created: any[];
    deleted: any[];
  };
}
/**
 * Calculate the difference between two snapshots
 */
export declare function calculateDiff(
  previousSnapshot: SchemaSnapshot | null,
  currentSnapshot: SchemaSnapshot,
): Promise<SchemaDiff>;
/**
 * Check if a diff has any changes
 */
export declare function hasDiffChanges(diff: SchemaDiff): boolean;
//# sourceMappingURL=diff-calculator.d.ts.map

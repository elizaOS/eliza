import type { SchemaSnapshot } from "../types";
/**
 * Generate a snapshot from a Drizzle schema
 * This is a port of Drizzle's pgSerializer.generatePgSnapshot
 */
export declare function generateSnapshot(schema: any): Promise<SchemaSnapshot>;
/**
 * Calculate hash of a snapshot for change detection
 */
export declare function hashSnapshot(snapshot: SchemaSnapshot): string;
/**
 * Create an empty snapshot for initial migration
 */
export declare function createEmptySnapshot(): SchemaSnapshot;
/**
 * Compare two snapshots and detect if there are changes
 */
export declare function hasChanges(
  previousSnapshot: SchemaSnapshot | null,
  currentSnapshot: SchemaSnapshot,
): boolean;
//# sourceMappingURL=snapshot-generator.d.ts.map

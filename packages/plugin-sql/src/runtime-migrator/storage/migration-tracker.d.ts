import type { DrizzleDB } from "../types";
export declare class MigrationTracker {
  private db;
  constructor(db: DrizzleDB);
  ensureSchema(): Promise<void>;
  ensureTables(): Promise<void>;
  getLastMigration(pluginName: string): Promise<{
    id: number;
    hash: string;
    created_at: string;
  } | null>;
  recordMigration(
    pluginName: string,
    hash: string,
    createdAt: number,
  ): Promise<void>;
}
//# sourceMappingURL=migration-tracker.d.ts.map

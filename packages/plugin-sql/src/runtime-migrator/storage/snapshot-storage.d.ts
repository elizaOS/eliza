import type { DrizzleDB, SchemaSnapshot } from "../types";
export declare class SnapshotStorage {
  private db;
  constructor(db: DrizzleDB);
  saveSnapshot(
    pluginName: string,
    idx: number,
    snapshot: SchemaSnapshot,
  ): Promise<void>;
  loadSnapshot(pluginName: string, idx: number): Promise<SchemaSnapshot | null>;
  getLatestSnapshot(pluginName: string): Promise<SchemaSnapshot | null>;
  getAllSnapshots(pluginName: string): Promise<SchemaSnapshot[]>;
}
//# sourceMappingURL=snapshot-storage.d.ts.map

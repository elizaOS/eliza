/** Selects the native driver for file-backed or temporary SQLite storage. */
import type { UUID } from "@elizaos/core";
import { nativeSQLiteDriver } from "./sqlite-driver";
import { SQLiteStorageBase } from "./storage-base";
export class SQLiteStorage extends SQLiteStorageBase {
  constructor(path: string, agentId: UUID) {
    super(path, agentId, nativeSQLiteDriver);
  }
}

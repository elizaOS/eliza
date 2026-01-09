import type { DrizzleDB, Journal, JournalEntry } from "../types";
export declare class JournalStorage {
  private db;
  constructor(db: DrizzleDB);
  loadJournal(pluginName: string): Promise<Journal | null>;
  saveJournal(pluginName: string, journal: Journal): Promise<void>;
  addEntry(pluginName: string, entry: JournalEntry): Promise<void>;
  getNextIdx(pluginName: string): Promise<number>;
  updateJournal(
    pluginName: string,
    idx: number,
    tag: string,
    breakpoints?: boolean,
  ): Promise<void>;
}
//# sourceMappingURL=journal-storage.d.ts.map

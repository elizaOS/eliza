import { sql } from "drizzle-orm";
import type { DrizzleDB, Journal, JournalEntry } from "../types";
import { getMysqlRow } from "../types";

export class JournalStorage {
  constructor(private db: DrizzleDB) {}

  async loadJournal(pluginName: string): Promise<Journal | null> {
    const result = await this.db.execute(
      sql`SELECT version, dialect, entries
          FROM _eliza_journal
          WHERE plugin_name = ${pluginName}`
    );

    const row = getMysqlRow<{
      version: string;
      dialect: string;
      entries: JournalEntry[] | string;
    }>(result);

    if (!row) {
      return null;
    }

    // MySQL JSON columns may return a string or parsed object
    const entries = typeof row.entries === "string" ? JSON.parse(row.entries) : row.entries;

    return {
      version: row.version,
      dialect: row.dialect,
      entries: entries as JournalEntry[],
    };
  }

  async saveJournal(pluginName: string, journal: Journal): Promise<void> {
    const entriesJson = JSON.stringify(journal.entries);
    await this.db.execute(
      sql`INSERT INTO _eliza_journal (plugin_name, version, dialect, entries)
          VALUES (${pluginName}, ${journal.version}, ${journal.dialect}, CAST(${entriesJson} AS JSON))
          ON DUPLICATE KEY UPDATE
            version = VALUES(version),
            dialect = VALUES(dialect),
            entries = VALUES(entries)`
    );
  }

  async addEntry(pluginName: string, entry: JournalEntry): Promise<void> {
    // First, get the current journal
    let journal = await this.loadJournal(pluginName);

    // If no journal exists, create a new one
    if (!journal) {
      journal = {
        version: "7", // Latest Drizzle version
        dialect: "mysql",
        entries: [],
      };
    }

    // Add the new entry
    journal.entries.push(entry);

    // Save the updated journal
    await this.saveJournal(pluginName, journal);
  }

  async getNextIdx(pluginName: string): Promise<number> {
    const journal = await this.loadJournal(pluginName);

    if (!journal || journal.entries.length === 0) {
      return 0;
    }

    const lastEntry = journal.entries[journal.entries.length - 1];
    return lastEntry.idx + 1;
  }

  async updateJournal(
    pluginName: string,
    idx: number,
    tag: string,
    breakpoints: boolean = true
  ): Promise<void> {
    const entry: JournalEntry = {
      idx,
      version: "7",
      when: Date.now(),
      tag,
      breakpoints,
    };

    await this.addEntry(pluginName, entry);
  }
}

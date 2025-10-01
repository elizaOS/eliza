import { sql } from 'drizzle-orm';
import type { DrizzleDB, Journal, JournalEntry } from '../types';

export class JournalStorage {
  constructor(private db: DrizzleDB) {}

  async loadJournal(pluginName: string): Promise<Journal | null> {
    const result = await this.db.execute(
      sql`SELECT version, dialect, entries 
          FROM migrations._journal 
          WHERE plugin_name = ${pluginName}`
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0] as any;
    return {
      version: row.version,
      dialect: row.dialect,
      entries: row.entries as JournalEntry[],
    };
  }

  async saveJournal(pluginName: string, journal: Journal): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO migrations._journal (plugin_name, version, dialect, entries)
          VALUES (${pluginName}, ${journal.version}, ${journal.dialect}, ${JSON.stringify(journal.entries)}::jsonb)
          ON CONFLICT (plugin_name) 
          DO UPDATE SET 
            version = EXCLUDED.version,
            dialect = EXCLUDED.dialect,
            entries = EXCLUDED.entries`
    );
  }

  async addEntry(pluginName: string, entry: JournalEntry): Promise<void> {
    // First, get the current journal
    let journal = await this.loadJournal(pluginName);

    // If no journal exists, create a new one
    if (!journal) {
      journal = {
        version: '7', // Latest Drizzle version
        dialect: 'postgresql',
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
      version: '7',
      when: Date.now(),
      tag,
      breakpoints,
    };

    await this.addEntry(pluginName, entry);
  }
}

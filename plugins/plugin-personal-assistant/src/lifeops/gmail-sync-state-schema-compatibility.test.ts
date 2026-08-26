/**
 * Guards the persisted Gmail synchronization cursor contract consumed by
 * existing LifeOps databases. The assertions inspect the real Drizzle table
 * descriptor because removing one of these columns makes runtime migration
 * planning destructive and prevents the packaged desktop agent from booting.
 */
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { lifeGmailSyncStates } from "./schema";

describe("Gmail sync-state schema compatibility", () => {
  it("retains the durable history cursor without a destructive migration", () => {
    const columns = getTableColumns(lifeGmailSyncStates);

    expect(columns.historyId.name).toBe("history_id");
    expect(columns.cursorStatus.name).toBe("cursor_status");
    expect(columns.cursorStatus.notNull).toBe(true);
    expect(columns.cursorStatus.default).toBe("seeded");
    expect(columns.fullResyncReason.name).toBe("full_resync_reason");
  });
});

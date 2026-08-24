/** Proves upgrades keep legacy session summaries in plugin-sql's owned schema. */
import { describe, expect, it } from "vitest";
import { generateSnapshot } from "../../runtime-migrator/drizzle-adapters/snapshot-generator";
import { sessionSummaries } from "../../schema/sessionSummaries";

describe("legacy session summaries migration compatibility", () => {
  it("keeps the existing table and indexes in the runtime migration snapshot", async () => {
    const snapshot = await generateSnapshot({ sessionSummaries });
    const table = snapshot.tables["public.session_summaries"];

    expect(table).toBeDefined();
    expect(table.columns.summary).toBeDefined();
    expect(table.columns.message_count).toBeDefined();
    expect(Object.keys(table.indexes).sort()).toEqual([
      "session_summaries_agent_room_idx",
      "session_summaries_entity_idx",
      "session_summaries_start_time_idx",
    ]);
  });
});

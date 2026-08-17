/** Proves Twilio call history accepts canonical personal Shared agent keys. */

import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

describe("0212 Twilio personal Shared agent ids", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it("preserves UUID history and accepts a personal:<uuid> agent key", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(`
      CREATE TABLE twilio_inbound_calls (
        id uuid PRIMARY KEY,
        call_sid text NOT NULL UNIQUE,
        agent_id uuid
      );
      INSERT INTO twilio_inbound_calls (id, call_sid, agent_id)
      VALUES (
        '00000000-0000-4000-8000-000000000001',
        'CA-legacy',
        '11111111-1111-4111-a111-111111111111'
      );
      `);
    const migration = await readFile(
      new URL("./migrations/0212_twilio_personal_agent_ids.sql", import.meta.url),
      "utf8",
    );

    await database.exec(migration);
    await database.exec(`
      INSERT INTO twilio_inbound_calls (id, call_sid, agent_id)
      VALUES (
        '00000000-0000-4000-8000-000000000002',
        'CA-personal',
        'personal:22222222-2222-5222-a222-222222222222'
      );
      `);

    const rows = await database.query(
      `SELECT call_sid, agent_id
         FROM twilio_inbound_calls
        ORDER BY call_sid`,
    );
    expect(rows.rows).toEqual([
      {
        call_sid: "CA-legacy",
        agent_id: "11111111-1111-4111-a111-111111111111",
      },
      {
        call_sid: "CA-personal",
        agent_id: "personal:22222222-2222-5222-a222-222222222222",
      },
    ]);
  }, 30_000);
});

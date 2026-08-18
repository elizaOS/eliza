/** Proves Twilio call openers atomically retain their first continuity snapshot. */

import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { twilioInboundCalls } from "./schemas/twilio-inbound-calls";

type OpeningContextRow = {
  call_sid: string;
  opening_returning_caller: boolean | null;
  opening_previous_interaction_at: Date | null;
};

const claimOpeningContextSql = `
  INSERT INTO twilio_inbound_calls (
    id,
    call_sid,
    opening_returning_caller,
    opening_previous_interaction_at
  ) VALUES ($1, $2, $3, $4)
  ON CONFLICT (call_sid) DO UPDATE SET
    opening_previous_interaction_at = CASE
      WHEN twilio_inbound_calls.opening_returning_caller IS NULL
        THEN excluded.opening_previous_interaction_at
      ELSE twilio_inbound_calls.opening_previous_interaction_at
    END,
    opening_returning_caller = COALESCE(
      twilio_inbound_calls.opening_returning_caller,
      excluded.opening_returning_caller
    )
  RETURNING
    call_sid,
    opening_returning_caller,
    opening_previous_interaction_at
`;

describe("0246 Twilio call opening context", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it("declares the migration invariant in the canonical Drizzle schema", () => {
    expect(
      getTableConfig(twilioInboundCalls).checks.map((constraint) => constraint.name),
    ).toContain("twilio_inbound_calls_opening_context_shape_check");
  });

  it("claims one snapshot and preserves it across delayed prior history", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(`
      CREATE TABLE twilio_inbound_calls (
        id uuid PRIMARY KEY,
        call_sid text NOT NULL UNIQUE
      );
      INSERT INTO twilio_inbound_calls (id, call_sid)
      VALUES ('00000000-0000-4000-8000-000000000001', 'CA-legacy');
    `);
    const migration = await readFile(
      new URL("./migrations/0269_twilio_call_opening_context.sql", import.meta.url),
      "utf8",
    );

    await database.exec(migration);
    await database.exec(migration);

    const first = await database.query<OpeningContextRow>(claimOpeningContextSql, [
      "00000000-0000-4000-8000-000000000002",
      "CA-new",
      false,
      null,
    ]);
    const duplicateAfterDelayedHistory = await database.query<OpeningContextRow>(
      claimOpeningContextSql,
      ["00000000-0000-4000-8000-000000000003", "CA-new", true, "2026-08-17T18:59:59.999Z"],
    );
    expect(first.rows).toEqual([
      {
        call_sid: "CA-new",
        opening_returning_caller: false,
        opening_previous_interaction_at: null,
      },
    ]);
    expect(duplicateAfterDelayedHistory.rows).toEqual(first.rows);

    const claimedLegacy = await database.query<OpeningContextRow>(claimOpeningContextSql, [
      "00000000-0000-4000-8000-000000000004",
      "CA-legacy",
      true,
      "2026-08-17T17:00:00.000Z",
    ]);
    const duplicateLegacy = await database.query<OpeningContextRow>(claimOpeningContextSql, [
      "00000000-0000-4000-8000-000000000005",
      "CA-legacy",
      false,
      null,
    ]);
    expect(duplicateLegacy.rows).toEqual(claimedLegacy.rows);
    expect(claimedLegacy.rows[0]?.opening_returning_caller).toBe(true);
    expect(claimedLegacy.rows[0]?.opening_previous_interaction_at).toEqual(
      new Date("2026-08-17T17:00:00.000Z"),
    );

    await expect(
      database.query(claimOpeningContextSql, [
        "00000000-0000-4000-8000-000000000006",
        "CA-invalid",
        false,
        "2026-08-17T17:00:00.000Z",
      ]),
    ).rejects.toThrow(/opening_context_shape_check/);
  }, 30_000);
});

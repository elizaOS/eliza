/** Durable Network consent appends are idempotent per provider message. */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresNetworkConsentWriter, networkConsentEntrySchema } from "./consent";

test("STOP is appended once and replays are no-ops", async () => {
  const database = new PGlite();
  try {
    await database.exec(
      await readFile(new URL("../../db/migrations/0474_network_core.sql", import.meta.url), "utf8"),
    );
    const writer = createPostgresNetworkConsentWriter(drizzle(database));
    const entry = networkConsentEntrySchema.parse({
      project: "network",
      channel: "twilio",
      address: "+14155550123",
      state: "opted_out",
      source: "keyword:STOP",
      providerMessageId: "SM1",
      at: "2026-10-06T18:00:00.000Z",
    });
    expect(await writer.append(entry)).toEqual({ recorded: true });
    expect(await writer.append(entry)).toEqual({ recorded: false });
    expect(
      await writer.append({
        ...entry,
        state: "opted_in",
        source: "keyword:START",
        providerMessageId: "SM2",
      }),
    ).toEqual({ recorded: true });
    const rows = await database.query<{ state: string; source: string }>(
      `SELECT state, source FROM network.consent_ledger ORDER BY provider_message_id`,
    );
    expect(rows.rows).toEqual([
      { state: "opted_out", source: "keyword:STOP" },
      { state: "opted_in", source: "keyword:START" },
    ]);
    expect(networkConsentEntrySchema.safeParse({ ...entry, project: "eliza-app" }).success).toBe(
      false,
    );
  } finally {
    await database.close();
  }
});

/** Applies the Network schema migration to real PGlite and proves its invariants. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { networkConsentLedger, networkInvites, networkMembers } from "./network/schema";

/** Drizzle builders are thenables; `expect(...).rejects` needs a real Promise. */
function run(query: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(query);
}

async function migration(): Promise<string> {
  return await readFile(new URL("./migrations/0474_network_core.sql", import.meta.url), "utf8");
}

describe("0474 Network core schema", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("is registered on the canonical journal after every existing entry", async () => {
    const journal = JSON.parse(
      await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const index = journal.entries.findIndex((entry) => entry.tag === "0474_network_core");
    expect(index).toBe(journal.entries.length - 1);
    const entry = journal.entries[index]!;
    const previous = journal.entries[index - 1]!;
    expect(entry.idx).toBe(previous.idx + 1);
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  test("creates only the network schema, is idempotent, and matches the typed schema", async () => {
    const database = new PGlite();
    databases.push(database);
    const sql = await migration();
    await database.exec(sql);
    await database.exec(sql);

    const tables = await database.query<{ table_schema: string; table_name: string }>(`
      SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name
    `);
    expect(tables.rows).toEqual([
      { table_schema: "network", table_name: "consent_ledger" },
      { table_schema: "network", table_name: "invites" },
      { table_schema: "network", table_name: "members" },
    ]);

    const db = drizzle(database);
    const [member] = await db
      .insert(networkMembers)
      .values({ phoneE164: "+14155550100", firstName: "Ada" })
      .returning();
    expect(member?.state).toBe("open");
    await db.insert(networkInvites).values({
      phoneE164: "+14155550101",
      tokenHash: "hash-1",
      invitedByMemberId: member!.id,
    });
    const [invite] = await db
      .update(networkInvites)
      .set({ status: "accepted", acceptedAt: new Date(), acceptedMemberId: member!.id })
      .where(eq(networkInvites.tokenHash, "hash-1"))
      .returning();
    expect(invite?.status).toBe("accepted");
  });

  test("enforces phone format, member state, invite acceptance, and an append-only consent ledger", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(await migration());
    const db = drizzle(database);

    await expect(
      run(db.insert(networkMembers).values({ phoneE164: "4155550100" })),
    ).rejects.toThrow();
    await expect(
      run(db.insert(networkMembers).values({ phoneE164: "+14155550100", state: "asleep" })),
    ).rejects.toThrow();
    await db.insert(networkMembers).values({ phoneE164: "+14155550100" });
    await expect(
      run(db.insert(networkMembers).values({ phoneE164: "+14155550100" })),
    ).rejects.toThrow();
    // A Cloud account link is all-or-nothing.
    await expect(
      run(
        db.insert(networkMembers).values({
          phoneE164: "+14155550102",
          cloudUserId: "00000000-0000-4000-8000-000000000001",
        }),
      ),
    ).rejects.toThrow();
    // Accepted invites must carry their acceptance time, and only then.
    await expect(
      run(
        db.insert(networkInvites).values({
          phoneE164: "+14155550103",
          tokenHash: "hash-accepted-without-time",
          status: "accepted",
        }),
      ),
    ).rejects.toThrow();

    await db.insert(networkConsentLedger).values({
      channel: "twilio",
      address: "+14155550100",
      state: "opted_out",
      source: "keyword:STOP",
      providerMessageId: "SM1",
    });
    // Replaying the same provider keyword cannot double-record.
    await expect(
      run(
        db.insert(networkConsentLedger).values({
          channel: "twilio",
          address: "+14155550100",
          state: "opted_out",
          source: "keyword:STOP",
          providerMessageId: "SM1",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      database.exec(`UPDATE "network"."consent_ledger" SET "state" = 'opted_in'`),
    ).rejects.toThrow(/append-only/);
    await expect(database.exec(`DELETE FROM "network"."consent_ledger"`)).rejects.toThrow(
      /append-only/,
    );
  });
});

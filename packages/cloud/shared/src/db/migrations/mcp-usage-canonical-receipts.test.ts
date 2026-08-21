/**
 * Applies the canonical MCP receipt migration to real PGlite, including a
 * pre-migration row, replay, transitional legacy writer, and corrupt money.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await Bun.file(
  new URL("./0296_mcp_usage_canonical_receipts.sql", import.meta.url),
).text();
const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`CREATE TABLE mcp_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    credits_charged numeric(10,4) DEFAULT '0.0000'
  )`);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0296 canonical MCP usage receipts", () => {
  test("backfills legacy points value-preservingly and replays idempotently", async () => {
    const db = await database();
    await db.exec("INSERT INTO mcp_usage (credits_charged) VALUES ('1.2345')");
    await db.exec(migration);
    await db.exec(migration);

    const result = await db.query<{
      credits_charged: string;
      base_amount_usd: string;
      affiliate_fee_usd: string;
      platform_fee_usd: string;
      total_amount_usd: string;
      fee_components_known: boolean;
    }>(`SELECT credits_charged::text, base_amount_usd::text,
      affiliate_fee_usd::text, platform_fee_usd::text, total_amount_usd::text,
      fee_components_known FROM mcp_usage`);
    expect(result.rows).toEqual([
      {
        credits_charged: "1.2345",
        base_amount_usd: "0.012345",
        affiliate_fee_usd: "0.000000",
        platform_fee_usd: "0.000000",
        total_amount_usd: "0.012345",
        fee_components_known: false,
      },
    ]);
  });

  test("keeps an overlapping legacy writer value-preserving", async () => {
    const db = await database();
    await db.exec(migration);
    const result = await db.query<{ base: string; total: string; known: boolean }>(
      `INSERT INTO mcp_usage (credits_charged) VALUES ('0.0001')
       RETURNING base_amount_usd::text AS base, total_amount_usd::text AS total,
         fee_components_known AS known`,
    );
    expect(result.rows).toEqual([{ base: "0.000001", total: "0.000001", known: false }]);
  });

  test("accepts coherent known fees and rejects corrupt or inconsistent money", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(`INSERT INTO mcp_usage (
      credits_charged, base_amount_usd, affiliate_fee_usd, platform_fee_usd,
      total_amount_usd, fee_components_known
    ) VALUES ('1', '0.01', '0.001', '0.002', '0.013', true)`);
    const aggregate = await db.query<{
      base: string;
      affiliate: string;
      platform: string;
      total: string;
    }>(`SELECT sum(base_amount_usd)::text AS base,
      sum(affiliate_fee_usd)::text AS affiliate,
      sum(platform_fee_usd)::text AS platform,
      sum(total_amount_usd)::text AS total FROM mcp_usage`);
    expect(aggregate.rows).toEqual([
      {
        base: "0.010000",
        affiliate: "0.001000",
        platform: "0.002000",
        total: "0.013000",
      },
    ]);
    await expect(
      db.exec(`INSERT INTO mcp_usage (
      base_amount_usd, affiliate_fee_usd, platform_fee_usd, total_amount_usd
    ) VALUES ('NaN', 0, 0, 'NaN')`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO mcp_usage (
      base_amount_usd, affiliate_fee_usd, platform_fee_usd, total_amount_usd
    ) VALUES ('0.01', '0.001', '0.002', '0.012')`),
    ).rejects.toThrow();
  });
});

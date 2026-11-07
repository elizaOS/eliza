import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { assertRetirementUnapplied } from "./exact-gmail-ledger-recovery";

const sql = await readFile(
  new URL(
    "../../shared/src/db/migrations/0500_retire_creator_monetization.sql",
    import.meta.url,
  ),
  "utf8",
);
test("fresh retirement freezes available plus pending and preserves financial history without payout", async () => {
  const db = new PGlite("memory://");
  try {
    await db.exec(`CREATE TABLE organizations(id uuid PRIMARY KEY,pay_as_you_go_from_earnings boolean DEFAULT true,credit_balance numeric);
   CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid);
   CREATE TABLE user_characters(monetization_enabled boolean);
   CREATE TABLE apps(monetization_enabled boolean);
   CREATE TABLE redeemable_earnings(user_id uuid, total_earned numeric,total_redeemed numeric,total_converted_to_credits numeric,available_balance numeric,total_pending numeric,earned_from_miniapps numeric,earned_from_agents numeric,earned_from_mcps numeric,earned_from_affiliates numeric,earned_from_app_owner_shares numeric,earned_from_creator_shares numeric);
   CREATE TABLE financial_history(kind text,amount numeric,at timestamptz);
   INSERT INTO organizations VALUES('00000000-0000-4000-8000-000000000001',true,42);
   INSERT INTO users VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
   INSERT INTO user_characters VALUES(true); INSERT INTO apps VALUES(true);
   INSERT INTO redeemable_earnings VALUES('00000000-0000-4000-8000-000000000002',40,20,0,15,5,0,0,30,10,0,0);
   INSERT INTO financial_history VALUES('affiliate',10,now()-interval '1 day'); BEGIN;`);
    await assertRetirementUnapplied(db);
    const before = await db.query("SELECT * FROM redeemable_earnings");
    await db.exec(sql);
    const statement = await db.query<{
      unpaid: string;
      available: string;
      pending: string;
    }>(
      "SELECT unpaid_balance_usd::text AS unpaid,available_balance_usd::text AS available,pending_redemption_usd::text AS pending FROM creator_earnings_retirement_statements",
    );
    expect(statement.rows[0]).toEqual({
      unpaid: "20.0000",
      available: "15.0000",
      pending: "5.0000",
    });
    expect((await db.query("SELECT * FROM redeemable_earnings")).rows).toEqual(
      before.rows,
    );
    expect(
      (
        await db.query(
          "SELECT credit_balance::text AS credits,pay_as_you_go_from_earnings FROM organizations",
        )
      ).rows[0],
    ).toEqual({ credits: "42", pay_as_you_go_from_earnings: false });
    expect(
      (
        await db.query<{ monetization_enabled: boolean }>(
          "SELECT monetization_enabled FROM apps UNION ALL SELECT monetization_enabled FROM user_characters",
        )
      ).rows.every((r) => r.monetization_enabled === false),
    ).toBe(true);
    // A post-retirement affiliate credit cannot rewrite the frozen liability.
    await db.exec(
      "COMMIT; INSERT INTO financial_history VALUES('affiliate',3,clock_timestamp()); UPDATE redeemable_earnings SET available_balance=available_balance+3, earned_from_affiliates=earned_from_affiliates+3;",
    );
    expect(
      (
        await db.query(
          "SELECT unpaid_balance_usd::text AS unpaid FROM creator_earnings_retirement_statements",
        )
      ).rows[0],
    ).toEqual({ unpaid: "20.0000" });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS payouts FROM financial_history WHERE kind='payout'",
        )
      ).rows[0],
    ).toEqual({ payouts: 0 });
    expect(
      (await db.query("SELECT count(*)::int AS n FROM financial_history"))
        .rows[0],
    ).toEqual({ n: 2 });
  } finally {
    await db.close();
  }
});
test("partial retirement sentinel or statements reject before source replay", async () => {
  for (const name of [
    "creator_monetization_retirement",
    "creator_earnings_retirement_statements",
  ]) {
    const db = new PGlite("memory://");
    try {
      await db.exec(
        `CREATE TABLE ${name}(private_value text); INSERT INTO ${name} VALUES('PRIVATE_STALE_STATE'); BEGIN READ ONLY`,
      );
      await expect(assertRetirementUnapplied(db)).rejects.toThrow(
        "retirement_preexisting_state",
      );
      expect(
        (await db.query(`SELECT private_value FROM ${name}`)).rows[0],
      ).toEqual({ private_value: "PRIVATE_STALE_STATE" });
      await db.exec("COMMIT");
    } finally {
      await db.close();
    }
  }
});

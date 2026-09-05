/** Applies the shipped migration and proves replay and revocation fences survive database writes. */
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const source = await Bun.file(
  new URL("./migrations/0376_outreachr_delegations.sql", import.meta.url),
).text();
const appId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";

describe("Outreachr primary delegation authority", () => {
  test("one authorization code mints one grant, including after revocation", async () => {
    const database = new PGlite();
    try {
      await database.exec(`CREATE TABLE apps(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE organizations(id uuid PRIMARY KEY);
        INSERT INTO apps VALUES('${appId}'); INSERT INTO users VALUES('${userId}'); INSERT INTO organizations VALUES('${orgId}');`);
      await database.exec(source);
      await database.exec(source);
      const insert = (token: string) =>
        database.query(
          `INSERT INTO outreachr_delegations(token_hash,authorization_code_hash,app_id,user_id,organization_id,registration_digest,expires_at)
        VALUES($1,'one-code',$2,$3,$4,'registration',now()+interval '1 day') ON CONFLICT DO NOTHING RETURNING token_hash`,
          [token, appId, userId, orgId],
        );
      const results = await Promise.all([insert("token-one"), insert("token-two")]);
      expect(results.reduce((count, result) => count + result.rows.length, 0)).toBe(1);
      await database.exec("UPDATE outreachr_delegations SET revoked_at=now()");
      expect(
        (await database.query("SELECT * FROM outreachr_delegations WHERE revoked_at IS NULL")).rows,
      ).toHaveLength(0);
      expect((await insert("token-after-revocation")).rows).toHaveLength(0);
      await database.query("DELETE FROM apps WHERE id=$1", [appId]);
      expect((await database.query("SELECT * FROM outreachr_delegations")).rows).toHaveLength(0);
    } finally {
      await database.close();
    }
  }, 30_000);
});

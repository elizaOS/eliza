/** Applies the shipped migration and proves replay, revocation, and account-deletion behavior. */
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const source = await Bun.file(
  new URL("./migrations/0376_outreachr_delegations.sql", import.meta.url),
).text();
const appId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";

describe("Outreachr primary delegation authority", () => {
  test.each(["users", "organizations"] as const)(
    "deleting %s erases its grants while preserving another account's authority",
    async (table) => {
      const database = new PGlite();
      const otherUserId = "44444444-4444-4444-8444-444444444444";
      const otherOrgId = "55555555-5555-4555-8555-555555555555";
      try {
        await database.exec(`CREATE TABLE apps(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE organizations(id uuid PRIMARY KEY);
          INSERT INTO apps VALUES('${appId}'); INSERT INTO users VALUES('${userId}'),('${otherUserId}'); INSERT INTO organizations VALUES('${orgId}'),('${otherOrgId}');`);
        await database.exec(source);
        await database.query(
          `INSERT INTO outreachr_delegations(token_hash,authorization_code_hash,app_id,user_id,organization_id,registration_digest,expires_at)
           VALUES ('deleted-grant','deleted-code',$1,$2,$3,'registration',now()+interval '1 day'),
                  ('retained-grant','retained-code',$1,$4,$5,'registration',now()+interval '1 day')`,
          [appId, userId, orgId, otherUserId, otherOrgId],
        );
        expect(
          (await database.query("SELECT token_hash FROM outreachr_delegations ORDER BY token_hash"))
            .rows,
        ).toEqual([{ token_hash: "deleted-grant" }, { token_hash: "retained-grant" }]);

        await database.query(`DELETE FROM ${table} WHERE id=$1`, [
          table === "users" ? userId : orgId,
        ]);

        expect((await database.query("SELECT token_hash FROM outreachr_delegations")).rows).toEqual(
          [{ token_hash: "retained-grant" }],
        );
      } finally {
        await database.close();
      }
    },
    30_000,
  );

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

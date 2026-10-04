/** Real PostgreSQL organization confirmation serialization. Provider mutation is deliberately absent. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `upgrade_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let commands: typeof import("./organization-upgrade-commands");
let quotes: typeof import("./organization-upgrade-quotes");
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function seed() {
  const f = await seedOrganizationUpgradeTestAccount((text, values) => db.query(text, values));
  const quote = await quotes.saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    review: f.review,
  });
  return {
    ...f,
    quote,
    confirm: {
      organizationId: f.input.organizationId,
      actorId: f.input.actorId,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    },
  };
}
async function count(organizationId: string) {
  return (
    await db.query(
      "SELECT count(*)::int AS count FROM billing_subscription_commands WHERE organization_id=$1",
      [organizationId],
    )
  ).rows[0].count;
}
(url ? describe : describe.skip)("organization upgrade confirmation PostgreSQL authority", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((q) => db.query(q));
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    target.searchParams.set("application_name", schema);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    process.env.LOCAL_PG_POOL_MAX = "4";
    commands = await import("./organization-upgrade-commands");
    quotes = await import("./organization-upgrade-quotes");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("concurrent confirmations with different retry keys admit one original command", async () => {
    const f = await seed();
    const results = await Promise.all([
      commands.prepareOrganizationUpgrade(f.confirm),
      commands.prepareOrganizationUpgrade({ ...f.confirm, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter((x) => x.created)).toHaveLength(1);
    expect(new Set(results.map((x) => x.command.id)).size).toBe(1);
    expect(results[0]!.command.status).toBe("PREPARED");
    expect(results[0]!.command.provider_started_at).toBeNull();
    expect(await count(f.input.organizationId)).toBe(1);
    const quote = await db.query(
      "SELECT consumed_by_command_id FROM organization_plan_change_quotes WHERE id=$1",
      [f.quote.id],
    );
    expect(quote.rows[0].consumed_by_command_id).toBe(results[0]!.command.id);
  });
  test("same idempotency key cannot switch the reviewed quote; competing intent is also blocked", async () => {
    const f = await seed();
    const second = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      review: f.review,
    });
    await commands.prepareOrganizationUpgrade(f.confirm);
    await expect(
      commands.prepareOrganizationUpgrade({ ...f.confirm, quoteId: second.id }),
    ).rejects.toThrow();
    await expect(
      commands.prepareOrganizationUpgrade({
        ...f.confirm,
        quoteId: second.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await count(f.input.organizationId)).toBe(1);
  });
  test("another actor or organization cannot consume or replay a quote", async () => {
    const f = await seed(),
      other = await seed();
    await expect(
      commands.prepareOrganizationUpgrade({ ...other.confirm, quoteId: f.quote.id }),
    ).rejects.toThrow();
    await commands.prepareOrganizationUpgrade(f.confirm);
    await expect(
      commands.prepareOrganizationUpgrade({ ...f.confirm, actorId: other.input.actorId }),
    ).rejects.toThrow();
    expect(await count(other.input.organizationId)).toBe(0);
  });
  test("a different current administrator cannot take over the original actor's quote", async () => {
    const f = await seed();
    const administrator = randomUUID();
    await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'admin')", [
      administrator,
      f.input.organizationId,
    ]);
    await expect(
      commands.prepareOrganizationUpgrade({ ...f.confirm, actorId: administrator }),
    ).rejects.toThrow();
    const original = await commands.prepareOrganizationUpgrade(f.confirm);
    await expect(
      commands.prepareOrganizationUpgrade({
        ...f.confirm,
        actorId: administrator,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    expect((await commands.prepareOrganizationUpgrade(f.confirm)).command.id).toBe(
      original.command.id,
    );
    expect(await count(f.input.organizationId)).toBe(1);
  });
  test("retry after review expiry returns the original command without new admission", async () => {
    const f = await seed();
    const expiresAt = new Date(Date.now() + 2000);
    const quote = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      review: { ...f.review, expiresAt: expiresAt.toISOString() },
    });
    const input = { ...f.confirm, quoteId: quote.id };
    const original = await commands.prepareOrganizationUpgrade(input);
    await Bun.sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 50);
    const replay = await commands.prepareOrganizationUpgrade({
      ...input,
      idempotencyKey: randomUUID(),
    });
    expect(replay.created).toBe(false);
    expect(replay.command.id).toBe(original.command.id);
    expect(replay.command.provider_started_at).toBeNull();
    expect(await count(f.input.organizationId)).toBe(1);
  });
  test("quote-link persistence failure rolls back the command insert", async () => {
    const f = await seed();
    await db.query(
      `CREATE FUNCTION reject_fixture_quote_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.quote.id}'::uuid AND NEW.consumed_by_command_id IS NOT NULL THEN RAISE EXCEPTION 'fixture storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture_quote_link BEFORE UPDATE ON organization_plan_change_quotes FOR EACH ROW EXECUTE FUNCTION reject_fixture_quote_link();`,
    );
    try {
      await expect(commands.prepareOrganizationUpgrade(f.confirm)).rejects.toThrow();
      expect(await count(f.input.organizationId)).toBe(0);
      expect(
        (await quotes.readOrganizationUpgradeQuote(f.input, f.quote.id)).consumed_by_command_id,
      ).toBeNull();
    } finally {
      await db.query(
        "DROP TRIGGER reject_fixture_quote_link ON organization_plan_change_quotes; DROP FUNCTION reject_fixture_quote_link()",
      );
    }
  });
  test("actor revocation while waiting for organization authority blocks confirmation", async () => {
    const f = await seed();
    const holder = new Client({ connectionString: url });
    await holder.connect();
    await holder.query(`SET search_path TO ${schema},public`);
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        f.input.organizationId,
      ]);
      pending = commands.prepareOrganizationUpgrade(f.confirm).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let waiting = false;
      for (let i = 0; i < 500; i++) {
        const result = await db.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE '%organizations%FOR UPDATE%'",
          [schema],
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await Bun.sleep(20);
      }
      expect(waiting).toBe(true);
      await holder.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({
        error: { code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" },
      });
      expect(await count(f.input.organizationId)).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      await pending;
      await holder.end();
    }
  });
});

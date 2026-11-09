/** Independent PostgreSQL writers at the campaign/refund transaction boundary. */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Client } from "pg";
import { testOutputPath } from "../../../../../../scripts/lib/test-output.ts";
import { adAccounts } from "../../../db/schemas/ad-accounts";
import { adCampaigns } from "../../../db/schemas/ad-campaigns";
import { adTransactions } from "../../../db/schemas/ad-transactions";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import {
  organizationBalanceRevisionSequence,
  organizations,
} from "../../../db/schemas/organizations";

const sourceUrl =
  process.env.AD_CAMPAIGN_REFUND_TEST_POSTGRES_URL ??
  process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const schema = `ad_refund_${randomUUID().replaceAll("-", "")}`;
const applicationName = schema;
const organizationId = randomUUID();
const accountId = randomUUID();
const campaignId = randomUUID();
let setup: Client;
let locker: Client;
let observer: Client;
let writer: Client;
let service: typeof import("./index").advertisingService;
let closeDatabases: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let restoreCache: (() => void) | undefined;
const waits: Array<{ label: string; blocker: number; waiter: number }> = [];

async function waitOn(blocker: number, label: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))",
      [applicationName, blocker],
    );
    const pid = result.rows[0]?.pid;
    if (pid) {
      waits.push({ label, blocker, waiter: pid });
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Did not observe the expected PostgreSQL wait: ${label}`);
}
async function lockBarrier() {
  const key = randomInt(1, 1_000_000_000);
  await locker.query("SELECT pg_advisory_lock($1)", [key]);
  const { rows } = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return { key, pid: rows[0]!.pid };
}
async function waitForWriter(waiter: number, blocker: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2=ANY(pg_blocking_pids($1)) AS blocked",
      [waiter, blocker],
    );
    if (result.rows[0]?.blocked) {
      waits.push({ label: "spend waits for deletion", blocker, waiter });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Did not observe the spend waiting for deletion");
}
async function result() {
  const { rows } = await observer.query<{
    balance: string;
    campaigns: number;
    credits: number;
    ledger: number;
  }>(
    `SELECT credit_balance::text AS balance,
      (SELECT count(*)::int FROM ad_campaigns) AS campaigns,
      (SELECT count(*)::int FROM credit_transactions) AS credits,
      (SELECT count(*)::int FROM ad_transactions) AS ledger
     FROM organizations WHERE id=$1`,
    [organizationId],
  );
  return rows[0];
}

(sourceUrl ? describe : describe.skip)("campaign refund on real PostgreSQL", () => {
  beforeAll(async () => {
    const parsed = new URL(sourceUrl!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !parsed.username.startsWith("qa_")
    ) {
      throw new Error("Campaign tests require an isolated loopback PostgreSQL qa_* role");
    }
    setup = new Client({ connectionString: sourceUrl });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public`);
    for (const statement of await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({
        organizations,
        organizationBalanceRevisionSequence,
        creditTransactions,
        adAccounts,
        adCampaigns,
        adTransactions,
      }),
    )) {
      if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
      // Drizzle explicitly qualifies sequences with public; keep every fixture
      // object in this run's schema so concurrent/repeated checks are isolated.
      await setup.query(statement.replaceAll('"public".', ""));
    }
    await setup.query(
      "ALTER TABLE ad_transactions ADD FOREIGN KEY(credit_transaction_id) REFERENCES credit_transactions(id) ON DELETE SET NULL",
    );
    await setup.query(
      "ALTER TABLE ad_transactions ADD FOREIGN KEY(campaign_id) REFERENCES ad_campaigns(id) ON DELETE SET NULL",
    );
    parsed.searchParams.set(
      "options",
      `-c search_path=${schema},public -c statement_timeout=20000`,
    );
    parsed.searchParams.set("application_name", applicationName);
    process.env.DATABASE_URL = parsed.toString();
    process.env.TEST_DATABASE_URL = parsed.toString();
    process.env.RAILWAY_SERVICE_NAME = applicationName;
    process.env.NODE_ENV = "test";
    process.env.MOCK_REDIS = "1";
    locker = new Client({
      connectionString: parsed.toString(),
      application_name: `${applicationName}_control`,
    });
    observer = new Client({
      connectionString: parsed.toString(),
      application_name: `${applicationName}_observer`,
    });
    writer = new Client({
      connectionString: parsed.toString(),
      application_name: `${applicationName}_writer`,
    });
    await Promise.all([locker.connect(), observer.connect(), writer.connect()]);
    ({ closeDatabaseConnectionsForTests: closeDatabases } = await import("../../../db/client"));
    ({ advertisingService: service } = await import("./index"));
    const { creditsService } = await import("../credits");
    const spy = spyOn(creditsService, "invalidateCreditCaches").mockResolvedValue(undefined);
    restoreCache = () => spy.mockRestore();
  }, 120_000);

  beforeEach(async () => {
    await setup.query(
      "DROP TRIGGER IF EXISTS gate_delete ON ad_campaigns; DROP TRIGGER IF EXISTS gate_ledger ON ad_transactions; DROP FUNCTION IF EXISTS pause_campaign_delete(); DROP FUNCTION IF EXISTS fail_first_ad_ledger(); DROP SEQUENCE IF EXISTS ledger_attempts",
    );
    await setup.query(
      "TRUNCATE ad_transactions,credit_transactions,ad_campaigns,ad_accounts,organizations CASCADE",
    );
    await setup.query(
      "INSERT INTO organizations(id,name,slug,credit_balance) VALUES($1,'Campaign owner','campaign-owner',0)",
      [organizationId],
    );
    await setup.query(
      "INSERT INTO ad_accounts(id,organization_id,connected_by_user_id,platform,external_account_id,account_name,status) VALUES($1,$2,$3,'meta','controlled','Controlled','active')",
      [accountId, organizationId, randomUUID()],
    );
    await setup.query(
      "INSERT INTO ad_campaigns(id,organization_id,ad_account_id,name,platform,objective,budget_type,budget_amount,credits_allocated,credits_spent,status) VALUES($1,$2,$3,'Controlled campaign','meta','awareness','lifetime',10,11,3,'paused')",
      [campaignId, organizationId, accountId],
    );
  });

  afterAll(async () => {
    restoreCache?.();
    await closeDatabases?.();
    await locker?.query("ROLLBACK; SELECT pg_advisory_unlock_all()");
    await Promise.all([locker?.end(), observer?.end(), writer?.end()]);
    if (setup) {
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
    const directory = testOutputPath("ad-campaign-postgres");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "waits.json"), `${JSON.stringify(waits, null, 2)}\n`);
  });

  test("concurrent deletions publish one refund and one linked advertising receipt", async () => {
    const barrier = await lockBarrier();
    await setup.query(
      `CREATE FUNCTION pause_campaign_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${barrier.key}); RETURN OLD; END $$; CREATE TRIGGER gate_delete BEFORE DELETE ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION pause_campaign_delete()`,
    );
    const first = service.deleteCampaign(campaignId, organizationId);
    void first.catch(() => undefined);
    const winner = await waitOn(barrier.pid, "first delete holds organization and campaign");
    const second = service.deleteCampaign(campaignId, organizationId);
    void second.catch(() => undefined);
    try {
      await waitOn(winner, "second delete waits for refund owner");
      expect(await result()).toEqual({ balance: "0.000000", campaigns: 1, credits: 0, ledger: 0 });
    } finally {
      await locker.query("SELECT pg_advisory_unlock($1)", [barrier.key]);
      await Promise.allSettled([first, second]);
    }
    await Promise.all([first, second]);
    expect(await result()).toEqual({ balance: "8.000000", campaigns: 0, credits: 1, ledger: 1 });
    const linked = await observer.query(
      "SELECT count(*)::int AS count FROM ad_transactions a JOIN credit_transactions c ON c.id=a.credit_transaction_id WHERE a.external_reference=$1",
      [campaignId],
    );
    expect(linked.rows[0]?.count).toBe(1);
  }, 60_000);

  test("a spend committed while deletion waits is not refunded", async () => {
    await locker.query("BEGIN");
    await locker.query("UPDATE ad_campaigns SET credits_spent=4 WHERE id=$1", [campaignId]);
    const pid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
      .pid;
    const deletion = service.deleteCampaign(campaignId, organizationId);
    void deletion.catch(() => undefined);
    try {
      await waitOn(pid, "delete waits for committed spend");
    } finally {
      await locker.query("COMMIT");
      await Promise.allSettled([deletion]);
    }
    await deletion;
    expect(await result()).toEqual({ balance: "7.000000", campaigns: 0, credits: 1, ledger: 1 });
  }, 60_000);

  test("a waiting spend cannot modify a campaign after its refund commits", async () => {
    const barrier = await lockBarrier();
    await setup.query(
      `CREATE FUNCTION pause_campaign_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${barrier.key}); RETURN OLD; END $$; CREATE TRIGGER gate_delete BEFORE DELETE ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION pause_campaign_delete()`,
    );
    const deletion = service.deleteCampaign(campaignId, organizationId);
    void deletion.catch(() => undefined);
    const winner = await waitOn(barrier.pid, "delete locks the refund snapshot");
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]!.pid;
    const spend = writer.query("UPDATE ad_campaigns SET credits_spent=4 WHERE id=$1", [campaignId]);
    void spend.catch(() => undefined);
    try {
      await waitForWriter(writerPid, winner);
    } finally {
      await locker.query("SELECT pg_advisory_unlock($1)", [barrier.key]);
      await Promise.allSettled([deletion, spend]);
    }
    await deletion;
    const finalSpend = await spend;
    expect(finalSpend.rowCount).toBe(0);
    expect(await result()).toEqual({ balance: "8.000000", campaigns: 0, credits: 1, ledger: 1 });
  }, 60_000);

  test("a failed first ledger insert rolls back before the waiting delete retries", async () => {
    const barrier = await lockBarrier();
    await setup.query(
      `CREATE SEQUENCE ledger_attempts; CREATE FUNCTION fail_first_ad_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('ledger_attempts')=1 THEN PERFORM pg_advisory_xact_lock(${barrier.key}); RAISE EXCEPTION 'controlled first ledger failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER gate_ledger BEFORE INSERT ON ad_transactions FOR EACH ROW EXECUTE FUNCTION fail_first_ad_ledger()`,
    );
    const first = service.deleteCampaign(campaignId, organizationId);
    void first.catch(() => undefined);
    const winner = await waitOn(barrier.pid, "first ledger holds uncommitted refund");
    const second = service.deleteCampaign(campaignId, organizationId);
    void second.catch(() => undefined);
    try {
      await waitOn(winner, "retry waits for failed settlement");
      expect(await result()).toEqual({ balance: "0.000000", campaigns: 1, credits: 0, ledger: 0 });
    } finally {
      await locker.query("SELECT pg_advisory_unlock($1)", [barrier.key]);
      await Promise.allSettled([first, second]);
    }
    await expect(first).rejects.toThrow();
    await second;
    expect(await result()).toEqual({ balance: "8.000000", campaigns: 0, credits: 1, ledger: 1 });
  }, 60_000);
});

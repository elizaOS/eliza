/** Primary read-only discovery over migrated PostgreSQL; no provider calls. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `command_discovery_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let repo: typeof import("./subscription-command-status");
let close: typeof import("../client").closeDatabaseConnectionsForTests;
const seed = () => seedOrganizationUpgradeTestAccount((q, v) => db.query(q, v));
type Fixture = Awaited<ReturnType<typeof seed>>;
async function insert(
  f: Fixture,
  kind: string,
  actorId = f.input.actorId,
  revision = f.input.expectedSubscriptionRevision,
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO billing_subscription_commands
    (id,organization_id,subscription_id,requested_by_user_id,kind,target_plan_key,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'2026-09-01T12:00:00.123456Z')`,
    [
      id,
      f.input.organizationId,
      f.input.subscriptionId,
      actorId,
      kind,
      kind === "downgrade" ? "plus_monthly" : kind === "upgrade" ? "pro_monthly" : null,
      revision,
      randomUUID(),
      randomUUID(),
      "a".repeat(64),
    ],
  );
  return id;
}
(url ? describe : describe.skip)("pending command discovery primary authority", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((q) => db.query(q));
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    repo = await import("./subscription-command-status");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("microsecond keyset pages preserve both plan kinds, isolate actor/family/tenant and perform no writes", async () => {
    const f = await seed(),
      other = await seed();
    const ids = [
      await insert(f, "upgrade"),
      await insert(f, "downgrade"),
      await insert(f, "upgrade"),
    ]
      .sort()
      .reverse();
    const cancelId = await insert(f, "cancel");
    const otherActorId = await insert(f, "downgrade", other.input.actorId);
    await insert(other, "upgrade");
    const before = (
      await db.query("SELECT to_jsonb(c) AS value FROM billing_subscription_commands c ORDER BY id")
    ).rows;
    const input = { ...f.input, limit: 1 };
    const first = await repo.readPendingOrganizationPlanChangeCommands(input);
    expect(first.items[0]?.commandId).toBe(ids[0]);
    expect(first.items[0]?.createdAt).toBe("2026-09-01T12:00:00.123456Z");
    expect(first.items[0]?.source.state).toBe("current");
    expect(first.items[0]?.lease).toBe("not_started");
    const second = await repo.readPendingOrganizationPlanChangeCommands({
      ...input,
      cursor: first.nextCursor!,
    });
    const third = await repo.readPendingOrganizationPlanChangeCommands({
      ...input,
      cursor: second.nextCursor!,
    });
    expect([first, second, third].flatMap((p) => p.items.map((c) => c.commandId))).toEqual(ids);
    expect(third.nextCursor).toBeNull();
    expect([first, second, third].flatMap((p) => p.items.map((c) => c.kind))).toContain(
      "downgrade",
    );
    expect(first.items[0]).not.toHaveProperty("request_digest");
    const old = await repo.readPendingSubscriptionCommands({ ...input, limit: 10 });
    expect(old.items.map((c) => c.commandId)).toEqual([cancelId]);
    expect(old.items[0]).not.toHaveProperty("targetPlanKey");
    await expect(
      repo.readPendingOrganizationPlanChangeCommands({
        ...input,
        organizationId: other.input.organizationId,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_COMMAND_CURSOR_INVALID" });
    await db.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
      f.input.organizationId,
      other.input.actorId,
    ]);
    await expect(
      repo.readPendingOrganizationPlanChangeCommands({
        ...input,
        actorId: other.input.actorId,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_COMMAND_CURSOR_INVALID" });
    expect(
      (
        await repo.readPendingOrganizationPlanChangeCommands({
          ...input,
          actorId: other.input.actorId,
        })
      ).items.map((c) => c.commandId),
    ).toEqual([otherActorId]);
    await expect(
      repo.readPendingSubscriptionCommands({ ...input, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_COMMAND_CURSOR_INVALID" });
    expect(
      (
        await db.query(
          "SELECT to_jsonb(c) AS value FROM billing_subscription_commands c ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
  });
  test("legacy cancellation cursors still work and cannot enter plan-change discovery", async () => {
    const f = await seed();
    await insert(f, "cancel");
    await insert(f, "resume");
    const first = await repo.readPendingSubscriptionCommands({ ...f.input, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const next = await repo.readPendingSubscriptionCommands({
      ...f.input,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.commandId).not.toBe(first.items[0]?.commandId);
    expect(next.nextCursor).toBeNull();
    await expect(
      repo.readPendingOrganizationPlanChangeCommands({
        ...f.input,
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_COMMAND_CURSOR_INVALID" });
  });
  test("source changes remain visible; missing current authority does not invent a matching source", async () => {
    const f = await seed();
    await insert(f, "downgrade", f.input.actorId, f.input.expectedSubscriptionRevision + 1);
    expect(
      (await repo.readPendingOrganizationPlanChangeCommands({ ...f.input, limit: 5 })).items[0]
        ?.source.state,
    ).toBe("changed");
    await db.query("DELETE FROM organization_subscription_authorities WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
    expect(
      (await repo.readPendingOrganizationPlanChangeCommands({ ...f.input, limit: 5 })).items[0]
        ?.source.state,
    ).toBe("unavailable");
  });
  test("manager revocation and foreign tenant fail even with known pending command IDs", async () => {
    const f = await seed(),
      other = await seed();
    await insert(f, "upgrade");
    await expect(
      repo.readPendingOrganizationPlanChangeCommands({
        ...f.input,
        organizationId: other.input.organizationId,
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" });
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
    await expect(
      repo.readPendingOrganizationPlanChangeCommands({ ...f.input, limit: 5 }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" });
  });
  test("actual claimed upgrade is rediscovered without changing its active lease or generation", async () => {
    const f = await seed();
    const { saveOrganizationUpgradeQuote } = await import("./organization-upgrade-quotes");
    const { prepareOrganizationUpgrade } = await import("./organization-upgrade-commands");
    const { claimOrganizationUpgrade } = await import("./organization-upgrade-execution");
    const quote = await saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: f.review,
    });
    const prepared = await prepareOrganizationUpgrade({
      ...f.input,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    });
    await claimOrganizationUpgrade({ ...f.input, commandId: prepared.command.id });
    const before = (
      await db.query(
        "SELECT to_jsonb(c) AS value FROM billing_subscription_commands c WHERE id=$1",
        [prepared.command.id],
      )
    ).rows;
    const page = await repo.readPendingOrganizationPlanChangeCommands({ ...f.input, limit: 5 });
    expect(page.items[0]).toMatchObject({
      commandId: prepared.command.id,
      status: "OUTCOME_UNKNOWN",
      lease: "active",
      kind: "upgrade",
      targetPlanKey: "pro_monthly",
    });
    expect(
      (
        await db.query(
          "SELECT to_jsonb(c) AS value FROM billing_subscription_commands c WHERE id=$1",
          [prepared.command.id],
        )
      ).rows,
    ).toEqual(before);
  });
  test("malformed cursors and limits are explicit errors rather than silently restarted pages", async () => {
    const f = await seed();
    for (const cursor of ["bad!", "e30", "a".repeat(1025)])
      await expect(
        repo.readPendingOrganizationPlanChangeCommands({ ...f.input, limit: 1, cursor }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_COMMAND_CURSOR_INVALID" });
    for (const limit of [0, 101, 1.5])
      await expect(
        repo.readPendingOrganizationPlanChangeCommands({ ...f.input, limit }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_COMMAND_PAGE_INVALID" });
  });
  test("commands completed between pages disappear without restarting or skipping older pending commands", async () => {
    const f = await seed();
    const ids = [
      await insert(f, "upgrade"),
      await insert(f, "downgrade"),
      await insert(f, "upgrade"),
    ]
      .sort()
      .reverse();
    const first = await repo.readPendingOrganizationPlanChangeCommands({ ...f.input, limit: 1 });
    expect(first.items[0]?.commandId).toBe(ids[0]);
    await db.query(
      "UPDATE billing_subscription_commands SET status='SUPERSEDED',error_code='REVIEW_EXPIRED',completed_at=clock_timestamp() WHERE id=$1",
      [ids[1]],
    );
    const next = await repo.readPendingOrganizationPlanChangeCommands({
      ...f.input,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(next.items.map((c) => c.commandId)).toEqual([ids[2]]);
    expect(next.nextCursor).toBeNull();
  });
});

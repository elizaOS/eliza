/** Real PostgreSQL cleanup authority; provider traffic is synthetic. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";
import { seedOrganizationDowngradeTestAccount } from "./organization-downgrade-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";

let stripeMock: unknown;
mock.module(resolve(import.meta.dir, "../../lib/stripe.ts"), () => ({
  requireStripe: () => stripeMock,
}));
const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `schedule_compensation_finalizer_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
let repo: typeof import("./organization-schedule-effects");
async function seed(validityMs = 60000) {
  const f = await seedOrganizationDowngradeTestAccount((q, v) => db.query(q, v), validityMs);
  const { prepareOrganizationDowngrade } = await import("./organization-downgrade-commands");
  const prepared = await prepareOrganizationDowngrade({
    ...f.input,
    quoteId: f.quote.id,
    idempotencyKey: randomUUID(),
  });
  const identity = {
    organizationId: f.input.organizationId,
    actorId: f.input.actorId,
    commandId: prepared.command.id,
  };
  return { ...f, identity };
}
async function claimed(validityMs = 60000) {
  const f = await seed(validityMs),
    result = await repo.claimOrganizationSchedule(f.identity);
  if (!result) throw new Error("Fixture claim unavailable");
  return { ...f, ...result };
}

(url ? describe : describe.skip)("original compensation finalization", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((q) => db.query(q));
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    repo = await import("./organization-schedule-effects");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  async function providerCreated() {
    const f = await claimed();
    const { originalScheduleTestInput } = await import(
      "../../lib/services/organization-schedule-provider-test-fixture"
    );
    const { completeScheduleSubscriptionTestObservation, scheduleCustomerTestObservation } =
      await import("../../lib/services/organization-schedule-test-fixture");
    const start = await repo.markOrganizationScheduleEffectDispatch(
      f.identity,
      f.claim,
      f.effect.id,
    );
    const rawCreate = structuredClone(originalScheduleTestInput().rawCurrentSchedule);
    rawCreate.id = "sub_sched_owned";
    rawCreate.customer = f.source.stripe_customer_id;
    rawCreate.subscription = f.source.stripe_subscription_id;
    rawCreate.created = Math.floor(start.started_at!.getTime() / 1000);
    rawCreate.current_phase = {
      start_date: f.source.current_period_start.getTime() / 1000,
      end_date: f.source.current_period_end.getTime() / 1000,
    };
    rawCreate.phases[0]!.start_date = rawCreate.current_phase.start_date;
    rawCreate.phases[0]!.end_date = rawCreate.current_phase.end_date;
    function transport(raw: object, requestId: string, key: string) {
      return Object.defineProperty(raw, "lastResponse", {
        value: { requestId, idempotencyKey: key, apiVersion: "2024-11-20.acacia", statusCode: 200 },
      });
    }
    const createEvidence = {
      kind: "response" as const,
      raw: transport(rawCreate, "req_create", start.provider_idempotency_key),
    };
    await repo.recordAuthenticatedOrganizationScheduleEvidence(
      f.identity,
      f.claim,
      start.id,
      createEvidence,
    );
    return {
      ...f,
      rawCreate,
      createEvidence,
      transport,
      createKey: start.provider_idempotency_key,
      rawSubscription: completeScheduleSubscriptionTestObservation(f.provider),
      rawCustomer: scheduleCustomerTestObservation(f.source.stripe_customer_id),
    };
  }
  async function providerReleased() {
    const f = await providerCreated();
    const { rawCreate, createEvidence, transport } = f;
    const release = await repo.prepareOrganizationScheduleCompensation(f.identity, f.claim);
    const started = await repo.markOrganizationScheduleCompensationDispatch(
      f.identity,
      f.claim,
      release.id,
    );
    const released = {
      ...structuredClone(rawCreate),
      status: "released",
      subscription: null,
      released_subscription: f.source.stripe_subscription_id,
      released_at: Math.floor(started.started_at!.getTime() / 1000),
      current_phase: null,
    };
    const rawCurrentSchedule = structuredClone(released);
    const releaseEvidence = {
      kind: "response" as const,
      raw: transport(released, "req_release", started.provider_idempotency_key),
    };
    await repo.recordAuthenticatedOrganizationScheduleEvidence(
      f.identity,
      f.claim,
      started.id,
      releaseEvidence,
    );
    return {
      ...f,
      createKey: f.createKey,
      releaseKey: started.provider_idempotency_key,
      observation: {
        createEvidence,
        releaseEvidence,
        rawCurrentSchedule,
        rawSubscription: f.rawSubscription,
        rawCustomer: f.rawCustomer,
      },
    };
  }
  test("finalizer verifies real projected receipts under original locks, preserves paid authority, and replays", async () => {
    const f = await providerReleased();
    const before = (
      await db.query("SELECT to_jsonb(s) AS source FROM billing_subscriptions s WHERE id=$1", [
        f.input.subscriptionId,
      ])
    ).rows;
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    const result = await repo.finalizeOrganizationScheduleCompensation(
      f.identity,
      f.claim,
      f.observation,
    );
    expect(result.replayed).toBe(false);
    expect(result.command.status).toBe("FAILED");
    expect(result.command.organization_schedule_failure_evidence?.kind).toBe(
      "original_unconfigured_schedule_released",
    );
    expect(
      (
        await db.query("SELECT to_jsonb(s) AS source FROM billing_subscriptions s WHERE id=$1", [
          f.input.subscriptionId,
        ])
      ).rows,
    ).toEqual(before);
    const replay = await repo.finalizeOrganizationScheduleCompensation(f.identity, f.claim, {
      ...f.observation,
      rawCurrentSchedule: null,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.command).toEqual(result.command);
  });
  test("fresh financial drift cannot publish cleanup despite owned release receipts", async () => {
    const f = await providerReleased();
    f.observation.rawCustomer.balance = 123;
    await expect(
      repo.finalizeOrganizationScheduleCompensation(f.identity, f.claim, f.observation),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE" });
    expect(
      (
        await db.query(
          "SELECT status,organization_schedule_failure_evidence AS evidence FROM billing_subscription_commands WHERE id=$1",
          [f.identity.commandId],
        )
      ).rows[0],
    ).toEqual({ status: "OUTCOME_UNKNOWN", evidence: null });
  });
  test("foreign response transport attribution cannot publish a valid-looking released snapshot", async () => {
    const f = await providerReleased();
    f.observation.releaseEvidence.raw = structuredClone(f.observation.releaseEvidence.raw);
    Object.defineProperty(f.observation.releaseEvidence.raw, "lastResponse", {
      value: {
        requestId: "req_foreign",
        idempotencyKey: "foreign-key",
        apiVersion: "2024-11-20.acacia",
        statusCode: 200,
      },
    });
    await expect(
      repo.finalizeOrganizationScheduleCompensation(f.identity, f.claim, f.observation),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_SCHEDULE_ORIGIN_UNVERIFIED" });
  });
  test("expired finalization lease leaves original uncertainty recoverable", async () => {
    const f = await providerReleased();
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.identity.commandId],
    );
    await expect(
      repo.finalizeOrganizationScheduleCompensation(f.identity, f.claim, f.observation),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
  });

  test("unattended recovery publishes original cleanup and resolves its incident after manager loss without another provider write", async () => {
    const f = await providerReleased();
    let writes = 0;
    const event = (type: string, raw: unknown, requestId: string, key: string) => ({
      id: type.endsWith("created") ? "evt_create" : "evt_release",
      object: "event",
      type,
      api_version: "2024-11-20.acacia",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      request: { id: requestId, idempotency_key: key },
      data: { object: structuredClone(raw) },
    });
    stripeMock = {
      events: {
        list: async ({ type }: { type: string }) => ({
          object: "list",
          has_more: false,
          data: [
            type.endsWith("created")
              ? event(type, f.observation.createEvidence.raw, "req_create", f.createKey)
              : event(type, f.observation.releaseEvidence.raw, "req_release", f.releaseKey),
          ],
        }),
      },
      subscriptions: { retrieve: async () => f.observation.rawSubscription },
      customers: { retrieve: async () => f.observation.rawCustomer },
      subscriptionSchedules: {
        retrieve: async () => f.observation.rawCurrentSchedule,
        release: async () => {
          writes++;
          throw Error("unexpected POST");
        },
      },
    };
    await repo.finishOrganizationScheduleAttempt(f.identity, f.claim);
    const { recordOrganizationScheduleRecoveryOutcome } = await import(
      "./organization-schedule-maintenance"
    );
    await recordOrganizationScheduleRecoveryOutcome({
      ...f.identity,
      issueCode: "SCHEDULE_RECOVERY_UNAVAILABLE",
    });
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    const { reconcileOriginalOrganizationSchedule } = await import(
      "../../lib/services/organization-schedule-maintenance"
    );
    expect(await reconcileOriginalOrganizationSchedule(f.identity)).toBe("FAILED");
    expect(
      (
        await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
          f.identity.commandId,
        ])
      ).rows,
    ).toEqual([{ status: "resolved" }]);
    expect(writes).toBe(0);
  });
  test("service event-history failure preserves uncertainty without a provider write", async () => {
    const f = await providerReleased();
    let writes = 0;
    stripeMock = {
      events: {
        list: async () => {
          throw Error("history unavailable");
        },
      },
      subscriptionSchedules: {
        release: async () => {
          writes++;
        },
      },
    };
    const { recoverOrganizationScheduleCompensation } = await import(
      "../../lib/services/organization-schedule-compensation"
    );
    await expect(recoverOrganizationScheduleCompensation(f.identity, f.claim)).rejects.toThrow(
      "history unavailable",
    );
    expect(writes).toBe(0);
    expect(
      (
        await db.query(
          "SELECT status,organization_schedule_failure_evidence AS evidence FROM billing_subscription_commands WHERE id=$1",
          [f.identity.commandId],
        )
      ).rows[0],
    ).toEqual({ status: "OUTCOME_UNKNOWN", evidence: null });
  });

  test("direct partial-create cleanup records release and terminal failure without lowering the paid plan", async () => {
    const f = await providerCreated();
    let current: unknown = structuredClone(f.rawCreate),
      released = false,
      writes = 0;
    const before = (
      await db.query("SELECT to_jsonb(s) AS source FROM billing_subscriptions s WHERE id=$1", [
        f.input.subscriptionId,
      ])
    ).rows;
    stripeMock = {
      subscriptions: {
        retrieve: async () => ({
          ...f.rawSubscription,
          schedule: released ? null : f.rawCreate.id,
        }),
      },
      customers: { retrieve: async () => f.rawCustomer },
      subscriptionSchedules: {
        retrieve: async () => current,
        release: async (
          id: string,
          params: unknown,
          options: { idempotencyKey: string; maxNetworkRetries: number },
        ) => {
          writes++;
          expect(id).toBe(f.rawCreate.id);
          expect(params).toEqual({ preserve_cancel_date: true });
          expect(options.maxNetworkRetries).toBe(0);
          released = true;
          const raw = {
            ...structuredClone(f.rawCreate),
            status: "released",
            subscription: null,
            released_subscription: f.source.stripe_subscription_id,
            released_at: Math.floor(Date.now() / 1000),
            current_phase: null,
          };
          current = structuredClone(raw);
          return f.transport(raw, "req_release", options.idempotencyKey);
        },
      },
    };
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    const { compensateOrganizationScheduleCreate } = await import(
      "../../lib/services/organization-schedule-compensation"
    );
    const result = await compensateOrganizationScheduleCreate(
      f.identity,
      f.claim,
      f.createEvidence,
    );
    expect(result.effect.state).toBe("observed");
    expect(result.resolution.command.status).toBe("FAILED");
    expect(writes).toBe(1);
    expect(
      (
        await db.query("SELECT to_jsonb(s) AS source FROM billing_subscriptions s WHERE id=$1", [
          f.input.subscriptionId,
        ])
      ).rows,
    ).toEqual(before);
  });
  test("terminal publication rollback preserves original release receipts and permits later proof retry", async () => {
    const f = await providerReleased();
    await db.query(
      `CREATE FUNCTION refuse_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.identity.commandId}'::uuid AND NEW.status='FAILED' THEN RAISE EXCEPTION 'fixture finalization refused' USING ERRCODE='P0001'; END IF; RETURN NEW; END; $$`,
    );
    await db.query(
      "CREATE TRIGGER z_refuse_result BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION refuse_result()",
    );
    try {
      await expect(
        repo.finalizeOrganizationScheduleCompensation(f.identity, f.claim, f.observation),
      ).rejects.toMatchObject({ cause: { code: "P0001" } });
      expect(
        (
          await db.query(
            "SELECT status,organization_schedule_failure_evidence AS evidence,lease_token FROM billing_subscription_commands WHERE id=$1",
            [f.identity.commandId],
          )
        ).rows[0],
      ).toEqual({ status: "OUTCOME_UNKNOWN", evidence: null, lease_token: f.claim.leaseToken });
      expect(
        (
          await db.query(
            "SELECT state FROM organization_schedule_effects WHERE command_id=$1 AND kind='schedule_release'",
            [f.identity.commandId],
          )
        ).rows[0].state,
      ).toBe("observed");
    } finally {
      await db.query("DROP TRIGGER z_refuse_result ON billing_subscription_commands");
      await db.query("DROP FUNCTION refuse_result()");
    }
    expect(
      (await repo.finalizeOrganizationScheduleCompensation(f.identity, f.claim, f.observation))
        .command.status,
    ).toBe("FAILED");
  });

  for (const lockTarget of ["organization", "association"] as const)
    test(`lease expiry while finalization waits for ${lockTarget} cannot commit stale cleanup`, async () => {
      const f = await providerReleased();
      const blocker = new Client({ connectionString: url });
      await blocker.connect();
      await blocker.query(`SET search_path TO ${schema},public`);
      await blocker.query("BEGIN");
      const blockerId = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query(
        lockTarget === "organization"
          ? "SELECT id FROM organizations WHERE id=$1 FOR UPDATE"
          : "SELECT organization_id FROM organization_subscription_authorities WHERE organization_id=$1 FOR UPDATE",
        [f.identity.organizationId],
      );
      const pending = repo
        .finalizeOrganizationScheduleCompensation(f.identity, f.claim, f.observation)
        .then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );
      try {
        let blocked = false;
        for (let i = 0; i < 400; i++) {
          blocked = (
            await db.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",
              [blockerId],
            )
          ).rows[0].blocked;
          if (blocked) break;
          await Bun.sleep(25);
        }
        expect(blocked).toBe(true);
        await db.query("SET lock_timeout='1s'");
        await db.query(
          "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [f.identity.commandId],
        );
      } finally {
        await blocker.query("COMMIT");
        await blocker.end();
        await db.query("SET lock_timeout='0'");
      }
      const result = await pending;
      expect(result.error).toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
      expect(
        (
          await db.query(
            "SELECT status,organization_schedule_failure_evidence AS evidence FROM billing_subscription_commands WHERE id=$1",
            [f.identity.commandId],
          )
        ).rows[0],
      ).toEqual({ status: "OUTCOME_UNKNOWN", evidence: null });
    }, 30000);
  test("foreign original actor or tenant cannot finalize owned release evidence", async () => {
    const f = await providerReleased();
    for (const identity of [
      { ...f.identity, actorId: randomUUID() },
      { ...f.identity, organizationId: randomUUID() },
    ])
      await expect(
        repo.finalizeOrganizationScheduleCompensation(identity, f.claim, f.observation),
      ).rejects.toMatchObject({
        code:
          identity.organizationId === f.identity.organizationId
            ? "SUBSCRIPTION_PLAN_CHANGE_CONFLICT"
            : "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN",
      });
    expect(
      (
        await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
          f.identity.commandId,
        ])
      ).rows[0].status,
    ).toBe("OUTCOME_UNKNOWN");
  });

  test("organization fencing does not strand a proven original release or change paid authority", async () => {
    const f = await providerReleased();
    const before = (
      await db.query("SELECT to_jsonb(s) AS source FROM billing_subscriptions s WHERE id=$1", [
        f.input.subscriptionId,
      ])
    ).rows;
    await db.query(
      "UPDATE organizations SET is_active=false,paid_work_fenced_at=clock_timestamp() WHERE id=$1",
      [f.identity.organizationId],
    );
    const result = await repo.finalizeOrganizationScheduleCompensation(
      f.identity,
      f.claim,
      f.observation,
    );
    expect(result.command.status).toBe("FAILED");
    expect(
      (
        await db.query("SELECT to_jsonb(s) AS source FROM billing_subscriptions s WHERE id=$1", [
          f.input.subscriptionId,
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT is_active,paid_work_fenced_at IS NOT NULL AS fenced FROM organizations WHERE id=$1",
          [f.identity.organizationId],
        )
      ).rows[0],
    ).toEqual({ is_active: false, fenced: true });
  });
});

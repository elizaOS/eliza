/** Actual PostgreSQL receipt concurrency and original-command authority. No provider writes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `upgrade_origin_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let record: typeof import("./organization-upgrade-invoice-origins").recordOrganizationUpgradeInvoiceOrigin;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function seed(dispatch = true) {
  const f = await seedOrganizationUpgradeTestAccount((q, v) => db.query(q, v));
  const { saveOrganizationUpgradeQuote } = await import("./organization-upgrade-quotes");
  const { prepareOrganizationUpgrade } = await import("./organization-upgrade-commands");
  const { claimOrganizationUpgrade, markOrganizationUpgradeDispatch } = await import(
    "./organization-upgrade-execution"
  );
  const quote = await saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    review: f.review,
    providerBinding: f.providerBinding,
  });
  const { command } = await prepareOrganizationUpgrade({ ...f.input, quoteId: quote.id });
  const identity = {
    organizationId: f.input.organizationId,
    actorId: f.input.actorId,
    commandId: command.id,
  };
  if (dispatch) {
    const claim = await claimOrganizationUpgrade(identity);
    if (!claim) throw new Error("Fixture claim missing");
    await markOrganizationUpgradeDispatch(identity, claim);
  }
  const suffix = command.id.replaceAll("-", "");
  const event = {
    id: `evt_${suffix}`,
    object: "event",
    type: "invoice.created",
    api_version: "2024-11-20.acacia",
    created: f.review.prorationDate,
    livemode: false,
    request: { id: `req_${suffix}`, idempotency_key: command.provider_idempotency_key },
    data: {
      object: {
        id: `in_${suffix}`,
        object: "invoice",
        customer: f.source.stripe_customer_id,
        subscription: f.source.stripe_subscription_id,
        livemode: false,
        billing_reason: "subscription_update",
        currency: "usd",
        created: f.review.prorationDate,
      },
    },
  };
  return {
    ...f,
    command,
    quote,
    event,
    recordInput: {
      organizationId: f.input.organizationId,
      commandId: command.id,
      evidence: { kind: "invoice_created_event" as const, raw: event },
    },
  };
}
async function count(commandId: string) {
  return (
    await db.query(
      "SELECT count(*)::int n FROM organization_upgrade_invoice_origins WHERE command_id=$1",
      [commandId],
    )
  ).rows[0].n;
}
async function rawInsert(
  f: Awaited<ReturnType<typeof seed>>,
  key = f.command.provider_idempotency_key,
  invoiceCreated = f.review.prorationDate,
) {
  return db.query(
    `INSERT INTO organization_upgrade_invoice_origins(command_id,organization_id,invoice_id,evidence_kind,provider_event_id,provider_request_id,provider_idempotency_key,customer_id,subscription_id,livemode,api_version,invoice_created_at,event_created_at,observed_at,evidence_digest,created_at)
 VALUES($1,$2,$3,'invoice_created_event',$4,$5,$6,$7,$8,false,'2024-11-20.acacia',to_timestamp($9),to_timestamp($10),clock_timestamp(),$11,clock_timestamp())`,
    [
      f.command.id,
      f.input.organizationId,
      f.event.data.object.id,
      f.event.id,
      f.event.request.id,
      key,
      f.source.stripe_customer_id,
      f.source.stripe_subscription_id,
      invoiceCreated,
      f.review.prorationDate,
      "a".repeat(64),
    ],
  );
}
(url ? describe : describe.skip)(
  "organization upgrade invoice attribution PostgreSQL authority",
  () => {
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
      process.env.LOCAL_PG_POOL_MAX = "4";
      ({ recordOrganizationUpgradeInvoiceOrigin: record } = await import(
        "./organization-upgrade-invoice-origins"
      ));
      ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
    }, 120000);
    afterAll(async () => {
      if (!db) return;
      await close?.();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    });
    test("concurrent duplicate events store one origin without publishing payment or allowance", async () => {
      const f = await seed();
      const results = await Promise.all([record(f.recordInput), record(f.recordInput)]);
      expect(results.filter((x) => x.created)).toHaveLength(1);
      expect(await count(f.command.id)).toBe(1);
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
            f.command.id,
          ])
        ).rows[0].status,
      ).toBe("OUTCOME_UNKNOWN");
      expect(
        (
          await db.query(
            "SELECT lifecycle_revision::int revision FROM billing_subscriptions WHERE id=$1",
            [f.input.subscriptionId],
          )
        ).rows[0].revision,
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM subscription_allowance_transactions WHERE organization_id=$1",
            [f.input.organizationId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    test("another invoice cannot replace the original receipt", async () => {
      const f = await seed();
      const first = await record(f.recordInput);
      f.event.data.object.id = "in_different";
      await expect(record(f.recordInput)).rejects.toThrow();
      expect(await count(f.command.id)).toBe(1);
      expect(
        (
          await db.query(
            "SELECT invoice_id FROM organization_upgrade_invoice_origins WHERE command_id=$1",
            [f.command.id],
          )
        ).rows[0].invoice_id,
      ).toBe(first.receipt.invoice_id);
    });
    test("tenant identity and original request cannot be transplanted", async () => {
      const f = await seed(),
        other = await seed();
      await expect(
        record({ ...f.recordInput, organizationId: other.input.organizationId }),
      ).rejects.toThrow();
      await expect(
        record({ ...other.recordInput, evidence: { kind: "invoice_created_event", raw: f.event } }),
      ).rejects.toThrow();
      f.event.request.idempotency_key = "foreign-key";
      await expect(record(f.recordInput)).rejects.toThrow();
      expect(await count(f.command.id)).toBe(0);
      expect(await count(other.command.id)).toBe(0);
    });
    test("ready command cannot receive a provider origin through service or raw database write", async () => {
      const f = await seed(false);
      await expect(record(f.recordInput)).rejects.toThrow();
      await expect(rawInsert(f)).rejects.toThrow();
      expect(await count(f.command.id)).toBe(0);
    });
    test("database fences request identity and invoice chronology independently of service validation", async () => {
      const f = await seed();
      await expect(rawInsert(f, "foreign-key")).rejects.toThrow();
      await expect(
        rawInsert(f, f.command.provider_idempotency_key, f.review.prorationDate - 1),
      ).rejects.toThrow();
      expect(await count(f.command.id)).toBe(0);
    });
    test("late authenticated evidence survives lease expiry and actor removal without granting authority", async () => {
      const f = await seed();
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [f.command.id],
      );
      await db.query("UPDATE users SET role='member',is_active=false WHERE id=$1", [
        f.input.actorId,
      ]);
      const result = await record(f.recordInput);
      expect(result.created).toBe(true);
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
            f.command.id,
          ])
        ).rows[0].status,
      ).toBe("OUTCOME_UNKNOWN");
    });
    test("origin is immutable and cannot be deleted or truncated", async () => {
      const f = await seed();
      await record(f.recordInput);
      await expect(
        db.query(
          "UPDATE organization_upgrade_invoice_origins SET invoice_id='in_other' WHERE command_id=$1",
          [f.command.id],
        ),
      ).rejects.toThrow();
      await expect(
        db.query("DELETE FROM organization_upgrade_invoice_origins WHERE command_id=$1", [
          f.command.id,
        ]),
      ).rejects.toThrow();
      await expect(db.query("TRUNCATE organization_upgrade_invoice_origins")).rejects.toThrow();
      expect(await count(f.command.id)).toBe(1);
    });
    test("one platform invoice cannot belong to two commands even with different event identifiers", async () => {
      const f = await seed(),
        other = await seed();
      await record(f.recordInput);
      other.event.data.object.id = f.event.data.object.id;
      await expect(record(other.recordInput)).rejects.toMatchObject({
        code: "SUBSCRIPTION_UPGRADE_INVOICE_ORIGIN_CONFLICT",
      });
      expect(await count(other.command.id)).toBe(0);
    });
    test("storage failure rolls back attribution and a later observation can retry without a payment write", async () => {
      const f = await seed();
      await db.query(
        `CREATE FUNCTION reject_origin_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture storage failure'; END $$; CREATE TRIGGER reject_origin_fixture BEFORE INSERT ON organization_upgrade_invoice_origins FOR EACH ROW EXECUTE FUNCTION reject_origin_fixture();`,
      );
      try {
        await expect(record(f.recordInput)).rejects.toThrow();
        expect(await count(f.command.id)).toBe(0);
      } finally {
        await db.query(
          "DROP TRIGGER reject_origin_fixture ON organization_upgrade_invoice_origins; DROP FUNCTION reject_origin_fixture()",
        );
      }
      expect((await record(f.recordInput)).created).toBe(true);
    });
    for (const responseFirst of [true, false])
      test(`original response and event converge regardless of delivery order (${responseFirst})`, async () => {
        const f = await seed();
        const responseInput = {
          ...f.recordInput,
          evidence: {
            kind: "update_response" as const,
            raw: {
              id: f.source.stripe_subscription_id,
              object: "subscription",
              customer: f.source.stripe_customer_id,
              livemode: false,
              latest_invoice: f.event.data.object,
              lastResponse: {
                requestId: f.event.request.id,
                statusCode: 200,
                apiVersion: "2024-11-20.acacia",
                idempotencyKey: f.command.provider_idempotency_key,
              },
            },
          },
        };
        const results = responseFirst
          ? [await record(responseInput), await record(f.recordInput)]
          : [await record(f.recordInput), await record(responseInput)];
        expect(results.map((x) => x.created)).toEqual([true, false]);
        expect(await count(f.command.id)).toBe(1);
        expect(results[1]!.receipt.evidence_kind).toBe(
          responseFirst ? "update_response" : "invoice_created_event",
        );
        responseInput.evidence.raw.lastResponse.requestId = "req_other";
        await expect(record(responseInput)).rejects.toThrow();
      });
    test("database rejects incomplete event provenance and arbitrary evidence kind", async () => {
      const f = await seed();
      await rawInsert(f);
      const row = (
        await db.query("SELECT * FROM organization_upgrade_invoice_origins WHERE command_id=$1", [
          f.command.id,
        ])
      ).rows[0];
      const other = await seed();
      for (const kind of ["invoice_created_event", "invented_kind"]) {
        await expect(
          db.query(
            `INSERT INTO organization_upgrade_invoice_origins(command_id,organization_id,invoice_id,evidence_kind,provider_request_id,provider_idempotency_key,customer_id,subscription_id,livemode,api_version,invoice_created_at,observed_at,evidence_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,'2024-11-20.acacia',$9,clock_timestamp(),$10,clock_timestamp())`,
            [
              other.command.id,
              other.input.organizationId,
              other.event.data.object.id,
              kind,
              other.event.request.id,
              other.command.provider_idempotency_key,
              other.source.stripe_customer_id,
              other.source.stripe_subscription_id,
              row.invoice_created_at,
              row.evidence_digest,
            ],
          ),
        ).rejects.toThrow();
      }
      expect(await count(other.command.id)).toBe(0);
    });
  },
);

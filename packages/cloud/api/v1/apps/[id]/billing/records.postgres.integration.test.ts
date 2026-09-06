/** Exercises buyer SDK and signed-session Hono records against real PostgreSQL locks, migrations and controlled Stripe HTTP. */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buyer,
  closeRecordsTest,
  db,
  invoiceFixture,
  member,
  org,
  postgresUrl,
  sdk,
  setupRecordsTest,
  trial,
} from "./records-test-harness";

setDefaultTimeout(60_000);
describe.skipIf(!postgresUrl)(
  "app buyer records PostgreSQL and SDK transport",
  () => {
    beforeAll(setupRecordsTest);
    afterAll(closeRecordsTest);

    test("free session assigns current members and persists retry receipts across revocation and reassignment", async () => {
      const { client, identity, scopeId } = await trial();
      const subject = await member(identity);
      await db.query("UPDATE users SET email_verified=false WHERE id=$1", [
        subject,
      ]);
      const request = { subject, idempotencyKey: randomUUID() };
      const first = await client.assignSeat(
        identity.billingAccountId,
        "main",
        request,
      );
      expect(
        (await client.assignSeat(identity.billingAccountId, "main", request))
          .data,
      ).toEqual(first.data);
      const key = randomUUID();
      expect(
        (
          await client.revokeSeat(
            identity.billingAccountId,
            "main",
            first.data.id,
            key,
          )
        ).data.revoked,
      ).toBe(true);
      const reassigned = await client.assignSeat(
        identity.billingAccountId,
        "main",
        { subject, idempotencyKey: randomUUID() },
      );
      expect(reassigned.data.id).not.toBe(first.data.id);
      expect(
        (
          await client.revokeSeat(
            identity.billingAccountId,
            "main",
            first.data.id,
            key,
          )
        ).data.revoked,
      ).toBe(true);
      expect(
        (await client.assignSeat(identity.billingAccountId, "main", request))
          .data.id,
      ).toBe(first.data.id);
      expect(
        (await client.listSeats(identity.billingAccountId, "main")).data.items,
      ).toEqual([reassigned.data]);
      await expect(
        client.assignSeat(identity.billingAccountId, "main", {
          ...request,
          subject: identity.actorUserId,
        }),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS total FROM app_billing_seats WHERE billing_scope_id=$1 AND revoked_at IS NULL",
            [scopeId],
          )
        ).rows[0].total,
      ).toBe(1);
    });

    test("a hosted session uses the selected registration mode for catalog, snapshots and mutations without gaining authority", async () => {
      const { identity, planId } = await trial();
      const clientId = randomUUID();
      await db.query(
        `INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes)
         VALUES($1,$2,$3,'test','[]','["https://consumer.example.test/callback"]','["billing:read","billing:write"]')`,
        [clientId, identity.appId, org],
      );
      const hosted = await sdk(identity, true, { clientId });
      const catalog = await hosted.getCatalog();
      expect(catalog.data.plans.some((plan) => plan.id === planId)).toBe(true);
      expect(
        (await hosted.getSubscription(identity.billingAccountId, "main")).data
          .subscription?.status,
      ).toBe("trialing");
      const subject = await member(identity);
      const assigned = await hosted.assignSeat(
        identity.billingAccountId,
        "main",
        {
          subject,
          idempotencyKey: randomUUID(),
        },
      );
      expect(
        (await hosted.listSeats(identity.billingAccountId, "main")).data.items,
      ).toEqual([assigned.data]);
      const reader = await sdk({ ...identity, actorUserId: subject }, true, {
        clientId,
      });
      await expect(
        reader.revokeSeat(
          identity.billingAccountId,
          "main",
          assigned.data.id,
          randomUUID(),
        ),
      ).rejects.toThrow();
      const unguarded = await sdk(identity, true, {
        clientId,
        omitCsrfMarker: true,
      });
      await expect(
        unguarded.revokeSeat(
          identity.billingAccountId,
          "main",
          assigned.data.id,
          randomUUID(),
        ),
      ).rejects.toThrow();
      const other = await buyer();
      const wrongApp = await sdk(other.identity, true, { clientId });
      await expect(wrongApp.getCatalog()).rejects.toThrow();
      await expect(
        wrongApp.getSubscription(other.identity.billingAccountId, "main"),
      ).rejects.toThrow();
      await db.query(
        "UPDATE app_client_registrations SET is_active=false WHERE id=$1",
        [clientId],
      );
      await expect(
        hosted.getSubscription(identity.billingAccountId, "main"),
      ).rejects.toThrow();
      await expect(
        hosted.revokeSeat(
          identity.billingAccountId,
          "main",
          assigned.data.id,
          randomUUID(),
        ),
      ).rejects.toThrow();
    });

    test("parallel requests cannot consume the same final seat", async () => {
      const { client, identity } = await trial();
      const subjects = await Promise.all([member(identity), member(identity)]);
      const outcomes = await Promise.allSettled(
        subjects.map((subject) =>
          client.assignSeat(identity.billingAccountId, "main", {
            subject,
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        (await client.listSeats(identity.billingAccountId, "main")).data.items,
      ).toHaveLength(1);
    });

    test("membership, app, environment and administrator authority are rechecked for records and writes", async () => {
      const { client, identity } = await trial(2);
      const subject = await member(identity);
      const reader = await sdk({ ...identity, actorUserId: subject });
      expect(
        (await reader.listSeats(identity.billingAccountId, "main")).data.items,
      ).toEqual([]);
      await expect(
        reader.assignSeat(identity.billingAccountId, "main", {
          subject,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      const liveReader = await sdk({ ...identity, actorUserId: subject }, true);
      await expect(
        liveReader.listSeats(identity.billingAccountId, "main"),
      ).rejects.toThrow();
      const other = await trial();
      await expect(
        client.listSeats(other.identity.billingAccountId, "main"),
      ).rejects.toThrow();
      await expect(
        client.assignSeat(identity.billingAccountId, "main", {
          subject: other.identity.actorUserId,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      await db.query("UPDATE users SET is_anonymous=true WHERE id=$1", [
        subject,
      ]);
      await expect(
        client.assignSeat(identity.billingAccountId, "main", {
          subject,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      await db.query("UPDATE users SET is_anonymous=false WHERE id=$1", [
        subject,
      ]);
      await db.query(
        "UPDATE app_billing_members SET revoked_at=now() WHERE user_id=$1",
        [subject],
      );
      await expect(
        reader.listSeats(identity.billingAccountId, "main"),
      ).rejects.toThrow();
      await expect(
        client.assignSeat(identity.billingAccountId, "main", {
          subject,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
    });

    test("DB-clock expiry and fencing prevent new seats while authorized removal remains available", async () => {
      const { client, identity, scopeId } = await trial(2);
      const seat = await client.assignSeat(identity.billingAccountId, "main", {
        subject: identity.actorUserId,
        idempotencyKey: randomUUID(),
      });
      const subject = await member(identity);
      await db.query(
        "UPDATE organization_entitlements SET effective_from=clock_timestamp()-interval '8 days',effective_until=clock_timestamp()-interval '1 second' WHERE billing_scope_id=$1",
        [scopeId],
      );
      await expect(
        client.assignSeat(identity.billingAccountId, "main", {
          subject,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      await db.query(
        "UPDATE app_billing_scopes SET fenced_at=clock_timestamp() WHERE id=$1",
        [scopeId],
      );
      expect(
        (
          await client.revokeSeat(
            identity.billingAccountId,
            "main",
            seat.data.id,
            randomUUID(),
          )
        ).data.revoked,
      ).toBe(true);
      expect(
        (await client.listSeats(identity.billingAccountId, "main")).data.items,
      ).toEqual([]);
    });

    test("pending subscription changes fence new seats but preserve safe removal", async () => {
      const { client, identity, scopeId } = await trial(2);
      const assigned = await client.assignSeat(
        identity.billingAccountId,
        "main",
        { subject: identity.actorUserId, idempotencyKey: randomUUID() },
      );
      const { appSubscriptionAuthorityRepository } = await import(
        "@/db/repositories/app-subscription-authority"
      );
      const state = await db.query(
        "SELECT lifecycle_revision FROM billing_subscriptions WHERE billing_scope_id=$1",
        [scopeId],
      );
      await appSubscriptionAuthorityRepository.prepareCommand({
        scopeId,
        actorUserId: identity.actorUserId,
        kind: "cancel",
        targetPlanRevisionId: null,
        quantity: 2,
        expectedSubscriptionRevision: Number(state.rows[0].lifecycle_revision),
        idempotencyKey: randomUUID(),
        requestDigest: "c".repeat(64),
        payload: {
          version: 1,
          domain: "buyer",
          action: "cancel",
          timing: "period_end",
        },
      });
      const subject = await member(identity);
      await expect(
        client.assignSeat(identity.billingAccountId, "main", {
          subject,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      expect(
        (
          await client.revokeSeat(
            identity.billingAccountId,
            "main",
            assigned.data.id,
            randomUUID(),
          )
        ).data.revoked,
      ).toBe(true);
    });

    test("authoritative absence is empty while malformed and cross-app cursors fail", async () => {
      const item = await buyer();
      const client = await sdk(item.identity);
      expect(
        (await client.listInvoices(item.identity.billingAccountId, "main"))
          .data,
      ).toEqual({ items: [], nextCursor: null });
      expect(
        (await client.listUsage(item.identity.billingAccountId, "main")).data,
      ).toEqual({ items: [], nextCursor: null });
      await expect(
        client.listSeats(item.identity.billingAccountId, "main", "invalid"),
      ).rejects.toThrow();
      const paid = await trial();
      const page = await paid.client.listInvoices(
        paid.identity.billingAccountId,
        "main",
      );
      expect(page.data.items[0]?.amountPaidCents).toBe(3000);
      expect(page.data.nextCursor).not.toBeNull();
      await expect(
        client.listInvoices(
          item.identity.billingAccountId,
          "main",
          page.data.nextCursor!,
        ),
      ).rejects.toThrow();
    });

    test("invoice pagination uses persisted merchant and customer, including after subscription cancellation", async () => {
      const { client, identity, scopeId } = await trial();
      await db.query(
        "UPDATE billing_subscriptions SET status='canceled' WHERE billing_scope_id=$1",
        [scopeId],
      );
      const first = await client.listInvoices(
        identity.billingAccountId,
        "main",
      );
      const second = await client.listInvoices(
        identity.billingAccountId,
        "main",
        first.data.nextCursor!,
      );
      expect(second.data.nextCursor).toBeNull();
      expect(second.data.items[0]?.id).not.toBe(first.data.items[0]?.id);
      expect(second.data.items[0]?.status).toBe("paid");
      expect(invoiceFixture.requests.at(-1)?.merchant).toBe("acct_runtime");
      expect(invoiceFixture.requests.at(-1)?.customer).not.toBe(
        "cus_infrastructure",
      );
    });

    test("provider failure, foreign invoice and membership revoked during provider I/O return errors", async () => {
      const { client, identity } = await trial();
      invoiceFixture.fail = true;
      await expect(
        client.listInvoices(identity.billingAccountId, "main"),
      ).rejects.toThrow();
      invoiceFixture.fail = false;
      invoiceFixture.wrongCustomer = true;
      await expect(
        client.listInvoices(identity.billingAccountId, "main"),
      ).rejects.toThrow();
      invoiceFixture.wrongCustomer = false;
      const page = await client.listInvoices(identity.billingAccountId, "main");
      invoiceFixture.repeatCursor = true;
      await expect(
        client.listInvoices(
          identity.billingAccountId,
          "main",
          page.data.nextCursor!,
        ),
      ).rejects.toThrow();
      invoiceFixture.repeatCursor = false;
      const user = await member(identity);
      const reader = await sdk({ ...identity, actorUserId: user });
      invoiceFixture.beforeResponse = async () => {
        await db.query(
          "UPDATE app_billing_members SET revoked_at=now() WHERE user_id=$1",
          [user],
        );
      };
      await expect(
        reader.listInvoices(identity.billingAccountId, "main"),
      ).rejects.toThrow();
      invoiceFixture.beforeResponse = null;
    });

    test("settled allowance usage paginates without exposing pending, canceled or another app's funding", async () => {
      const item = await trial();
      const other = await trial();
      const { writeTransaction } = await import("@/db/helpers");
      const { subscriptionAllowanceRepository: allowance } = await import(
        "@/db/repositories/subscription-allowance"
      );
      const { microsToMoney } = await import(
        "@/db/repositories/subscription-funding-reservations"
      );
      const { lockAppBillingScope } = await import(
        "@/db/repositories/app-subscription-authority"
      );
      const zero = microsToMoney(0n);
      async function operation(
        scopeId: string,
        disposition: "settled" | "pending" | "canceled",
      ) {
        const operationId = `records:${randomUUID()}`;
        await writeTransaction(async (tx) => {
          const scope = await lockAppBillingScope(tx, scopeId);
          const periods = await db.query(
            "SELECT id FROM subscription_allowance_periods WHERE billing_scope_id=$1",
            [scopeId],
          );
          const billingScope = { scopeId, merchantKey: scope.merchantKey };
          const result = await allowance.reserve(tx, {
            organizationId: org,
            billingScope,
            periodId: periods.rows[0].id,
            logicalOperationId: operationId,
            requestDigest: "a".repeat(64),
            requestedAmount: microsToMoney(10000n),
            allowanceAmount: microsToMoney(10000n),
            purchasedCreditAmount: zero,
            purchasedCreditReservationTransactionId: null,
          });
          const terminal = {
            organizationId: org,
            billingScope,
            reservationId: result.reservation.id,
            idempotencyKey: randomUUID(),
            requestDigest: "b".repeat(64),
            purchasedCreditSettlementTransactionId: null,
            purchasedCreditRefundTransactionId: null,
          };
          if (disposition === "settled")
            await allowance.finalize(tx, {
              ...terminal,
              actualAllowanceAmount: microsToMoney(5000n),
              actualPurchasedCreditAmount: zero,
              uncollectedOverageAmount: zero,
            });
          if (disposition === "canceled") await allowance.cancel(tx, terminal);
        });
        return operationId;
      }
      const operations = new Set<string>();
      for (let index = 0; index < 101; index++)
        operations.add(await operation(item.scopeId, "settled"));
      await operation(item.scopeId, "pending");
      await operation(item.scopeId, "canceled");
      await operation(other.scopeId, "settled");
      const first = await item.client.listUsage(
        item.identity.billingAccountId,
        "main",
      );
      expect(first.data.items).toHaveLength(100);
      expect(first.data.nextCursor).not.toBeNull();
      const second = await item.client.listUsage(
        item.identity.billingAccountId,
        "main",
        first.data.nextCursor!,
      );
      expect(second.data.items).toHaveLength(1);
      expect(second.data.nextCursor).toBeNull();
      const rows = [...first.data.items, ...second.data.items];
      expect(new Set(rows.map((row) => row.operationId))).toEqual(operations);
      expect(
        rows.every(
          (row) =>
            row.fundingSource === "trial" && row.amountUsd === "0.005000",
        ),
      ).toBe(true);
      await expect(
        other.client.listUsage(
          other.identity.billingAccountId,
          "main",
          first.data.nextCursor!,
        ),
      ).rejects.toThrow();
    });
  },
);

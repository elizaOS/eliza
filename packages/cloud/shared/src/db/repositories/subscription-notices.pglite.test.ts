/** Exercises canonical terminal notice production, durable submission uncertainty and supersession with real PGlite transactions and loopback SMTP; no message leaves the test process. */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { buildOrganizationSubscriptionSnapshot } from "../../lib/services/account-subscription-snapshot";
import {
  claimSubscriptionNotice,
  dispatchSubscriptionNotice,
  processSubscriptionNotice,
  sweepSubscriptionNotices,
} from "../../lib/services/subscription-notices";
import { readPrimaryOrganizationSubscription } from "./account-billing-snapshot-subscription";
import { installOrganizationPolicyTestSchema } from "./organization-policy-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);
const ORG_A = "51000000-0000-4000-8000-000000000001";
const ORG_B = "51000000-0000-4000-8000-000000000002";
const USER = "52000000-0000-4000-8000-000000000001";
const SUB_A = "53000000-0000-4000-8000-000000000001";
const SUB_B = "53000000-0000-4000-8000-000000000002";
const DIGEST_A = "a".repeat(64);
let retrieve: (id: string) => Promise<object> = async () => providerSubscription();
mock.module("../../lib/stripe", () => ({
  requireStripe: () => ({ subscriptions: { retrieve: (id: string) => retrieve(id) } }),
}));
let processStripeEvent: typeof import("../../../../api/src/queue/stripe-event").processStripeEvent;
let client: typeof import("../client");
let entitlements: import("./subscription-entitlements").SubscriptionEntitlementsRepository;
let authority: import("./subscription-authority").SubscriptionAuthorityRepository;
function getPgliteClientForTests() {
  return client.getPgliteClientForTests();
}
beforeAll(async () => {
  ({ processStripeEvent } = await import("../../../../api/src/queue/stripe-event"));
  process.env.STRIPE_SECRET_KEY = "sk_test_terminalfixture";
  process.env.ENVIRONMENT = "local";
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
  process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
  process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
  process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
  client = await import("../client");
  ({ subscriptionEntitlementsRepository: entitlements } = await import(
    "./subscription-entitlements"
  ));
  ({ subscriptionAuthorityRepository: authority } = await import("./subscription-authority"));
  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true, account_lifecycle_state text NOT NULL DEFAULT 'active', paid_work_fenced_at timestamptz, stripe_customer_id text);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id));
  `);
  await installOrganizationPolicyTestSchema((query) => getPgliteClientForTests().exec(query));
  const noticeMigration = await readFile(
    new URL("../migrations/0382_subscription_notice_intents.sql", import.meta.url),
    "utf8",
  );
  for (const statement of noticeMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
});
beforeEach(async () => {
  for (const key of mailKeys) delete process.env[key];
  submissions = 0;
  closedConnections = 0;
  retrieve = async () => providerSubscription();
  await getPgliteClientForTests().exec(`
    ALTER TABLE billing_subscription_revisions DISABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions DISABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    TRUNCATE TABLE billing_subscriptions, users, organizations CASCADE;
    ALTER TABLE billing_subscription_revisions ENABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions ENABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    INSERT INTO organizations (id, stripe_customer_id) VALUES ('${ORG_A}', 'cus_repoa'), ('${ORG_B}', 'cus_repob');
    INSERT INTO users (id) VALUES ('${USER}');
    INSERT INTO billing_subscriptions (
      id, organization_id, provider_environment, stripe_customer_id,
      stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      lifecycle_revision, provider_object_digest
    ) VALUES
      ('${SUB_A}', '${ORG_A}', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa', 'plus_monthly', 'v1', 'active',
       '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, '${DIGEST_A}'),
      ('${SUB_B}', '${ORG_B}', 'test', 'cus_repob', 'sub_repob', 'si_repob', 'plus_monthly', 'v1', 'active',
       '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, '${DIGEST_A}');
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source, provider_environment,
      stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, plan_key, catalog_version, status,
      current_period_start, current_period_end, cancel_at_period_end,
      provider_object_digest
    ) VALUES ('${ORG_A}', '${SUB_A}', 1, 'webhook', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa',
      'plus_monthly', 'v1', 'active', '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z', false, '${DIGEST_A}');
    UPDATE organization_subscription_authorities SET subscription_id = '${SUB_A}', state = 'current' WHERE organization_id = '${ORG_A}';
    UPDATE organization_subscription_authorities SET subscription_id = '${SUB_B}', state = 'current' WHERE organization_id = '${ORG_B}';
  `);
});

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

function providerSubscription() {
  return {
    id: "sub_repoa",
    object: "subscription",
    livemode: false,
    customer: "cus_repoa",
    status: "canceled",
    current_period_start: Date.parse("2026-08-01Z") / 1000,
    current_period_end: Date.parse("2026-09-01Z") / 1000,
    cancel_at_period_end: false,
    canceled_at: Date.parse("2026-08-25Z") / 1000,
    ended_at: Date.parse("2026-08-25Z") / 1000,
    on_behalf_of: null,
    transfer_data: null,
    application_fee_percent: null,
    schedule: null,
    pending_update: null,
    pause_collection: null,
    items: {
      has_more: false,
      data: [
        {
          id: "si_repoa",
          object: "subscription_item",
          quantity: 1,
          price: {
            id: "price_plus",
            product: "prod_plus",
            livemode: false,
            currency: "usd",
            unit_amount: 3000,
            type: "recurring",
            billing_scheme: "per_unit",
            transform_quantity: null,
            recurring: {
              interval: "month",
              interval_count: 1,
              usage_type: "licensed",
              trial_period_days: null,
            },
          },
        },
      ],
    },
  };
}
function delivery(id = "evt_terminal", created = Date.parse("2026-08-25Z") / 1000) {
  const event: import("stripe").default.CustomerSubscriptionUpdatedEvent = JSON.parse(
    JSON.stringify({
      id,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      created,
      data: {
        object: {
          id: "sub_repoa",
          object: "subscription",
          status: "active",
          metadata: { credits: "999", organization_id: ORG_B },
        },
      },
    }),
  );
  return {
    body: {
      kind: "stripe.event" as const,
      eventId: id,
      eventType: event.type,
      event,
      receivedAt: Date.now(),
    },
    attempts: 1,
  };
}
async function rows(table: string) {
  return (await getPgliteClientForTests().query(`SELECT * FROM ${table}`)).rows;
}

const mailKeys = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SENDGRID_API_KEY",
  "SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON",
] as const;
const priorMail = new Map(mailKeys.map((key) => [key, process.env[key]]));
let server: Server | null = null;
const sockets = new Set<Socket>();
let submissions = 0;
let closedConnections = 0;
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve, reject) =>
      closing.close((error) => (error ? reject(error) : resolve())),
    );
  }
  for (const [key, value] of priorMail) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
async function smtp(
  mode: "accept" | "disconnect" | "reject" | "stall" | "trickle" | "tls_stall" = "accept",
) {
  server = createServer((socket) => {
    sockets.add(socket);
    let trickle: ReturnType<typeof setInterval> | undefined;
    socket.on("close", () => {
      closedConnections += 1;
      clearInterval(trickle);
    });
    let pending = "",
      data = false;
    let upgrading = false;
    socket.write("220 localhost ESMTP\r\n");
    socket.on("data", (chunk) => {
      if (upgrading) return;
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.substring(0, end);
        pending = pending.substring(end + 2);
        if (data) {
          if (line !== ".") continue;
          data = false;
          submissions += 1;
          if (mode === "trickle") {
            trickle = setInterval(() => socket.write("250-still processing\r\n"), 20);
            continue;
          }
          if (mode === "stall") continue;
          if (mode === "disconnect") socket.destroy();
          else socket.write(mode === "reject" ? "550 rejected\r\n" : "250 queued\r\n");
        } else if (line.startsWith("EHLO"))
          socket.write(
            mode === "tls_stall"
              ? "250-localhost\r\n250 STARTTLS\r\n"
              : "250-localhost\r\n250 AUTH PLAIN\r\n",
          );
        else if (line === "STARTTLS") {
          upgrading = true;
          socket.write("220 start TLS\r\n");
        } else if (line.startsWith("AUTH")) socket.write("235 authenticated\r\n");
        else if (line.startsWith("DATA")) {
          data = true;
          socket.write("354 continue\r\n");
        } else if (line.startsWith("QUIT")) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  const listening = server;
  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(0, "127.0.0.1", resolve);
  });
  const address = listening.address();
  if (!address || typeof address === "string") throw new Error("Loopback address missing");
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(address.port);
  process.env.SMTP_USERNAME = "fixture";
  process.env.SMTP_PASSWORD = "fixture";
}
async function notice() {
  expect(await processStripeEvent(delivery())).toBe("ack");
  const result = (await rows("subscription_notice_intents"))[0];
  if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string")
    throw new Error("Canonical notice missing");
  return result.id;
}
function approve() {
  const config = {
    approvalReference: "controlled-test-policy",
    organizationId: ORG_A,
    subscriptionId: SUB_A,
    sourceRevision: 2,
    kind: "cancel_effective",
    recipient: "recipient@example.test",
    sendAt: new Date(Date.now() - 1000).toISOString(),
    notAfter: new Date(Date.now() + 60000).toISOString(),
    timezone: "Etc/UTC",
    subject: "Controlled cancellation fixture",
    text: "Controlled fixture only",
    html: "<p>Controlled fixture only</p>",
  };
  process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([config]);
  return config;
}
test("canonical canceled revision produces unavailable policy without sending or inventing recipient", async () => {
  const id = await notice();
  expect(await processStripeEvent(delivery())).toBe("ack");
  expect(await sweepSubscriptionNotices()).toEqual({ inspected: 1, policyUnavailable: 1 });
  expect(await rows("subscription_notice_intents")).toEqual([
    expect.objectContaining({ id, state: "policy_unavailable", source_revision: 2 }),
  ]);
  expect(await rows("subscription_notice_attempts")).toHaveLength(0);
  expect(await authority.findById(ORG_A, SUB_A)).toMatchObject({
    status: "canceled",
    lifecycle_revision: 2,
  });
  expect(submissions).toBe(0);
});
test("notice insert failure rolls back source projection receipt and intent together", async () => {
  await getPgliteClientForTests().exec(
    "CREATE FUNCTION fail_notice_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write failure'; END $$; CREATE TRIGGER fail_notice BEFORE INSERT ON subscription_notice_intents FOR EACH ROW EXECUTE FUNCTION fail_notice_insert()",
  );
  try {
    expect(await processStripeEvent(delivery())).toBe("retry");
    expect(await authority.findById(ORG_A, SUB_A)).toMatchObject({
      status: "active",
      lifecycle_revision: 1,
    });
    expect(await entitlements.find(ORG_A)).toMatchObject({ projection_revision: 0 });
    expect(await rows("subscription_notice_intents")).toHaveLength(0);
    expect(await rows("billing_subscription_event_receipts")).toEqual([
      expect.objectContaining({ status: "received" }),
    ]);
  } finally {
    await getPgliteClientForTests().exec(
      "DROP TRIGGER fail_notice ON subscription_notice_intents; DROP FUNCTION fail_notice_insert()",
    );
  }
});
test("concurrent claims and duplicate dispatches produce one accepted SMTP submission, never delivered", async () => {
  const id = await notice();
  approve();
  await smtp();
  const claims = await Promise.all(Array.from({ length: 4 }, () => claimSubscriptionNotice(id)));
  const claimed = claims.filter((value) => value !== null);
  expect(claimed).toHaveLength(1);
  await dispatchSubscriptionNotice(claimed[0]!);
  await dispatchSubscriptionNotice(claimed[0]!);
  expect(submissions).toBe(1);
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({
      status: "accepted",
      provider: "smtp",
      message_id: expect.any(String),
    }),
  ]);
  expect(await rows("subscription_notice_intents")).toEqual([
    expect.objectContaining({ state: "accepted" }),
  ]);
  expect(JSON.stringify(await rows("subscription_notice_attempts"))).not.toContain("delivered");
});
test("crash before submission leaves an expired durable attempt uncertain and never resends", async () => {
  const id = await notice();
  approve();
  await smtp();
  expect(await claimSubscriptionNotice(id, 1)).not.toBeNull();
  await Bun.sleep(5);
  await processSubscriptionNotice(id);
  await processSubscriptionNotice(id);
  expect(submissions).toBe(0);
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({ status: "uncertain", reason: "submission_outcome_unrecorded" }),
  ]);
  expect(await publicSnapshot()).toMatchObject({
    status: "available",
    value: {
      cancellationNotice: {
        status: "available",
        value: { state: "uncertain", delivery: "not_observed" },
      },
    },
  });
});
test("crash after SMTP acceptance but before receipt commit never blindly resends", async () => {
  const id = await notice();
  approve();
  await smtp();
  const claim = await claimSubscriptionNotice(id, 1000);
  if (!claim) throw new Error("Expected claim");
  await getPgliteClientForTests().exec(
    "CREATE FUNCTION fail_notice_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='accepted' THEN RAISE EXCEPTION 'fixture crash after acceptance'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_notice_receipt BEFORE UPDATE ON subscription_notice_attempts FOR EACH ROW EXECUTE FUNCTION fail_notice_receipt()",
  );
  try {
    await expect(dispatchSubscriptionNotice(claim)).rejects.toThrow();
  } finally {
    await getPgliteClientForTests().exec(
      "DROP TRIGGER fail_notice_receipt ON subscription_notice_attempts; DROP FUNCTION fail_notice_receipt()",
    );
  }
  expect(submissions).toBe(1);
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({ status: "dispatching", message_id: null }),
  ]);
  await Bun.sleep(1100);
  await processSubscriptionNotice(id);
  await processSubscriptionNotice(id);
  expect(submissions).toBe(1);
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({ status: "uncertain" }),
  ]);
});
test("source advancement suppresses stale submission and preserves an unsent successor", async () => {
  const id = await notice();
  approve();
  await smtp();
  const claim = await claimSubscriptionNotice(id);
  if (!claim) throw new Error("Expected claim");
  expect(await processStripeEvent(delivery("evt_newer", Date.parse("2026-08-26Z") / 1000))).toBe(
    "ack",
  );
  await dispatchSubscriptionNotice(claim);
  expect(submissions).toBe(0);
  expect(await rows("subscription_notice_intents")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: "superseded", source_revision: 2 }),
      expect.objectContaining({ state: "policy_unavailable", source_revision: 3 }),
    ]),
  );
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({ status: "superseded" }),
  ]);
  expect(await publicSnapshot()).toMatchObject({
    status: "available",
    value: {
      lifecycleRevision: "3",
      cancellationNotice: {
        status: "available",
        value: { sourceLifecycleRevision: "3", state: "policy_unavailable" },
      },
    },
  });
  const config = approve();
  process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([
    { ...config, sourceRevision: 3 },
  ]);
  await sweepSubscriptionNotices();
  expect(submissions).toBe(1);
  expect(await rows("subscription_notice_intents")).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: "accepted", source_revision: 3 })]),
  );
});
test("changed explicit policy digest is rechecked before SMTP", async () => {
  const id = await notice();
  const config = approve();
  await smtp();
  const claim = await claimSubscriptionNotice(id);
  if (!claim) throw new Error("Expected claim");
  process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([
    { ...config, timezone: "America/New_York" },
  ]);
  await dispatchSubscriptionNotice(claim);
  expect(submissions).toBe(0);
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({ status: "superseded" }),
  ]);
});
for (const mode of ["disconnect", "reject"] as const)
  test(`SMTP ${mode} preserves typed outcome and never resends without new policy`, async () => {
    const id = await notice();
    approve();
    await smtp(mode);
    await processSubscriptionNotice(id);
    await processSubscriptionNotice(id);
    expect(submissions).toBe(1);
    expect(await rows("subscription_notice_attempts")).toEqual([
      expect.objectContaining({ status: mode === "disconnect" ? "uncertain" : "rejected" }),
    ]);
  });

test("missing or foreign approval and inactive organization never reach SMTP", async () => {
  const id = await notice();
  const config = approve();
  await smtp();
  process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([
    { ...config, organizationId: ORG_B },
  ]);
  expect(await claimSubscriptionNotice(id)).toBeNull();
  expect(await rows("subscription_notice_attempts")).toHaveLength(0);
  process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([config]);
  await getPgliteClientForTests().exec(
    `UPDATE organizations SET is_active=false WHERE id='${ORG_A}'`,
  );
  await processSubscriptionNotice(id);
  expect(submissions).toBe(0);
  expect(await rows("subscription_notice_intents")).toEqual([
    expect.objectContaining({ state: "superseded" }),
  ]);
});
test("SMTP trickling acknowledgement is physically closed at the absolute deadline", async () => {
  const id = await notice();
  approve();
  await smtp("trickle");
  const claim = await claimSubscriptionNotice(id, 1000);
  if (!claim) throw new Error("Expected claim");
  const started = performance.now();
  await dispatchSubscriptionNotice(claim);
  expect(performance.now() - started).toBeLessThan(3000);
  await Bun.sleep(10);
  expect(closedConnections).toBe(1);
  expect(submissions).toBe(1);
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({ status: "uncertain", reason: "transport_error" }),
  ]);
  await processSubscriptionNotice(id);
  expect(submissions).toBe(1);
});

test("explicit future schedule remains scheduled and revoked policy becomes unavailable", async () => {
  const id = await notice();
  const config = approve();
  process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([
    { ...config, sendAt: new Date(Date.now() + 30000).toISOString() },
  ]);
  await processSubscriptionNotice(id);
  expect(await rows("subscription_notice_intents")).toEqual([
    expect.objectContaining({ state: "scheduled" }),
  ]);
  expect(await rows("subscription_notice_attempts")).toHaveLength(0);
  delete process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON;
  await processSubscriptionNotice(id);
  expect(await rows("subscription_notice_intents")).toEqual([
    expect.objectContaining({ state: "policy_unavailable" }),
  ]);
});

for (const mode of ["accept", "disconnect"] as const)
  test(`new canceled revision after ${mode} requires reconciliation instead of sending again`, async () => {
    const id = await notice();
    const config = approve();
    await smtp(mode);
    await processSubscriptionNotice(id);
    expect(submissions).toBe(1);
    expect(await processStripeEvent(delivery("evt_newer", Date.parse("2026-08-26Z") / 1000))).toBe(
      "ack",
    );
    process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([
      { ...config, sourceRevision: 3 },
    ]);
    await sweepSubscriptionNotices();
    await sweepSubscriptionNotices();
    expect(submissions).toBe(1);
    expect(await rows("subscription_notice_intents")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_revision: 3, state: "reconciliation_required" }),
      ]),
    );
    expect(await rows("subscription_notice_attempts")).toHaveLength(1);
  });

async function cloneCurrentNotice(index: number) {
  const org = `51000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
  const sub = `53000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
  await getPgliteClientForTests().exec(`
    INSERT INTO organizations(id) VALUES ('${org}');
    INSERT INTO billing_subscriptions SELECT (jsonb_populate_record(NULL::billing_subscriptions,
      to_jsonb(s) || jsonb_build_object('id','${sub}','organization_id','${org}',
       'stripe_customer_id','cus_clone${index}','stripe_subscription_id','sub_clone${index}','stripe_subscription_item_id','si_clone${index}'))).*
      FROM billing_subscriptions s WHERE id='${SUB_A}';
    INSERT INTO billing_subscription_revisions SELECT (jsonb_populate_record(NULL::billing_subscription_revisions,
      to_jsonb(r) || jsonb_build_object('id',gen_random_uuid(),'provider_event_id','evt_clone${index}','subscription_id','${sub}','organization_id','${org}',
       'stripe_customer_id','cus_clone${index}','stripe_subscription_id','sub_clone${index}','stripe_subscription_item_id','si_clone${index}'))).*
      FROM billing_subscription_revisions r WHERE subscription_id='${SUB_A}' AND revision=2;
    UPDATE organization_subscription_authorities SET state='current',subscription_id='${sub}' WHERE organization_id='${org}';
    INSERT INTO subscription_notice_intents(organization_id,subscription_id,source_revision) VALUES ('${org}','${sub}',2);
  `);
  return { org, sub };
}
test("ten old unavailable current notices rotate so a later due notice is submitted", async () => {
  await notice();
  for (let index = 0; index < 10; index++) await cloneCurrentNotice(index);
  const config = approve();
  const dueOrg = "51000000-0000-4000-8000-000000000109";
  const dueSub = "53000000-0000-4000-8000-000000000109";
  process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([
    { ...config, organizationId: dueOrg, subscriptionId: dueSub },
  ]);
  await smtp();
  expect(await sweepSubscriptionNotices()).toEqual({ inspected: 10, policyUnavailable: 10 });
  expect(submissions).toBe(0);
  await sweepSubscriptionNotices();
  expect(submissions).toBe(1);
  expect(await rows("subscription_notice_intents")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ organization_id: dueOrg, state: "accepted" }),
    ]),
  );
});
test("a future approved notice does not consume the due submission budget", async () => {
  await notice();
  const second = await cloneCurrentNotice(1);
  const config = approve();
  process.env.SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON = JSON.stringify([
    { ...config, sendAt: new Date(Date.now() + 30000).toISOString() },
    { ...config, organizationId: second.org, subscriptionId: second.sub },
  ]);
  await smtp();
  await sweepSubscriptionNotices();
  expect(submissions).toBe(1);
  expect(await rows("subscription_notice_intents")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ organization_id: ORG_A, state: "scheduled" }),
      expect.objectContaining({ organization_id: second.org, state: "accepted" }),
    ]),
  );
});

test("absolute deadline closes the physical socket during an incomplete STARTTLS upgrade", async () => {
  const id = await notice();
  approve();
  await smtp("tls_stall");
  const claim = await claimSubscriptionNotice(id, 1000);
  if (!claim) throw new Error("Expected claim");
  const started = performance.now();
  await dispatchSubscriptionNotice(claim);
  expect(performance.now() - started).toBeLessThan(3000);
  await Bun.sleep(10);
  expect(closedConnections).toBe(1);
  expect(submissions).toBe(0);
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({ status: "uncertain", reason: "transport_error" }),
  ]);
});
test("SendGrid remains explicitly unavailable for bounded notice submission", async () => {
  const id = await notice();
  approve();
  process.env.SENDGRID_API_KEY = "SG.controlled-fixture-unused";
  await processSubscriptionNotice(id);
  expect(await rows("subscription_notice_attempts")).toEqual([
    expect.objectContaining({
      status: "unavailable",
      reason: "bounded_transport_unavailable",
      provider: null,
    }),
  ]);
});

async function publicSnapshot(organizationId = ORG_A) {
  return client.dbRead.transaction(
    async (tx) =>
      buildOrganizationSubscriptionSnapshot(
        await readPrimaryOrganizationSubscription(tx, organizationId),
        new Date().toISOString(),
        { status: "unavailable", code: "subscription_allowance_not_spendable" },
      ),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
test("public current-revision status exposes policy absence without recipient or provider authority", async () => {
  await notice();
  const actual = await publicSnapshot();
  expect(actual).toMatchObject({
    status: "available",
    value: {
      lifecycleRevision: "2",
      cancellationNotice: {
        status: "available",
        value: {
          sourceLifecycleRevision: "2",
          state: "policy_unavailable",
          channel: "email",
          delivery: "not_observed",
        },
      },
    },
  });
  const encoded = JSON.stringify(actual);
  for (const secret of [ORG_A, SUB_A, "cus_repoa", "sub_repoa", "si_repoa", DIGEST_A])
    expect(encoded).not.toContain(secret);
  expect(submissions).toBe(0);
});
test("public status distinguishes SMTP acceptance from recipient delivery", async () => {
  const id = await notice();
  approve();
  await smtp();
  await processSubscriptionNotice(id);
  expect(submissions).toBe(1);
  const actual = await publicSnapshot();
  expect(actual).toMatchObject({
    status: "available",
    value: {
      cancellationNotice: {
        status: "available",
        value: { state: "accepted", delivery: "not_observed" },
      },
    },
  });
  const attempt = (await rows("subscription_notice_attempts"))[0];
  if (
    !attempt ||
    typeof attempt !== "object" ||
    !("message_id" in attempt) ||
    typeof attempt.message_id !== "string"
  )
    throw new Error("Expected persisted SMTP acceptance receipt");
  expect(JSON.stringify(actual)).not.toContain(attempt.message_id);
  expect(JSON.stringify(actual)).not.toContain("policy_digest");
  expect(JSON.stringify(actual)).not.toContain("recipient");
});

test("a canceled source with missing intent stays unavailable rather than claiming no notice", async () => {
  const id = await notice();
  await getPgliteClientForTests().query("DELETE FROM subscription_notice_intents WHERE id=$1", [
    id,
  ]);
  expect(await publicSnapshot()).toMatchObject({
    status: "available",
    value: {
      cancellationNotice: {
        status: "unavailable",
        error: { code: "subscription_notice_unavailable" },
      },
    },
  });
  expect(submissions).toBe(0);
});

test("coherent organizations read only their own current notice state", async () => {
  const id = await notice();
  approve();
  await smtp();
  await processSubscriptionNotice(id);
  const foreign = await cloneCurrentNotice(42);
  await entitlements.rebuild({
    organizationId: foreign.org,
    sourceSubscriptionId: foreign.sub,
    sourceSubscriptionRevision: 2,
    expectedProjectionRevision: 0,
  });
  const ownSnapshot = await publicSnapshot();
  const foreignSnapshot = await publicSnapshot(foreign.org);
  expect(ownSnapshot).toMatchObject({
    status: "available",
    value: {
      lifecycleRevision: "2",
      cancellationNotice: {
        status: "available",
        value: { sourceLifecycleRevision: "2", state: "accepted" },
      },
    },
  });
  expect(foreignSnapshot).toMatchObject({
    status: "available",
    value: {
      lifecycleRevision: "2",
      cancellationNotice: {
        status: "available",
        value: { sourceLifecycleRevision: "2", state: "policy_unavailable" },
      },
    },
  });
  const encoded = JSON.stringify(foreignSnapshot);
  for (const value of [ORG_A, SUB_A, "accepted", "cus_repoa", "sub_repoa", "si_repoa"])
    expect(encoded).not.toContain(value);
  expect(submissions).toBe(1);
});

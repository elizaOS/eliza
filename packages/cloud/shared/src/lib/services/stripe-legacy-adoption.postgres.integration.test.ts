/** Real PostgreSQL row-lock evidence for the Stripe legacy selection hint. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { testOutputPath } from "../../../../../scripts/lib/test-output";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";

let admin: Client | undefined;
let connectionString = "";
const databaseName = `qa_stripe_legacy_${randomUUID().replaceAll("-", "")}`;
let repository: typeof import("../../db/repositories/stripe-legacy-adoption-cursors");
let database: typeof import("../../db/client");
let webhooks: typeof import("../../db/repositories/webhook-events")["webhookEventsRepository"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  const supplied = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
  if (!supplied)
    throw new Error("Stripe legacy cursor tests require isolated loopback qa_* PostgreSQL");
  const parsed = new URL(supplied);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !parsed.username.startsWith("qa_")
  )
    throw new Error("Stripe legacy cursor tests refuse non-loopback or non-qa PostgreSQL");
  admin = new Client({ connectionString: supplied });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  parsed.pathname = `/${databaseName}`;
  connectionString = parsed.toString();
  const setup = new Client({ connectionString });
  await setup.connect();
  try {
    await setup.query(
      `CREATE TABLE webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp,app_billing_trigger jsonb,app_billing_completed_at timestamptz,app_billing_next_attempt_at timestamptz NOT NULL DEFAULT now(),app_billing_error_code text)`,
    );
    for (const tag of [
      "0555_stripe_delivery_outbox",
      "0556_stripe_delivery_outbox_due_index",
      "0557_stripe_delivery_lease_check_validate",
      "0564_stripe_legacy_adoption_cursors",
    ]) {
      const migration = await readFile(
        new URL(`../../db/migrations/${tag}.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        if (statement.trim()) await setup.query(statement);
    }
  } finally {
    await setup.end();
  }
  database = await import("../../db/client");
  repository = await import("../../db/repositories/stripe-legacy-adoption-cursors");
  webhooks = (await import("../../db/repositories/webhook-events")).webhookEventsRepository;
}, 30_000);

afterAll(async () => {
  await database?.closeDatabaseConnectionsForTests();
  if (admin) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});

function run<T>(body: () => Promise<T>): Promise<T> {
  return runWithCloudBindingsAsync(
    {
      DATABASE_URL: connectionString,
      TEST_DATABASE_URL: connectionString,
      NODE_ENV: "test",
      ENVIRONMENT: "local",
    },
    body,
  );
}

async function connected(): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function observeBlocked(observer: Client, blocker: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity activity
      WHERE activity.datname=current_database()
      AND activity.wait_event_type='Lock'
      AND $1::integer=ANY(pg_blocking_pids(activity.pid))) AS blocked`,
      [blocker],
    );
    if (result.rows[0]?.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("PostgreSQL cursor selection waits and uses the winning locked hint", async () => {
  const holder = await connected();
  const observer = await connected();
  const hashes = Array.from({ length: 4 }, (_, i) => digest(`locked-${i}`)).sort();
  const source = "postgres:locked-cursor";
  let pending: ReturnType<typeof repository.selectLegacyStripeAdoptionDigests> | undefined;
  try {
    await holder.query(
      "INSERT INTO stripe_legacy_adoption_cursors(source_key,cursor_digest,revision) VALUES($1,$2,1)",
      [source, hashes[0]],
    );
    const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
      .pid;
    await holder.query("BEGIN");
    await holder.query(
      "SELECT source_key FROM stripe_legacy_adoption_cursors WHERE source_key=$1 FOR UPDATE",
      [source],
    );
    pending = run(() => repository.selectLegacyStripeAdoptionDigests(source, hashes));
    void pending.catch(() => undefined);
    expect(await observeBlocked(observer, pid)).toBe(true);
    await holder.query(
      "UPDATE stripe_legacy_adoption_cursors SET cursor_digest=$2,revision=7 WHERE source_key=$1",
      [source, hashes[1]],
    );
    await holder.query("COMMIT");
    const selected = await pending;
    expect(selected?.digests[0]).toBe(hashes[2]);
    expect(selected?.revision).toBe(8n);
  } finally {
    await holder.query("ROLLBACK");
    if (pending) await pending.catch(() => undefined);
    await holder.end();
    await observer.end();
  }
}, 15_000);

test("PostgreSQL partial retention index skips retained legacy history", async () => {
  const observer = await connected();
  try {
    await observer.query(
      "CREATE INDEX webhook_events_processed_at_idx ON webhook_events(processed_at)",
    );
    await observer.query(
      "CREATE INDEX webhook_events_provider_processed_idx ON webhook_events(provider,processed_at)",
    );
    await observer.query(`INSERT INTO webhook_events(event_id,provider,payload_hash,processed_at,delivery_legacy_retained)
      SELECT 'evt_plan_retained_'||i,'stripe','hash',now()-interval '60 days',true FROM generate_series(1,100000) AS i;
      INSERT INTO webhook_events(event_id,provider,payload_hash,processed_at,delivery_legacy_retained)
      SELECT 'evt_plan_eligible_'||i,'stripe','hash',now()-interval '40 days',false FROM generate_series(1,100) AS i;
      ANALYZE webhook_events`);
    const plans: Record<string, unknown> = {};
    for (const phase of ["before", "after"]) {
      if (phase === "after") {
        await observer.query(
          await readFile(
            new URL("../../db/migrations/0565_stripe_legacy_retention_index.sql", import.meta.url),
            "utf8",
          ),
        );
        await observer.query("ANALYZE webhook_events");
      }
      for (const provider of [false, true]) {
        await observer.query("BEGIN");
        try {
          const result = await observer.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM webhook_events
            WHERE processed_at<$1 AND delivery_legacy_retained=false
            AND (app_billing_trigger IS NULL OR app_billing_completed_at IS NOT NULL)
            AND (delivery_payload IS NULL OR delivery_completed_at IS NOT NULL OR delivery_dead_lettered_at IS NOT NULL)
            ${provider ? "AND provider='stripe'" : ""}`,
            [new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)],
          );
          const plan = result.rows[0]["QUERY PLAN"][0];
          plans[`${phase}_${provider ? "provider" : "global"}`] = plan;
          const scan = plan.Plan.Plans[0];
          expect(scan["Actual Rows"]).toBe(100);
          if (phase === "before")
            expect(scan["Rows Removed by Filter"]).toBeGreaterThanOrEqual(100000);
          else {
            expect(scan["Index Name"]).toBe("webhook_events_unretained_processed_idx");
            expect(scan["Rows Removed by Filter"] ?? 0).toBe(0);
          }
        } finally {
          await observer.query("ROLLBACK");
        }
      }
    }
    const output = testOutputPath("stripe-legacy-retention-plan");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "plans.json"), `${JSON.stringify(plans, null, 2)}\n`);
  } finally {
    try {
      await observer.query("TRUNCATE webhook_events");
    } finally {
      await observer.end();
    }
  }
}, 30_000);

for (const cleanupKind of ["global", "provider", "old unfiltered"] as const) {
  test(`PostgreSQL ${cleanupKind} cleanup waits for atomic legacy receipt retention`, async () => {
    const holder = await connected();
    const observer = await connected();
    const oldCleaner = await connected();
    const eventId = `evt_cleanup_${cleanupKind}`;
    const body: StripeEventMessage = {
      kind: "stripe.event",
      eventId,
      eventType: "charge.refunded",
      event: {
        id: eventId,
        object: "event",
        type: "charge.refunded",
      } as StripeEventMessage["event"],
      receivedAt: 1,
    };
    const hash = digest(JSON.stringify(body.event));
    const lock = cleanupKind === "global" ? 429081 : cleanupKind === "provider" ? 429082 : 429083;
    let adoption: Promise<unknown> | undefined;
    let cleanup: Promise<number> | undefined;
    try {
      await holder.query(
        `INSERT INTO webhook_events(event_id,provider,event_type,payload_hash,processed_at,delivery_completed_at) VALUES($1,'stripe','charge.refunded',$2,now()-interval '60 days',now())`,
        [eventId, hash],
      );
      await holder.query(
        `CREATE FUNCTION pause_legacy_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.delivery_legacy_retained THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`,
      );
      await holder.query(
        "CREATE TRIGGER pause_legacy_retention BEFORE UPDATE OF delivery_legacy_retained ON webhook_events FOR EACH ROW EXECUTE FUNCTION pause_legacy_retention()",
      );
      await holder.query("SELECT pg_advisory_lock($1)", [lock]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      adoption = run(() => webhooks.adoptLegacyStripeDelivery(body, hash));
      void adoption.catch(() => undefined);
      expect(await observeBlocked(observer, holderPid)).toBe(true);
      const adoptionPid = (
        await observer.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          [holderPid],
        )
      ).rows[0]!.pid;
      cleanup =
        cleanupKind === "old unfiltered"
          ? oldCleaner
              .query("DELETE FROM webhook_events WHERE event_id=$1 RETURNING id", [eventId])
              .then((result) => result.rowCount ?? 0)
          : run(() =>
              cleanupKind === "provider"
                ? webhooks.cleanupOldEventsForProvider("stripe", 30)
                : webhooks.cleanupOldEvents(30),
            );
      void cleanup.catch(() => undefined);
      expect(await observeBlocked(observer, adoptionPid)).toBe(true);
      await holder.query("SELECT pg_advisory_unlock($1)", [lock]);
      expect(await adoption).toEqual({ kind: "completed" });
      expect(await cleanup).toBe(0);
      const retained = await run(() => webhooks.findByEventIdPrimary(eventId));
      expect(retained?.delivery_legacy_retained).toBe(true);
      expect(retained?.delivery_completed_at).not.toBeNull();
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [lock]);
      await adoption?.catch(() => undefined);
      await cleanup?.catch(() => undefined);
      await holder.query("DROP TRIGGER IF EXISTS pause_legacy_retention ON webhook_events");
      await holder.query("DROP FUNCTION IF EXISTS pause_legacy_retention()");
      await oldCleaner.end();
      await holder.end();
      await observer.end();
    }
  }, 15_000);
}

test("PostgreSQL concurrent reservations fence stale progress completion", async () => {
  const hashes = Array.from({ length: 40 }, (_, i) => digest(`concurrent-${i}`)).sort();
  const source = "postgres:concurrent-cursor";
  const reservations = await Promise.all(
    Array.from({ length: 12 }, () =>
      run(() => repository.selectLegacyStripeAdoptionDigests(source, hashes)),
    ),
  );
  const ordered = reservations
    .filter((value) => value !== null)
    .sort((a, b) => Number(a.revision - b.revision));
  expect(ordered).toHaveLength(12);
  expect(new Set(ordered.map((value) => value.digests[0])).size).toBe(12);
  expect(ordered.map((value) => value.revision)).toEqual(
    Array.from({ length: 12 }, (_, i) => BigInt(i + 1)),
  );
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  expect(
    await run(() =>
      repository.finishLegacyStripeAdoptionSelection(source, first.revision, first.digests.at(-1)!),
    ),
  ).toBe(false);
  expect(
    await run(() =>
      repository.finishLegacyStripeAdoptionSelection(source, last.revision, last.digests.at(-1)!),
    ),
  ).toBe(true);
  const observer = await connected();
  try {
    const row = (
      await observer.query<{ cursor_digest: string; revision: string }>(
        "SELECT cursor_digest,revision FROM stripe_legacy_adoption_cursors WHERE source_key=$1",
        [source],
      )
    ).rows[0]!;
    expect(row.cursor_digest).toBe(last.digests.at(-1)!);
    expect(row.revision).toBe("13");
  } finally {
    await observer.end();
  }
}, 15_000);

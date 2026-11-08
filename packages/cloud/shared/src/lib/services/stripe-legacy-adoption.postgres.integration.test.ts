/** Real PostgreSQL row-lock evidence for the Stripe legacy selection hint. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";

let admin: Client | undefined;
let connectionString = "";
const databaseName = `qa_stripe_legacy_${randomUUID().replaceAll("-", "")}`;
let repository: typeof import("../../db/repositories/stripe-legacy-adoption-cursors");
let database: typeof import("../../db/client");
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
      await readFile(
        new URL("../../db/migrations/0564_stripe_legacy_adoption_cursors.sql", import.meta.url),
        "utf8",
      ),
    );
  } finally {
    await setup.end();
  }
  database = await import("../../db/client");
  repository = await import("../../db/repositories/stripe-legacy-adoption-cursors");
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

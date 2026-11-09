/** Actual SQL adoption with the production KV and Redis adapters; all Redis is isolated loopback. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createClient } from "redis";
import type Stripe from "stripe";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { KvCacheAdapter, type KvNamespaceLike } from "../cache/adapters/kv-cache-adapter";
import { NodeRedisAdapter } from "../cache/adapters/node-redis-adapter";
import type { CacheRedisClient } from "../cache/adapters/types";
import { logger } from "../utils/logger";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.CACHE_ENABLED = "true";
process.env.CACHE_BACKEND = "memory";
process.env.ENVIRONMENT = "legacy-adoption-test";

let database: typeof import("../../db/client");
let repo: typeof import("../../db/repositories/webhook-events")["webhookEventsRepository"];
let cursors: typeof import("../../db/repositories/stripe-legacy-adoption-cursors");
let outbox: typeof import("./stripe-delivery-outbox");
let cache: typeof import("../cache/client")["cache"];
let redis: ChildProcess;
let redisClient: ReturnType<typeof createClient>;
const spies: Array<{ mockRestore(): void }> = [];
const prefix = "legacy-adoption-test:";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
class LocalKv implements KvNamespaceLike {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async list() {
    return { keys: [...this.values.keys()].map((name) => ({ name })), list_complete: true };
  }
}
let kv = new LocalKv();
let adapter: CacheRedisClient;
let backend: "kv" | "redis" = "kv";

beforeAll(async () => {
  database = await import("../../db/client");
  const db = database.getPgliteClientForTests();
  await db.exec(
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
      if (statement.trim()) await db.exec(statement);
  }
  repo = (await import("../../db/repositories/webhook-events")).webhookEventsRepository;
  cursors = await import("../../db/repositories/stripe-legacy-adoption-cursors");
  outbox = await import("./stripe-delivery-outbox");
  ({ cache } = await import("../cache/client"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback Redis port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  redis = spawn(
    process.env.STRIPE_LEGACY_TEST_REDIS_BINARY ?? "redis-server",
    ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Loopback Redis startup timed out")), 10_000);
    redis.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    redis.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Loopback Redis exited: ${code}`));
    });
    redis.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("Ready to accept connections")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  redisClient = createClient({
    url: `redis://127.0.0.1:${port}`,
    socket: { reconnectStrategy: false },
  });
  redisClient.on("error", () => {});
  await redisClient.connect();
}, 120_000);

beforeEach(async () => {
  await database
    .getPgliteClientForTests()
    .exec("TRUNCATE webhook_events,stripe_legacy_adoption_cursors");
  kv = new LocalKv();
  await redisClient.flushDb();
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(async () => {
  if (redisClient?.isOpen) await redisClient.quit();
  if (redis && redis.exitCode === null && redis.signalCode === null) {
    const exited = new Promise<void>((resolve) => redis.once("exit", () => resolve()));
    redis.kill("SIGTERM");
    await exited;
  }
  await database.closeDatabaseConnectionsForTests();
});

function useBackend(value: "kv" | "redis") {
  backend = value;
  adapter = value === "kv" ? new KvCacheAdapter(kv) : new NodeRedisAdapter(redisClient);
  spies.push(
    spyOn(cache, "getBackendKind").mockImplementation(() =>
      value === "kv" ? "cloudflare_kv" : "redis_native",
    ),
  );
  spies.push(
    spyOn(cache, "listQueue").mockImplementation((key) => adapter.lrange(prefix + key, 0, -1)),
  );
  spies.push(
    spyOn(cache, "removeQueueValue").mockImplementation((key, raw) =>
      adapter.lrem(prefix + key, 1, raw),
    ),
  );
}
async function seedRaw(raw: string, key = "stripe-events") {
  if (backend === "kv") {
    const values = await adapter.lrange(prefix + key, 0, -1);
    await kv.put(prefix + key, JSON.stringify([raw, ...values]));
  } else await adapter.lpush(prefix + key, raw);
}
async function seedOriginal(raw: string, key = "stripe-events") {
  let body: StripeEventMessage | undefined;
  try {
    body = JSON.parse(raw).body;
  } catch {}
  if (body?.kind === "stripe.event") await marker(body);
  await seedRaw(raw, key);
}
const remaining = (key = "stripe-events") => adapter.lrange(prefix + key, 0, -1);
function message(id: string): StripeEventMessage {
  return {
    kind: "stripe.event",
    eventId: id,
    eventType: "charge.refunded",
    event: { id, object: "event", type: "charge.refunded" } as Stripe.Event,
    receivedAt: 1,
  };
}
const envelope = (body: StripeEventMessage) => JSON.stringify({ body, attempts: 0, enqueuedAt: 1 });
async function marker(
  body: StripeEventMessage,
  overrides: Partial<Parameters<typeof repo.tryCreate>[0]> = {},
) {
  return repo.tryCreate({
    event_id: body.eventId,
    provider: "stripe",
    event_type: body.eventType,
    payload_hash: digest(JSON.stringify(body.event)),
    ...overrides,
  });
}
async function drain(seen: string[] = []) {
  return outbox.drainStripeDeliveries(async ({ body }) => {
    seen.push(body.eventId);
    return "ack";
  });
}

for (const mode of ["kv", "redis"] as const) {
  test(`${mode}: ${mode === "kv" ? "read-only adoption reaches every legacy queue" : "persistent first-queue removal failure cannot starve later queues"}`, async () => {
    useBackend(mode);
    const keys = ["stripe-events", "stripe-events:processing", "stripe-events:dlq"];
    const bodies = keys.map((_, index) => message(`evt_remove_failure_${index}`));
    for (const [index, key] of keys.entries()) await seedOriginal(envelope(bodies[index]), key);
    let removalCalls = 0;
    spies.push(
      spyOn(cache, "removeQueueValue").mockImplementation(async (key, raw) => {
        removalCalls++;
        if (key === keys[0]) throw new Error("Persistent first-list removal failure");
        return adapter.lrem(prefix + key, 1, raw);
      }),
    );
    const seen: string[] = [];
    await drain(seen);
    expect(seen.sort()).toEqual(bodies.map((body) => body.eventId).sort());
    expect(await remaining(keys[0])).toEqual([envelope(bodies[0])]);
    expect(await remaining(keys[1])).toEqual(mode === "kv" ? [envelope(bodies[1])] : []);
    expect(await remaining(keys[2])).toEqual(mode === "kv" ? [envelope(bodies[2])] : []);
    expect(removalCalls).toBe(mode === "kv" ? 0 : 3);
    for (const body of bodies)
      expect((await repo.findByEventIdPrimary(body.eventId))?.delivery_completed_at).not.toBeNull();
    await drain(seen);
    expect(seen.length).toBe(3);
  });

  test(`${mode}: bounded adoption preserves backlog and same-call delivery`, async () => {
    useBackend(mode);
    const raws = Array.from({ length: 64 }, (_, i) => envelope(message(`evt_backlog_${i}`)));
    for (const raw of raws) await seedOriginal(raw);
    const due = message("evt_already_due");
    await marker(due, { delivery_payload: due });
    const seen: string[] = [];
    const first = await drain(seen);
    expect(first.legacyAdopted).toBeGreaterThan(0);
    expect(first.legacyAdopted).toBeLessThanOrEqual(25);
    expect((await remaining()).length).toBe(mode === "kv" ? 64 : 64 - first.legacyAdopted);
    expect(seen).toContain(due.eventId);
    expect(seen.some((id) => id.startsWith("evt_backlog_"))).toBe(true);
    for (let turn = 0; turn < 5 && (await remaining()).length; turn++) await drain(seen);
    expect((await remaining()).sort()).toEqual(mode === "kv" ? raws.sort() : []);
    for (let turn = 0; turn < 4; turn++) await drain(seen);
    expect(new Set(seen).size).toBe(65);
    expect(seen.length).toBe(65);
  }, 30_000);

  test(`${mode}: foreign marker cannot discard original Stripe work`, async () => {
    useBackend(mode);
    const body = message("evt_collision");
    const raw = envelope(body);
    await marker(body, { provider: "oxapay" });
    await seedOriginal(raw);
    const seen: string[] = [];
    const stats = await drain(seen);
    expect(stats.legacyAdopted).toBe(0);
    expect(seen).toEqual([]);
    expect(await remaining()).toEqual([raw]);
    expect((await repo.findByEventIdPrimary(body.eventId))?.provider).toBe("oxapay");
  });

  test(`${mode}: mismatched retained payload remains unchanged`, async () => {
    useBackend(mode);
    const body = message("evt_mismatch");
    const raw = envelope(body);
    const original = { ...body, receivedAt: 2 };
    await marker(body, {
      delivery_payload: original,
      delivery_next_attempt_at: new Date(Date.now() + 60_000),
    });
    await seedOriginal(raw);
    await drain();
    expect(await remaining()).toEqual([raw]);
    expect((await repo.findByEventIdPrimary(body.eventId))?.delivery_payload).toEqual(original);
  });

  test(`${mode}: unknown terminal digest cannot fabricate a matching receipt`, async () => {
    useBackend(mode);
    const body = message("evt_terminal_unknown");
    const raw = envelope(body);
    await marker(body, { payload_hash: "f".repeat(64), delivery_completed_at: new Date() });
    await seedOriginal(raw);
    const seen: string[] = [];
    await drain(seen);
    expect(await remaining()).toEqual([raw]);
    expect(seen).toEqual([]);
    expect((await repo.findByEventIdPrimary(body.eventId))?.delivery_payload).toBeNull();
  });

  test(`${mode}: malformed prefix cannot starve valid work or leak raw data`, async () => {
    useBackend(mode);
    const secret = "retained-private-payload-marker";
    const malformed = Array.from({ length: 31 }, (_, i) => `${secret}-${i}`);
    for (const raw of malformed) await seedOriginal(raw);
    const good = message("evt_after_poison");
    await seedOriginal(envelope(good));
    const logged: unknown[] = [];
    spies.push(
      spyOn(logger, "error").mockImplementation((...args) => {
        logged.push(args);
      }),
    );
    const seen: string[] = [];
    for (let turn = 0; turn < 4; turn++) await drain(seen);
    expect(seen).toEqual([good.eventId]);
    expect((await remaining()).sort()).toEqual(
      (mode === "kv" ? [...malformed, envelope(good)] : malformed).sort(),
    );
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  test(`${mode}: committed SQL with lost reply retains and safely replays raw`, async () => {
    useBackend(mode);
    const body = message("evt_sql_unknown");
    const raw = envelope(body);
    await seedOriginal(raw);
    const original = repo.adoptLegacyStripeDelivery.bind(repo);
    let lost = true;
    spies.push(
      spyOn(repo, "adoptLegacyStripeDelivery").mockImplementation(async (...args) => {
        const result = await original(...args);
        if (lost) {
          lost = false;
          throw new Error("Lost SQL commit acknowledgement");
        }
        return result;
      }),
    );
    const seen: string[] = [];
    await drain(seen);
    expect(await remaining()).toEqual([raw]);
    expect((await repo.findByEventIdPrimary(body.eventId))?.delivery_completed_at).not.toBeNull();
    await drain(seen);
    expect(await remaining()).toEqual(mode === "kv" ? [raw] : []);
    expect(seen).toEqual([body.eventId]);
  });

  test(`${mode}: ${mode === "kv" ? "adoption never attempts destructive removal without a writer fence" : "lost remove acknowledgement cannot duplicate completed delivery"}`, async () => {
    useBackend(mode);
    const body = message("evt_remove_unknown");
    await seedOriginal(envelope(body));
    let removalCalls = 0;
    spies.push(
      spyOn(cache, "removeQueueValue").mockImplementation(async (key, raw) => {
        removalCalls++;
        await adapter.lrem(prefix + key, 1, raw);
        return null;
      }),
    );
    const seen: string[] = [];
    await drain(seen);
    await drain(seen);
    expect(await remaining()).toEqual(mode === "kv" ? [envelope(body)] : []);
    expect(removalCalls).toBe(mode === "kv" ? 0 : 1);
    expect(seen).toEqual([body.eventId]);
  });

  test(`${mode}: identical retained copies share one delivery receipt`, async () => {
    useBackend(mode);
    const body = message("evt_identical_copy");
    const raw = envelope(body);
    await seedOriginal(raw);
    await seedOriginal(raw);
    const seen: string[] = [];
    await drain(seen);
    expect(await remaining()).toEqual(mode === "kv" ? [raw, raw] : [raw]);
    await drain(seen);
    expect(await remaining()).toEqual(mode === "kv" ? [raw, raw] : []);
    expect(seen).toEqual([body.eventId]);
  });

  test(`${mode}: cursor acknowledgement loss does not acknowledge work`, async () => {
    useBackend(mode);
    const body = message("evt_cursor_unknown");
    const raw = envelope(body);
    await seedOriginal(raw);
    const original = cursors.selectLegacyStripeAdoptionDigests;
    let lost = true;
    spies.push(
      spyOn(cursors, "selectLegacyStripeAdoptionDigests").mockImplementation(async (...args) => {
        const result = await original(...args);
        if (lost) {
          lost = false;
          throw new Error("Lost cursor commit acknowledgement");
        }
        return result;
      }),
    );
    const first = await drain();
    expect(first.legacyAdopted).toBe(0);
    expect(await remaining()).toEqual([raw]);
    expect((await repo.findByEventIdPrimary(body.eventId))?.delivery_payload).toBeNull();
    const seen: string[] = [];
    await drain(seen);
    expect(await remaining()).toEqual(mode === "kv" ? [raw] : []);
    expect(seen).toEqual([body.eventId]);
  });

  test(`${mode}: concurrent adopters retain one durable delivery per original`, async () => {
    useBackend(mode);
    const raws = Array.from({ length: 40 }, (_, i) => envelope(message(`evt_race_${i}`)));
    for (const raw of raws) await seedOriginal(raw);
    const seen: string[] = [];
    await Promise.all([drain(seen), drain(seen)]);
    for (let turn = 0; turn < 5; turn++) await drain(seen);
    expect((await remaining()).sort()).toEqual(mode === "kv" ? raws.sort() : []);
    expect(new Set(seen).size).toBe(40);
    expect(seen.length).toBe(40);
  }, 30_000);

  test(`${mode}: slow first attempt cannot skip unattempted reserved entries`, async () => {
    useBackend(mode);
    const bodies = Array.from({ length: 26 }, (_, i) => message(`evt_budget_${i}`));
    const ordered = bodies
      .map((body) => ({ body, raw: envelope(body) }))
      .sort((a, b) => digest(a.raw).localeCompare(digest(b.raw)));
    for (const { raw } of ordered) await seedOriginal(raw);
    const original = repo.adoptLegacyStripeDelivery.bind(repo);
    let delay = true;
    spies.push(
      spyOn(repo, "adoptLegacyStripeDelivery").mockImplementation(async (...args) => {
        const receipt = await original(...args);
        if (delay) {
          delay = false;
          await new Promise((resolve) => setTimeout(resolve, 1_050));
        }
        return receipt;
      }),
    );
    const seen: string[] = [];
    const first = await drain(seen);
    expect(first.legacyAdopted).toBe(1);
    expect((await remaining()).length).toBe(mode === "kv" ? 26 : 25);
    for (let turn = 0; turn < 3; turn++) await drain(seen);
    expect((await remaining()).sort()).toEqual(
      mode === "kv" ? ordered.map(({ raw }) => raw).sort() : [],
    );
    expect(new Set(seen).size).toBe(26);
  }, 30_000);

  test(`${mode}: lost progress completion reply is not work authority`, async () => {
    useBackend(mode);
    for (let i = 0; i < 3; i++) await seedOriginal(envelope(message(`evt_progress_${i}`)));
    const original = cursors.finishLegacyStripeAdoptionSelection;
    let lost = true;
    spies.push(
      spyOn(cursors, "finishLegacyStripeAdoptionSelection").mockImplementation(async (...args) => {
        const changed = await original(...args);
        if (lost) {
          lost = false;
          throw new Error("Lost progress completion reply");
        }
        return changed;
      }),
    );
    const seen: string[] = [];
    expect((await drain(seen)).legacyAdopted).toBe(3);
    await drain(seen);
    expect((await remaining()).length).toBe(mode === "kv" ? 3 : 0);
    expect(new Set(seen).size).toBe(3);
    expect(seen.length).toBe(3);
  });
}

test("stale completion cannot rewind a newer cursor reservation", async () => {
  const hashes = [digest("a"), digest("b"), digest("c")];
  const first = await cursors.selectLegacyStripeAdoptionDigests("cursor-cas", hashes);
  const second = await cursors.selectLegacyStripeAdoptionDigests("cursor-cas", hashes);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.digests[0]).not.toBe(first!.digests[0]);
  expect(
    await cursors.finishLegacyStripeAdoptionSelection(
      "cursor-cas",
      first!.revision,
      first!.digests.at(-1)!,
    ),
  ).toBe(false);
  const row = await database
    .getPgliteClientForTests()
    .query<{ cursor_digest: string }>(
      "SELECT cursor_digest FROM stripe_legacy_adoption_cursors WHERE source_key='cursor-cas'",
    );
  expect(row.rows[0]?.cursor_digest).toBe(second!.digests[0]);
});

test("canonical migration loads the bounded adoption hint schema", async () => {
  const { loadCanonicalMigrations } = await import(
    "../../../../scripts/admin/canonical-migration-ledger"
  );
  const matches = (await loadCanonicalMigrations()).filter(
    (m) => m.entry.tag === "0564_stripe_legacy_adoption_cursors",
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]!.statements.join("\n")).toContain("stripe_legacy_adoption_cursors");
  const db = database.getPgliteClientForTests();
  await expect(
    db.query(
      "INSERT INTO stripe_legacy_adoption_cursors(source_key,cursor_digest) VALUES('invalid','not-a-digest')",
    ),
  ).rejects.toThrow();
  await expect(
    db.query(
      "INSERT INTO stripe_legacy_adoption_cursors(source_key,revision) VALUES('invalid',-1)",
    ),
  ).rejects.toThrow();
});

test("KV non-string values remain intact without starving valid raw entries", async () => {
  useBackend("kv");
  const body = message("evt_after_nonstring");
  const privateValue = { secret: "retained-non-string-secret" };
  await marker(body);
  await kv.put(prefix + "stripe-events", JSON.stringify([42, privateValue, envelope(body)]));
  const logged: unknown[] = [];
  spies.push(
    spyOn(logger, "error").mockImplementation((...args) => {
      logged.push(args);
    }),
  );
  const seen: string[] = [];
  await drain(seen);
  expect(seen).toEqual([body.eventId]);
  expect(JSON.parse((await kv.get(prefix + "stripe-events"))!)).toEqual([
    42,
    privateValue,
    envelope(body),
  ]);
  expect(JSON.stringify(logged)).not.toContain(privateValue.secret);
});

test("KV adoption preserves an old-writer append without attempting removal", async () => {
  useBackend("kv");
  const originalBody = message("evt_before_old_writer");
  const appendedBody = message("evt_old_writer_append");
  const originalRaw = envelope(originalBody);
  const appendedRaw = envelope(appendedBody);
  await seedOriginal(originalRaw);
  const originalAdopt = repo.adoptLegacyStripeDelivery.bind(repo);
  let appended = false;
  spies.push(
    spyOn(repo, "adoptLegacyStripeDelivery").mockImplementation(async (...args) => {
      const result = await originalAdopt(...args);
      if (!appended) {
        appended = true;
        await seedOriginal(appendedRaw);
      }
      return result;
    }),
  );
  const remove = spyOn(cache, "removeQueueValue");
  spies.push(remove);
  const seen: string[] = [];
  await drain(seen);
  expect(seen).toEqual([originalBody.eventId]);
  expect(await remaining()).toEqual([appendedRaw, originalRaw]);
  expect(remove).not.toHaveBeenCalled();
  await drain(seen);
  expect(seen).toEqual([originalBody.eventId, appendedBody.eventId]);
  expect(await remaining()).toEqual([appendedRaw, originalRaw]);
  expect(remove).not.toHaveBeenCalled();
});

for (const mode of ["kv", "redis"] as const) {
  test(`${mode}: a missing historical receipt quarantines the original raw`, async () => {
    useBackend(mode);
    const body = message("evt_missing_receipt");
    const raw = envelope(body);
    await seedRaw(raw);
    const logged: unknown[] = [];
    spies.push(
      spyOn(logger, "error").mockImplementation((...args) => {
        logged.push(args);
      }),
    );
    const seen: string[] = [];
    expect((await drain(seen)).legacyAdopted).toBe(0);
    expect(await remaining()).toEqual([raw]);
    expect(seen).toEqual([]);
    expect(await repo.findByEventIdPrimary(body.eventId)).toBeUndefined();
    expect(JSON.stringify(logged)).toContain("missing_receipt");
    expect(JSON.stringify(logged)).not.toContain(raw);
  });
}

test("matching marker, pending and completed receipts retain their original row identity", async () => {
  for (const state of ["marker", "pending", "completed"]) {
    const body = message(`evt_original_${state}`);
    await marker(
      body,
      state === "pending"
        ? { delivery_payload: body }
        : state === "completed"
          ? { delivery_completed_at: new Date() }
          : {},
    );
    const before = await repo.findByEventIdPrimary(body.eventId);
    expect(before?.delivery_legacy_retained).toBe(false);
    const result = await repo.adoptLegacyStripeDelivery(body, digest(JSON.stringify(body.event)));
    expect(result.kind).toBe(
      state === "marker" ? "adopted" : state === "pending" ? "already_adopted" : "completed",
    );
    const after = await repo.findByEventIdPrimary(body.eventId);
    expect(after?.id).toBe(before?.id);
    expect(after?.delivery_legacy_retained).toBe(true);
  }
});

for (const provider of [false, true]) {
  test(`retained KV receipt survives ${provider ? "provider" : "global"} cleanup without redelivery`, async () => {
    useBackend("kv");
    const body = message("evt_retained_receipt");
    await marker(body);
    await seedOriginal(envelope(body));
    const seen: string[] = [];
    await drain(seen);
    await database
      .getPgliteClientForTests()
      .query("UPDATE webhook_events SET processed_at=now()-interval '60 days' WHERE event_id=$1", [
        body.eventId,
      ]);
    const removed = provider
      ? await repo.cleanupOldEventsForProvider("stripe", 30)
      : await repo.cleanupOldEvents(30);
    await drain(seen);
    expect({ removed, seen }).toEqual({ removed: 0, seen: [body.eventId] });
    expect(await remaining()).toEqual([envelope(body)]);
  });
}

test("old unfiltered deletes preserve retained receipts and still return ordinary rows", async () => {
  const retained = message("evt_retained_old_delete");
  const ordinary = message("evt_ordinary_old_delete");
  await marker(retained, { delivery_completed_at: new Date() });
  await marker(ordinary, { delivery_completed_at: new Date() });
  await repo.adoptLegacyStripeDelivery(retained, digest(JSON.stringify(retained.event)));
  const deleted = await database
    .getPgliteClientForTests()
    .query<{ event_id: string }>("DELETE FROM webhook_events RETURNING event_id");
  expect(deleted.rows).toEqual([{ event_id: ordinary.eventId }]);
  await repo.deleteByEventId(retained.eventId, "stripe");
  expect((await repo.findByEventIdPrimary(retained.eventId))?.delivery_legacy_retained).toBe(true);
});

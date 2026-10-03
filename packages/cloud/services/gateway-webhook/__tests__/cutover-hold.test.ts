/**
 * Drives the real gateway webhook handler and hold drainer over HTTP into a
 * local Cloud route during a Shared→Dedicated cutover (#22934). A Blooio turn
 * acknowledged to the provider while Cloud holds the conversation is parked
 * durably, never dropped, never run twice, and delivered exactly once after
 * the Dedicated route is attested. Only the Blooio provider API is substituted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { blooioAdapter } from "../src/adapters/blooio";
import {
  CONNECTOR_HELD,
  CUTOVER_HOLD_MAX_MS,
  drainCutoverHolds,
  type HeldWebhook,
  holdWebhookForCutover,
} from "../src/cutover-hold";
import { createRedis, type GatewayRedis } from "../src/redis";
import {
  handleWebhook,
  redeliverHeldWebhook,
  releaseExpiredHeldWebhook,
} from "../src/webhook-handler";

const WEBHOOK_SECRET = "blooio-cutover-secret";
const envKeys = [
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_WEBHOOK_PROJECT",
  "MOCK_REDIS",
] as const;
const savedEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let providerSends: Array<Record<string, unknown>>;

beforeEach(() => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  process.env.ELIZA_APP_WEBHOOK_PROJECT = "eliza-app";
  process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-test-key";
  process.env.ELIZA_APP_BLOOIO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15559990000";
  process.env.MOCK_REDIS = "1";
  providerSends = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.blooio.com/")) {
      if (url === "https://api.blooio.com/v4/messages") {
        providerSends.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ id: `msg_provider_${providerSends.length}` });
      }
      return Response.json({ ok: true });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Local Cloud route: holds the turn while `attested` is false. An attested
 * turn can be slowed with `replyDelayMs`; `onAttestedTurn` runs when Cloud
 * starts executing it, before the reply returns. `refusedStatus` makes Cloud
 * reject the turn outright with that status.
 */
function startCloud() {
  const state: {
    attested: boolean;
    unavailable: boolean;
    refusedStatus: number | null;
    replyDelayMs: number;
    onAttestedTurn?: () => Promise<void>;
  } = {
    attested: false,
    unavailable: false,
    refusedStatus: null,
    replyDelayMs: 0,
  };
  const turns: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/internal/eliza-app/personal-shared/messages") {
        return new Response("not found", { status: 404 });
      }
      turns.push((await request.json()) as Record<string, unknown>);
      if (state.unavailable)
        return new Response("temporarily unavailable", { status: 503 });
      if (state.refusedStatus !== null) {
        return Response.json(
          { success: false, code: "invalid_request", error: "bad request" },
          { status: state.refusedStatus },
        );
      }
      if (!state.attested) {
        return Response.json(
          {
            success: false,
            code: "personal_cutover_in_progress",
            error: "Dedicated cutover is finishing; retry this turn shortly.",
            retryable: true,
          },
          { status: 503, headers: { "Retry-After": "1" } },
        );
      }
      await state.onAttestedTurn?.();
      if (state.replyDelayMs > 0) await Bun.sleep(state.replyDelayMs);
      return Response.json({
        success: true,
        data: {
          reply: "Hi from Dedicated.",
          identity: { runtime: "dedicated" },
        },
      });
    },
  });
  servers.push(server);
  return { origin: server.url.origin, turns, state };
}

function deps(cloudBaseUrl: string, redis: GatewayRedis) {
  return {
    redis,
    cloudBaseUrl,
    getAuthHeader: () => ({ Authorization: "Bearer gateway-test" }),
    reacquireAuthHeader: async () => ({ Authorization: "Bearer gateway-test" }),
  };
}

function blooioWebhook(messageId: string): Request {
  const body = JSON.stringify({
    id: `evt_${messageId}`,
    type: "message.received",
    created_at: Date.now(),
    data: {
      message_id: messageId,
      sender: "+15551234567",
      recipient: "+15550001111",
      text: "remind me to call mom",
      protocol: "imessage",
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return new Request("http://gateway.test/webhook/eliza-app/blooio", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-blooio-signature": `t=${timestamp},v1=${signature}`,
    },
    body,
  });
}

async function waitForLedger(
  redis: GatewayRedis,
  dedupKey: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await redis.get<string>(dedupKey)) === expected) return;
    await Bun.sleep(50);
  }
  throw new Error(`ledger ${dedupKey} never reached ${expected}`);
}

function drainHandlers(cloudOrigin: string, redis: GatewayRedis) {
  return {
    redeliver: (held: Parameters<typeof redeliverHeldWebhook>[0]) =>
      redeliverHeldWebhook(held, blooioAdapter, deps(cloudOrigin, redis)),
    release: (held: Parameters<typeof releaseExpiredHeldWebhook>[0]) =>
      releaseExpiredHeldWebhook(held, redis),
  };
}

describe("connector ingress during Shared→Dedicated cutover", () => {
  test("holds an acknowledged turn durably and delivers it once after Dedicated is attested", async () => {
    const cloud = startCloud();
    const redis = createRedis();
    const dedupKey = "webhook:blooio:msg_cutover_1";

    const response = await handleWebhook(
      blooioWebhook("msg_cutover_1"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    expect(response.status).toBe(200);
    await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
    // A gateway outage longer than the retry budget must still leave the
    // payload available for the explicit expiry/failure handler.
    expect(
      await redis.eval(
        "return redis.call('TTL', KEYS[1])",
        [`webhook:cutover-hold:${dedupKey}`],
        [],
      ),
    ).toBe(-1);
    const heldTurns = cloud.turns.length;
    expect(heldTurns).toBeGreaterThan(0);
    expect(providerSends).toEqual([]);

    // A provider redelivery during the hold is acknowledged without a turn.
    const replay = await handleWebhook(
      blooioWebhook("msg_cutover_1"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    expect(replay.status).toBe(200);
    expect(cloud.turns).toHaveLength(heldTurns);

    // Still sealed: the drainer keeps the hold instead of dropping it.
    const sealed = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 60_000 },
    );
    expect(sealed).toMatchObject({ rescheduled: 1, delivered: 0 });
    expect(await redis.get(dedupKey)).toBe(CONNECTOR_HELD);
    expect(providerSends).toEqual([]);

    // A transport outage while held must retain the acknowledged event.
    cloud.state.unavailable = true;
    const unavailable = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 90_000 },
    );
    expect(unavailable).toMatchObject({ rescheduled: 1, released: 0 });
    expect(await redis.get(dedupKey)).toBe(CONNECTOR_HELD);
    expect(providerSends).toEqual([]);
    cloud.state.unavailable = false;

    // Dedicated is attested: exactly one delivery, from the receiving line.
    cloud.state.attested = true;
    const attested = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 120_000 },
    );
    expect(attested).toMatchObject({ delivered: 1, rescheduled: 0 });
    expect(await redis.get(dedupKey)).toBe("delivered");
    expect(providerSends).toHaveLength(1);
    expect(providerSends[0]).toMatchObject({
      text: "Hi from Dedicated.",
      to: "+15551234567",
      from: "+15550001111",
    });
    // Every attempt carried the same message identity, so Cloud's claim
    // boundary executes the turn at most once.
    expect(new Set(cloud.turns.map((turn) => turn.messageId))).toEqual(
      new Set(["blooio:eliza-app:msg_cutover_1"]),
    );

    const idle = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 180_000 },
    );
    expect(idle).toEqual({
      delivered: 0,
      rescheduled: 0,
      released: 0,
      expired: 0,
      stale: 0,
    });
    expect(providerSends).toHaveLength(1);
  }, 60_000);

  test.each(["held", "delivered"] as const)(
    "an expired drainer cannot mutate a replacement lease (%s)",
    async (kind) => {
      const cloud = startCloud();
      const redis = createRedis();
      const messageId = `msg_lease_${kind}`;
      const dedupKey = `webhook:blooio:${messageId}`;
      await handleWebhook(
        blooioWebhook(messageId),
        blooioAdapter,
        deps(cloud.origin, redis),
        "eliza-app",
      );
      await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
      const recordKey = `webhook:cutover-hold:${dedupKey}`;
      const leaseKey = `webhook:cutover-hold-lease:${dedupKey}`;
      const original = await redis.get(recordKey);
      const stats = await drainCutoverHolds(
        redis,
        {
          redeliver: async () => {
            // The old lease expires while its callback is running; another
            // gateway now owns this event.
            await redis.set(leaseKey, "replacement-owner", { ex: 180 });
            return kind === "held"
              ? {
                  kind,
                  signal: {
                    code: "personal_cutover_in_progress",
                    retryAfterSeconds: 1,
                  },
                }
              : { kind };
          },
          release: async () => {
            throw new Error("unexpected expiry");
          },
        },
        { now: Date.now() + 60_000 },
      );
      expect(stats).toMatchObject({ delivered: 0, rescheduled: 0 });
      expect(await redis.get(leaseKey)).toBe("replacement-owner");
      expect(await redis.get(recordKey)).toEqual(original);
      expect(await redis.get(dedupKey)).toBe(CONNECTOR_HELD);
    },
    60_000,
  );

  test("a hold that outlives the cutover budget is released visibly, not silently kept", async () => {
    const cloud = startCloud();
    const redis = createRedis();
    const dedupKey = "webhook:blooio:msg_cutover_2";

    await handleWebhook(
      blooioWebhook("msg_cutover_2"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    await waitForLedger(redis, dedupKey, CONNECTOR_HELD);

    const expired = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + CUTOVER_HOLD_MAX_MS + 60_000 },
    );
    expect(expired).toMatchObject({ expired: 1, delivered: 0 });
    // Released to the ordinary pre-egress handling: the ledger reopens.
    expect(await redis.get(dedupKey)).toBeNull();
    expect(providerSends).toEqual([]);
  }, 60_000);

  test("a redelivery that outlives one lease period is not run again by another replica", async () => {
    const cloud = startCloud();
    const redis = createRedis();
    const dedupKey = "webhook:blooio:msg_cutover_3";

    await handleWebhook(
      blooioWebhook("msg_cutover_3"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
    const heldTurns = cloud.turns.length;

    // A Personal Shared turn may run far longer than one lease period
    // (PERSONAL_SHARED_TURN_TIMEOUT_MS per attempt). Shorten the lease so the
    // attested turn outlives it, then let a second replica drain meanwhile.
    cloud.state.attested = true;
    cloud.state.replyDelayMs = 2_500;
    const leaseSeconds = 1;
    const now = Date.now() + 60_000;
    const first = drainCutoverHolds(redis, drainHandlers(cloud.origin, redis), {
      now,
      leaseSeconds,
    });
    await Bun.sleep(1_500);
    const second = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now, leaseSeconds },
    );

    expect(second).toEqual({
      delivered: 0,
      rescheduled: 0,
      released: 0,
      expired: 0,
      stale: 0,
    });
    expect(await first).toMatchObject({ delivered: 1 });
    expect(cloud.turns.length - heldTurns).toBe(1);
    expect(providerSends).toHaveLength(1);
    expect(await redis.get(dedupKey)).toBe("delivered");
  }, 60_000);

  test("a drainer releases only its own lease", async () => {
    const cloud = startCloud();
    const redis = createRedis();
    const dedupKey = "webhook:blooio:msg_cutover_4";
    const leaseKey = `webhook:cutover-hold-lease:${dedupKey}`;

    await handleWebhook(
      blooioWebhook("msg_cutover_4"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    await waitForLedger(redis, dedupKey, CONNECTOR_HELD);

    // While this drainer's redelivery runs, its lease is lost and another
    // replica takes it. Finishing must not delete that replica's lease.
    cloud.state.attested = true;
    cloud.state.onAttestedTurn = async () => {
      await redis.set(leaseKey, "other-replica-lease", { ex: 60 });
    };
    const stats = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 60_000 },
    );

    expect(stats).toMatchObject({ delivered: 0 });
    expect(await redis.get(leaseKey)).toBe("other-replica-lease");
    expect(await redis.get(`webhook:cutover-hold:${dedupKey}`)).not.toBeNull();
  }, 60_000);

  test("a delivered hold whose lease lapsed with no new owner is not replayed", async () => {
    const cloud = startCloud();
    const redis = createRedis();
    const dedupKey = "webhook:blooio:msg_cutover_6";
    const recordKey = `webhook:cutover-hold:${dedupKey}`;
    const leaseKey = `webhook:cutover-hold-lease:${dedupKey}`;

    await handleWebhook(
      blooioWebhook("msg_cutover_6"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
    const heldTurns = cloud.turns.length;

    // Renewal failed for a whole lease period, so the lease expired while the
    // turn ran and no other replica took it. The turn is still delivered.
    cloud.state.attested = true;
    cloud.state.onAttestedTurn = async () => {
      await redis.del(leaseKey);
    };
    const first = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 60_000 },
    );
    const recordAfterFirst = await redis.get(recordKey);
    cloud.state.onAttestedTurn = undefined;
    const second = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 120_000 },
    );

    expect(cloud.turns.length - heldTurns).toBe(1);
    expect(providerSends).toHaveLength(1);
    expect(first).toEqual({
      delivered: 1,
      rescheduled: 0,
      released: 0,
      expired: 0,
      stale: 0,
    });
    expect(recordAfterFirst).toBeNull();
    expect(second).toEqual({
      delivered: 0,
      rescheduled: 0,
      released: 0,
      expired: 0,
      stale: 0,
    });
    expect(await redis.get(dedupKey)).toBe("delivered");
  }, 60_000);

  test("a hold settled while another replica owned the lease is not redelivered once that lease lapses", async () => {
    const cloud = startCloud();
    const redis = createRedis();
    const dedupKey = "webhook:blooio:msg_cutover_8";
    const recordKey = `webhook:cutover-hold:${dedupKey}`;
    const leaseKey = `webhook:cutover-hold-lease:${dedupKey}`;

    await handleWebhook(
      blooioWebhook("msg_cutover_8"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
    const heldTurns = cloud.turns.length;

    // Renewal lapsed mid-turn and another replica took the lease, then died
    // without draining. This drainer still delivers the turn but must leave
    // the record to the lease owner.
    cloud.state.attested = true;
    cloud.state.onAttestedTurn = async () => {
      await redis.set(leaseKey, "another-replica", { ex: 180 });
    };
    const first = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 60_000 },
    );
    cloud.state.onAttestedTurn = undefined;
    const recordAfterFirst = await redis.get(recordKey);

    // The dead replica's lease lapses. The next drainer finds a settled
    // ledger and must drop the record instead of running the turn again.
    await redis.del(leaseKey);
    const second = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 120_000 },
    );

    expect(recordAfterFirst).not.toBeNull();
    expect(first).toEqual({
      delivered: 0,
      rescheduled: 0,
      released: 0,
      expired: 0,
      stale: 0,
    });
    expect(second).toEqual({
      delivered: 0,
      rescheduled: 0,
      released: 0,
      expired: 0,
      stale: 1,
    });
    expect(cloud.turns.length - heldTurns).toBe(1);
    expect(providerSends).toHaveLength(1);
    expect(await redis.get(recordKey)).toBeNull();
    expect(await redis.get(dedupKey)).toBe("delivered");
  }, 60_000);

  test("a held turn Cloud refuses as not retryable is released at once, not replayed for the hold budget", async () => {
    const cloud = startCloud();
    const redis = createRedis();
    const dedupKey = "webhook:blooio:msg_cutover_7";

    await handleWebhook(
      blooioWebhook("msg_cutover_7"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
    const heldTurns = cloud.turns.length;

    // Cloud now rejects the turn itself; a 400 is classified retryable: false.
    cloud.state.refusedStatus = 400;
    const refused = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + 60_000 },
    );
    const ledgerAfterRefusal = await redis.get(dedupKey);
    const recordAfterRefusal = await redis.get(
      `webhook:cutover-hold:${dedupKey}`,
    );
    const afterBudget = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      { now: Date.now() + CUTOVER_HOLD_MAX_MS + 120_000 },
    );

    expect(refused).toEqual({
      delivered: 0,
      rescheduled: 0,
      released: 1,
      expired: 0,
      stale: 0,
    });
    // Settled like a first-delivery pre-egress failure: the ledger reopens.
    expect(ledgerAfterRefusal).toBeNull();
    expect(recordAfterRefusal).toBeNull();
    expect(afterBudget).toEqual({
      delivered: 0,
      rescheduled: 0,
      released: 0,
      expired: 0,
      stale: 0,
    });
    expect(cloud.turns.length - heldTurns).toBe(1);
    expect(providerSends).toEqual([]);
  }, 60_000);

  test("stale cleanup preserves a webhook re-held after the ledger read", async () => {
    const cloud = startCloud();
    const redis = createRedis();
    const dedupKey = "webhook:blooio:msg_cutover_reheld";
    const recordKey = `webhook:cutover-hold:${dedupKey}`;
    await handleWebhook(
      blooioWebhook("msg_cutover_reheld"),
      blooioAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
    const held = await redis.get<HeldWebhook>(recordKey);
    if (!held) throw new Error("Expected the initial durable hold");
    // A prior drainer released the ledger but left its fenced record behind.
    await redis.del(dedupKey);
    const originalGet = redis.get.bind(redis);
    let reheld = false;
    redis.get = async <T = unknown>(key: string): Promise<T | null> => {
      const value = await originalGet<T>(key);
      if (key === dedupKey && !reheld) {
        reheld = true;
        // The provider retry parks a new hold before stale cleanup executes.
        await holdWebhookForCutover(
          redis,
          { ...held, traceId: "replacement-hold" },
          { code: held.code, retryAfterSeconds: null },
        );
      }
      return value;
    };
    const first = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      {
        now: Date.now() + 60_000,
      },
    );
    expect(reheld).toBe(true);
    expect(first.stale).toBe(0);
    expect(await redis.get(dedupKey)).toBe(CONNECTOR_HELD);
    expect(await redis.get<HeldWebhook>(recordKey)).toMatchObject({
      traceId: "replacement-hold",
    });
    cloud.state.attested = true;
    const second = await drainCutoverHolds(
      redis,
      drainHandlers(cloud.origin, redis),
      {
        now: Date.now() + 120_000,
      },
    );
    expect(second.delivered).toBe(1);
    expect(providerSends).toHaveLength(1);
    expect(await redis.get(recordKey)).toBeNull();
    expect(await redis.get(dedupKey)).toBe("delivered");
  }, 60_000);

  for (const terminal of ["released", "expired"] as const) {
    test(`terminal cleanup preserves a provider retry held during ${terminal} settlement`, async () => {
      const cloud = startCloud();
      const redis = createRedis();
      const messageId = `terminal_reheld_${terminal}`;
      const dedupKey = `webhook:blooio:${messageId}`;
      const recordKey = `webhook:cutover-hold:${dedupKey}`;
      await handleWebhook(
        blooioWebhook(messageId),
        blooioAdapter,
        deps(cloud.origin, redis),
        "eliza-app",
      );
      await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
      const old = await redis.get<HeldWebhook>(recordKey);
      if (!old) throw new Error("Initial hold required");
      if (terminal === "expired")
        await holdWebhookForCutover(
          redis,
          { ...old, heldAt: Date.now() - CUTOVER_HOLD_MAX_MS - 120_000 },
          { code: old.code, retryAfterSeconds: null },
        );
      cloud.state.refusedStatus = 400;
      const base = drainHandlers(cloud.origin, redis);
      const rehold = async () => {
        cloud.state.refusedStatus = null;
        await handleWebhook(
          blooioWebhook(messageId),
          blooioAdapter,
          deps(cloud.origin, redis),
          "eliza-app",
        );
        await waitForLedger(redis, dedupKey, CONNECTOR_HELD);
      };
      await drainCutoverHolds(
        redis,
        {
          redeliver: async (held) => {
            const outcome = await base.redeliver(held);
            expect(outcome.kind).toBe("released");
            await rehold();
            return outcome;
          },
          release: async (held, reason) => {
            await base.release(held, reason);
            await rehold();
          },
        },
        { now: Date.now() + 60_000 },
      );
      expect(await redis.get(dedupKey)).toBe(CONNECTOR_HELD);
      expect(await redis.get(recordKey)).not.toBeNull();
      cloud.state.attested = true;
      const next = await drainCutoverHolds(redis, base, {
        now: Date.now() + 120_000,
      });
      expect(next.delivered).toBe(1);
      expect(providerSends).toHaveLength(1);
    }, 60_000);
  }

  test("lease release and renewal are atomic compare-and-act on the owner token", async () => {
    const redis = createRedis();
    const leaseKey = "webhook:cutover-hold-lease:webhook:blooio:msg_cutover_5";
    await redis.set(leaseKey, "lease-b", { ex: 60 });

    // A drainer holding lease-a (already lost) cannot extend or delete lease-b.
    expect(await redis.expireIfEquals(leaseKey, "lease-a", 1)).toBe(false);
    expect(await redis.delIfEquals(leaseKey, "lease-a")).toBe(false);
    expect(await redis.get(leaseKey)).toBe("lease-b");

    expect(await redis.expireIfEquals(leaseKey, "lease-b", 120)).toBe(true);
    expect(await redis.delIfEquals(leaseKey, "lease-b")).toBe(true);
    expect(await redis.get(leaseKey)).toBeNull();
  });
});

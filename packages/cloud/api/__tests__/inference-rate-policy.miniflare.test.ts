/**
 * Rate-only policy admission on the real admission gate and policy controller
 * in workerd. The primary is a counting fake that throws while forbidden, so
 * warm decisions are proven to perform no Postgres work, and every fence
 * (pending mutation, epoch, generation, revocation, tenant) is exercised
 * against the actual Durable Object storage and queues.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  createRatePolicyWorker,
  gatePost,
  ratePolicy,
  rateProof,
} from "../test/fixtures/inference-rate-policy-harness";

const CONTROL = "test-control";
let worker: Miniflare;

beforeAll(async () => {
  worker = await createRatePolicyWorker();
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
});

async function primary(
  update: Record<string, unknown> = {},
): Promise<{ dbCalls: number }> {
  return (await gatePost(worker, CONTROL, "/test/primary", update)).body as {
    dbCalls: number;
  };
}

/** Keep counter assertions inside one fixed window. */
async function windowRoom(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 3_000) await Bun.sleep(left + 50);
}

const rate = (org: string, options?: Parameters<typeof rateProof>[1]) =>
  gatePost(worker, org, "/rate-policy/rate", rateProof(org, options));

/** Enroll through the real begin/commit protocol; the fake primary answers the resolve. */
async function commitPolicy(
  org: string,
  policy: ReturnType<typeof ratePolicy>,
): Promise<void> {
  const mutationId = crypto.randomUUID();
  const begun = await gatePost(worker, org, "/policy-mutation/begin", {
    organizationId: org,
    mutationId,
  });
  expect(begun.status).toBe(200);
  await primary({
    policy,
    mutation: {
      organizationId: org,
      mutationId,
      state: "applied",
      fenceToken: begun.body.fenceToken,
      epoch: policy.epoch,
    },
  });
  const committed = await gatePost(worker, org, "/policy-mutation/commit", {
    organizationId: org,
    mutationId,
    fenceToken: begun.body.fenceToken,
  });
  expect(committed.status).toBe(200);
}

describe("warm path", () => {
  test("after one cold hydration, warm decisions perform zero primary calls", async () => {
    await windowRoom();
    const org = crypto.randomUUID();
    await primary({ forbidden: false, policy: ratePolicy(org) });
    const before = (await primary()).dbCalls;
    expect((await rate(org)).status).toBe(200);
    // Cold object: exactly one primary policy load.
    expect((await primary()).dbCalls).toBeGreaterThan(before);

    await primary({ forbidden: true });
    const warm = (await primary()).dbCalls;
    for (let i = 0; i < 5; i++) expect((await rate(org)).status).toBe(200);
    expect((await primary()).dbCalls).toBe(warm);
    await primary({ forbidden: false });
  });

  test("decisions consume the primary path's own rate-limit:v2 windows", async () => {
    await windowRoom();
    const org = crypto.randomUUID();
    await primary({ forbidden: false });
    await commitPolicy(org, ratePolicy(org));
    await primary({ forbidden: true });
    // Plan ceiling 400/min: a 2/min key cap binds.
    expect((await rate(org, { keyCap: 2 })).status).toBe(200);
    expect(
      (await rate(org, { keyCap: 2, endpointType: "embeddings" })).status,
    ).toBe(200);
    expect(
      (await rate(org, { keyCap: 2, endpointType: "strict" })).status,
    ).toBe(429);
    // The primary path's limiter sees the same key window.
    const now = Date.now();
    const direct = await gatePost(
      worker,
      `rate-limit:v2:${org}`,
      "/rate-limit",
      {
        endpointType: "standard",
        windowMs: 60_000,
        maxRequests: 100,
        apiKey: { id: "key", maxRequests: 2 },
        windowStartedAt: Math.floor(now / 60_000) * 60_000,
      },
    );
    expect(direct.status).toBe(429);
    await primary({ forbidden: false });
  });

  test("the plan tier from the Durable Object policy bounds the window", async () => {
    await windowRoom();
    const org = crypto.randomUUID();
    await primary({ forbidden: false });
    await commitPolicy(
      org,
      ratePolicy(org, {
        rateLimits: {
          completionsRpm: 2,
          embeddingsRpm: 100,
          standardRpm: 100,
          strictRpm: 100,
        },
      }),
    );
    await primary({ forbidden: true });
    expect((await rate(org)).status).toBe(200);
    expect((await rate(org)).status).toBe(200);
    expect((await rate(org)).status).toBe(429);
    await primary({ forbidden: false });
  });
});

describe("fences", () => {
  test("a pending mutation refuses without primary I/O, and the committed epoch retires the old key cap", async () => {
    await windowRoom();
    const org = crypto.randomUUID();
    await primary({ forbidden: false });
    await commitPolicy(org, ratePolicy(org));
    expect((await rate(org, { keyCap: 50 })).status).toBe(200);

    // Key cap lowered 50 -> 1: the write holds a permit while it commits.
    const mutationId = crypto.randomUUID();
    const begun = await gatePost(worker, org, "/policy-mutation/begin", {
      organizationId: org,
      mutationId,
    });
    await primary({ forbidden: true });
    expect((await rate(org, { keyCap: 50 })).status).toBe(503);
    expect((await rate(org, { epoch: "2", keyCap: 1 })).status).toBe(503);

    await primary({
      forbidden: false,
      policy: ratePolicy(org, { epoch: "2" }),
      mutation: {
        organizationId: org,
        mutationId,
        state: "applied",
        fenceToken: begun.body.fenceToken,
        epoch: "2",
      },
    });
    await gatePost(worker, org, "/policy-mutation/commit", {
      organizationId: org,
      mutationId,
      fenceToken: begun.body.fenceToken,
    });
    await primary({ forbidden: true });
    // The stale cached proof (old epoch, old cap) is refused, never re-hydrated.
    expect((await rate(org, { keyCap: 50 })).status).toBe(503);
    // The new proof carries the new 1/min cap, already used under the old cap.
    expect((await rate(org, { epoch: "2", keyCap: 1 })).status).toBe(429);
    await primary({ forbidden: false });
  });

  test("a plan change refuses the old generation and enforces the new tier", async () => {
    await windowRoom();
    const org = crypto.randomUUID();
    await primary({ forbidden: false });
    await commitPolicy(org, ratePolicy(org));
    await commitPolicy(
      org,
      ratePolicy(org, {
        epoch: "2",
        policyGeneration: "2",
        rateLimits: {
          completionsRpm: 1,
          embeddingsRpm: 1,
          standardRpm: 1,
          strictRpm: 1,
        },
      }),
    );
    await primary({ forbidden: true });
    expect((await rate(org)).status).toBe(503);
    expect((await rate(org, { epoch: "2" })).status).toBe(503);
    expect((await rate(org, { epoch: "2", generation: "2" })).status).toBe(200);
    expect((await rate(org, { epoch: "2", generation: "2" })).status).toBe(429);
    await primary({ forbidden: false });
  });

  test("an organization disable publishes a prohibition that refuses every proof", async () => {
    const org = crypto.randomUUID();
    await primary({ forbidden: false });
    await commitPolicy(org, ratePolicy(org));
    await commitPolicy(
      org,
      ratePolicy(org, { epoch: "2", rateEnabled: false }),
    );
    await primary({ forbidden: true });
    expect((await rate(org)).status).toBe(503);
    expect((await rate(org, { epoch: "2" })).status).toBe(503);
    await primary({ forbidden: false });
  });

  test("key revocation and organization deactivation refuse immediately", async () => {
    const org = crypto.randomUUID();
    await primary({ forbidden: false });
    await commitPolicy(org, ratePolicy(org));
    await primary({ forbidden: true });
    expect((await rate(org)).status).toBe(200);
    expect(
      (
        await gatePost(worker, org, "/credential/revoke", {
          organizationId: org,
          kind: "api_key",
          credentialId: "key",
        })
      ).status,
    ).toBe(200);
    expect((await rate(org)).status).toBe(403);
    expect((await rate(org, { keyId: "other-key" })).status).toBe(200);
    expect(
      (
        await gatePost(worker, org, "/organization/set-active", {
          organizationId: org,
          active: false,
        })
      ).status,
    ).toBe(200);
    expect((await rate(org, { keyId: "other-key" })).status).toBe(403);
    await primary({ forbidden: false });
  });

  test("expired credentials and cross-tenant proofs are refused", async () => {
    const org = crypto.randomUUID();
    const other = crypto.randomUUID();
    await primary({ forbidden: false });
    await commitPolicy(org, ratePolicy(org));
    await commitPolicy(other, ratePolicy(other, { epoch: "5" }));
    await primary({ forbidden: true });
    expect(
      (await rate(org, { credential: { expiresAt: Date.now() - 1 } })).status,
    ).toBe(403);
    expect(
      (await rate(org, { credential: { organizationId: other } })).status,
    ).toBe(400);
    // Another tenant's epoch is not this tenant's epoch.
    expect((await rate(org, { epoch: "5" })).status).toBe(503);
    // An object owned by one tenant refuses a proof addressed to another.
    const crossed = await gatePost(
      worker,
      org,
      "/rate-policy/rate",
      rateProof(other, { epoch: "5" }),
    );
    expect(crossed.status).toBe(503);
    await primary({ forbidden: false });
  });

  test("a mutation is never blocked by an in-flight counter call, and that call's allow is withdrawn", async () => {
    await windowRoom();
    const org = crypto.randomUUID();
    await primary({ forbidden: false });
    await commitPolicy(org, ratePolicy(org));
    const entered = gatePost(worker, CONTROL, "/test/rate-entered", {});
    await primary({ holdRate: true });
    const inFlight = rate(org);
    await entered;
    const begun = await gatePost(worker, org, "/policy-mutation/begin", {
      organizationId: org,
      mutationId: crypto.randomUUID(),
    });
    expect(begun.status).toBe(200);
    await gatePost(worker, CONTROL, "/test/release-rate", {});
    expect((await inFlight).status).toBe(503);
  });
});

describe("flags", () => {
  test("flag off refuses rate-policy and mutation routes", async () => {
    const disabled = await createRatePolicyWorker({ ratePolicy: false });
    try {
      const org = crypto.randomUUID();
      const proof = rateProof(org);
      expect(
        (await gatePost(disabled, org, "/rate-policy/rate", proof)).status,
      ).toBe(503);
      expect(
        (
          await gatePost(disabled, org, "/policy-mutation/begin", {
            organizationId: org,
            mutationId: "m",
          })
        ).status,
      ).toBe(503);
    } finally {
      await disabled.dispose();
    }
  });

  test("without strong revocation the lane refuses but mutation fences stay served", async () => {
    const weak = await createRatePolicyWorker({ strongRevocation: false });
    try {
      const org = crypto.randomUUID();
      expect(
        (await gatePost(weak, org, "/rate-policy/rate", rateProof(org))).status,
      ).toBe(503);
      expect(
        (
          await gatePost(weak, org, "/policy-mutation/begin", {
            organizationId: org,
            mutationId: "m",
          })
        ).status,
      ).toBe(200);
    } finally {
      await weak.dispose();
    }
  });
});

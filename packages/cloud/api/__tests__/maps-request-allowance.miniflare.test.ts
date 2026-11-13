/** Runs the production Maps allowance against actual SQLite Durable Object transactions. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { rateLimit } from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { mapsProviderFromEnv } from "@elizaos/cloud-shared/lib/services/maps/provider-registry";
import type {
  AppEnv,
  RuntimeDurableObjectNamespace,
  RuntimeRateLimitBinding,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { MapsAdmissionError } from "../src/lib/maps-request-admission";
import {
  createMapsRoute,
  type MapsRouteDependencies,
} from "../src/lib/maps-route";

describe("Maps shared allowance", () => {
  let mf: Miniflare;
  let config: MiniflareOptions;
  let persistence: string;
  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL(
            "../test/fixtures/maps-request-allowance-worker.ts",
            import.meta.url,
          ),
        ),
      ],
      target: "browser",
      format: "esm",
      conditions: ["eliza-source"],
      plugins: [
        {
          name: "explicit-env-only",
          setup(build) {
            build.onLoad({ filter: /cloud-bindings\.ts$/ }, () => ({
              loader: "ts",
              contents: `export function getCloudAwareEnv() { throw new Error("Maps controller must use explicit Worker bindings"); }`,
            }));
          },
        },
      ],
    });
    if (!built.success)
      throw new AggregateError(built.logs, "Maps fixture build failed");
    persistence = await mkdtemp(join(tmpdir(), "maps-durable-test-"));
    config = {
      durableObjectsPersist: persistence,
      modules: true,
      script: await built.outputs[0]!.text(),
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        GATES: { className: "MapsTestGate", useSQLite: true },
        RATE_LIMIT_STATE: { className: "RateLimitState", useSQLite: true },
      },
      ratelimits: {
        GLOBAL_RATE_LIMITER: {
          namespace_id: "maps-route-global",
          simple: { limit: 600, period: 60 },
        },
      },
      bindings: {
        ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES: JSON.stringify({
          selected: true,
          plans: {
            maps_test: { requests: 3, windowSeconds: 3600 },
            tile_route: { requests: 67, windowSeconds: 3600 },
            burst_test: { requests: 100, windowSeconds: 3600 },
            sustained_test: { requests: 100, windowSeconds: 3600 },
            clock_burst: { requests: 100, windowSeconds: 3600 },
            clock_sustained: { requests: 100, windowSeconds: 3600 },
          },
        }),
        ELIZA_CLOUD_PLAN_RATE_LIMITS: JSON.stringify({
          selected: true,
          plans: {
            default: {
              burst: { capacity: 100, refillPerSecond: 1 },
              sustained: { capacity: 100, refillPerSecond: 1 },
            },
            burst_test: {
              burst: { capacity: 1, refillPerSecond: 0.001 },
              sustained: { capacity: 100, refillPerSecond: 1 },
            },
            sustained_test: {
              burst: { capacity: 100, refillPerSecond: 1 },
              sustained: { capacity: 1, refillPerSecond: 0.001 },
            },
            clock_burst: {
              burst: { capacity: 2, refillPerSecond: 1 },
              sustained: { capacity: 10, refillPerSecond: 1 },
            },
            clock_sustained: {
              burst: { capacity: 10, refillPerSecond: 1 },
              sustained: { capacity: 2, refillPerSecond: 1 },
            },
          },
        }),
      },
    };
    mf = new Miniflare(config);
    await mf.ready;
  }, 30_000);
  afterAll(async () => {
    await mf?.dispose();
    if (persistence) await rm(persistence, { recursive: true, force: true });
  });
  async function post(
    path: string,
    body: Record<string, unknown>,
    gate: string,
    now?: number,
  ) {
    return mf.dispatchFetch(`https://maps.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-gate": gate,
        ...(now === undefined ? {} : { "x-test-clock-ms": String(now) }),
      },
      body: JSON.stringify(body),
    });
  }
  function mapsRequest(requestId: string, planKey = "maps_test") {
    return {
      organizationId: "org-miniflare",
      requestId,
      operation: "search",
      credential: {
        kind: "api_key",
        organizationId: "org-miniflare",
        userId: "maps-user",
        credentialId: "maps-key",
      },
      policy: {
        generation: "1",
        planKey,
        subscriptionFunded: true,
        effectiveFrom: "2020-01-01T00:00:00Z",
        effectiveUntil: "2099-01-01T00:00:00Z",
      },
    };
  }
  test("tile routes retain durable admission, outcomes and global ingress through a 65-tile burst", async () => {
    const gate = "maps-tile-route";
    const now = Date.parse("2027-01-01T00:02:00Z");
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    let authenticationCalls = 0;
    let providerCalls = 0;
    let failProvider = false;
    let cancelAfterAdmission: AbortController | undefined;
    const provider = mapsProviderFromEnv(
      {
        ELIZA_MAPS_PROVIDER: "google",
        GOOGLE_MAPS_API_KEY: "maps-provider-fixture-key",
      },
      (async (input: RequestInfo | URL) => {
        if (new URL(String(input)).pathname === "/v1/createSession")
          return Response.json({
            session: "maps-route-session",
            expiry: String(Math.floor(Date.now() / 1000) + 86400),
            tileWidth: 256,
            imageFormat: "png",
          });
        providerCalls++;
        return failProvider
          ? new Response("Controlled provider outage", { status: 503 })
          : new Response(png, { headers: { "content-type": "image/png" } });
      }) as typeof fetch,
    );
    const dependencies: MapsRouteDependencies = {
      // Identity and the locked primary policy are explicit fixtures. The route,
      // limiter, provider adapter and Maps SQLite controller are production code.
      authenticate: async (c) => {
        authenticationCalls++;
        if (c.req.header("x-api-key") !== "maps-route-fixture")
          throw new ApiError(
            401,
            "authentication_required",
            "Fixture credential required",
          );
        return { id: "maps-user", organization_id: "org-miniflare" };
      },
      admitRequest: async (c, caller, operation) => {
        const request = {
          ...mapsRequest(c.req.header("Idempotency-Key") ?? "", "tile_route"),
          organizationId: caller.organization_id,
          operation,
        };
        const response = await post("/maps/admit", request, gate, now);
        if (!response.ok) {
          const result = (await response.json().catch(() => null)) as {
            error?: { code?: string; retryAfterSeconds?: number };
          } | null;
          throw new MapsAdmissionError(
            response.status,
            result?.error?.code ?? "maps_access_denied",
            "Maps controller refused the request",
            { retryAfterSeconds: result?.error?.retryAfterSeconds },
          );
        }
        expect(await response.json()).toMatchObject({ admitted: true });
        cancelAfterAdmission?.abort();
        return async (outcome) => {
          const recorded = await post(
            "/maps/usage",
            { ...request, outcome },
            gate,
            now,
          );
          if (!recorded.ok)
            throw new Error("Maps controller refused the outcome");
        };
      },
      entitlement: async () => {
        throw new Error("Legacy entitlement path used");
      },
      admit: async () => {
        throw new Error("Legacy admission path used");
      },
      provider: () => provider,
    };
    const { GLOBAL_RATE_LIMITER: nativeLimit, RATE_LIMIT_STATE: rateState } =
      await mf.getBindings<{
        GLOBAL_RATE_LIMITER: RuntimeRateLimitBinding;
        RATE_LIMIT_STATE: RuntimeDurableObjectNamespace;
      }>();
    // Only bindings consumed by this composition are supplied; no primary DB or R2 fixture.
    const env = {
      NODE_ENV: "test",
      CLOUD_RATE_STATE_BACKEND: "cloudflare",
      GLOBAL_RATE_LIMITER: nativeLimit,
      RATE_LIMIT_STATE: rateState,
    } as AppEnv["Bindings"];
    const app = new Hono<AppEnv>();
    // Same global policy as bootstrap-app; this fixture does not boot its other routes.
    app.use(
      "*",
      rateLimit(
        {
          windowMs: 60_000,
          maxRequests: 600,
          keyGenerator: (c) =>
            `global:ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`,
        },
        { bindingName: "GLOBAL_RATE_LIMITER" },
      ),
    );
    app.route(
      "/api/v1/maps/tiles/:z/:x/:y",
      createMapsRoute("tiles", dependencies),
    );
    const tile = (
      id: string,
      options: { key?: string; ip?: string; signal?: AbortSignal } = {},
    ) =>
      app.request(
        "https://maps.test/api/v1/maps/tiles/2/1/3",
        {
          headers: {
            "x-api-key": options.key ?? "maps-route-fixture",
            "cf-connecting-ip": options.ip ?? "203.0.113.220",
            "Idempotency-Key": id,
          },
          signal: options.signal,
        },
        env,
      );
    const read = async (key: string) =>
      (await post("/test/read", { key }, gate)).json();

    expect(
      (await tile("unauthenticated", { key: "wrong-fixture" })).status,
    ).toBe(401);
    expect(await read("maps:allowance:window")).toBeNull();
    expect(providerCalls).toBe(0);
    const statusCounts: Record<number, number> = {};
    let lastRatePolicy: string | null = null;
    for (let index = 0; index < 65; index++) {
      const response = await tile(`tile-${index}`);
      statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
      lastRatePolicy = response.headers.get("x-ratelimit-policy");
      if (response.status === 200)
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    }
    expect(statusCounts).toEqual({ 200: 65 });
    expect(lastRatePolicy).toBe("cloudflare-native");
    expect(providerCalls).toBe(65);
    expect(await read("maps:allowance:window")).toMatchObject({ used: 65 });
    expect(await read("maps:usage:key:maps-key:tile-64")).toMatchObject({
      outcome: "succeeded",
    });

    failProvider = true;
    expect((await tile("provider-failed")).status).toBe(503);
    failProvider = false;
    expect(await read("maps:usage:key:maps-key:provider-failed")).toMatchObject(
      { outcome: "failed" },
    );
    cancelAfterAdmission = new AbortController();
    expect(
      (await tile("cancelled", { signal: cancelAfterAdmission.signal })).status,
    ).toBe(408);
    cancelAfterAdmission = undefined;
    expect(await read("maps:usage:key:maps-key:cancelled")).toMatchObject({
      outcome: "cancelled",
    });
    expect(providerCalls).toBe(66);
    expect(await read("maps:allowance:window")).toMatchObject({ used: 67 });
    const exhausted = await tile("after-cancel");
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toMatchObject({
      code: "allowance_exhausted",
    });
    const replay = await tile("tile-0");
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: "maps_request_already_admitted",
    });
    expect(await read("maps:allowance:window")).toMatchObject({ used: 67 });
    expect(providerCalls).toBe(66);

    await post("/credential/revoke", { credentialId: "maps-key" }, gate);
    const revoked = await tile("revoked");
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ code: "maps_access_denied" });
    expect(providerCalls).toBe(66);
    const blockedIp = "203.0.113.221";
    const filled = await Promise.all(
      Array.from({ length: 600 }, () =>
        nativeLimit.limit({ key: `global:ip:${blockedIp}` }),
      ),
    );
    expect(filled.every((result) => result.success)).toBe(true);
    const beforeGlobalRefusal = authenticationCalls;
    const globalRefused = await tile("global-refused", { ip: blockedIp });
    expect(globalRefused.status).toBe(429);
    expect(await globalRefused.json()).toMatchObject({
      code: "rate_limit_exceeded",
    });
    expect(authenticationCalls).toBe(beforeGlobalRefusal);
    expect(providerCalls).toBe(66);
    const receipts = await Promise.all(
      [
        ...Array.from({ length: 65 }, (_, index) => `tile-${index}`),
        "provider-failed",
        "cancelled",
      ].map((id) => read(`maps:usage:key:maps-key:${id}`)),
    );
    expect(receipts).toHaveLength(67);
    for (const receipt of receipts)
      expect(receipt).toMatchObject({
        operation: "tiles",
        userId: "maps-user",
      });
    expect(receipts).toEqual([
      ...Array.from({ length: 65 }, () =>
        expect.objectContaining({ outcome: "succeeded" }),
      ),
      expect.objectContaining({ outcome: "failed" }),
      expect.objectContaining({ outcome: "cancelled" }),
    ]);
    for (const id of [
      "unauthenticated",
      "after-cancel",
      "revoked",
      "global-refused",
    ])
      expect(await read(`maps:usage:key:maps-key:${id}`)).toBeNull();
  }, 60_000);
  test("Maps retains both refill boundaries through a clock rollback", async () => {
    const now = Date.parse("2027-01-01T00:02:00Z");
    for (const plan of ["clock_burst", "clock_sustained"]) {
      const gate = `rollback-${plan}`;
      expect(
        (await post("/maps/admit", mapsRequest("first", plan), gate, now))
          .status,
      ).toBe(200);
      expect(
        (
          await post(
            "/maps/admit",
            mapsRequest("backward", plan),
            gate,
            now - 5000,
          )
        ).status,
      ).toBe(200);
      expect(
        (await post("/maps/admit", mapsRequest("same-time", plan), gate, now))
          .status,
      ).toBe(429);
      expect(
        (
          await post(
            "/maps/admit",
            mapsRequest("new-time", plan),
            gate,
            now + 1000,
          )
        ).status,
      ).toBe(200);
    }
  });
  test("Maps retry delay includes the retained future refill boundary", async () => {
    const now = Date.parse("2027-01-01T00:02:00Z");
    for (const plan of ["clock_burst", "clock_sustained"]) {
      const gate = `retry-${plan}`;
      expect(
        (await post("/maps/admit", mapsRequest("first", plan), gate, now))
          .status,
      ).toBe(200);
      expect(
        (await post("/maps/admit", mapsRequest("second", plan), gate, now))
          .status,
      ).toBe(200);
      const refused = await post(
        "/maps/admit",
        mapsRequest("backward", plan),
        gate,
        now - 5000,
      );
      expect(refused.status).toBe(429);
      expect(
        ((await refused.json()) as { error: { retryAfterSeconds: number } })
          .error.retryAfterSeconds,
      ).toBe(6);
      expect(
        (
          await post(
            "/maps/admit",
            mapsRequest("too-early", plan),
            gate,
            now + 999,
          )
        ).status,
      ).toBe(429);
      expect(
        (
          await post(
            "/maps/admit",
            mapsRequest("ready", plan),
            gate,
            now + 1000,
          )
        ).status,
      ).toBe(200);
    }
  });
  test("Maps durable allowance is shared, atomic, separately counted, and never replays admission", async () => {
    const gate = "maps-atomic";
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post("/maps/admit", mapsRequest(`request-${i}`), gate),
      ),
    );
    expect(replies.filter((r) => r.status === 200)).toHaveLength(3);
    expect(replies.filter((r) => r.status === 429)).toHaveLength(17);
    const first = replies.findIndex((r) => r.status === 200);
    const request = mapsRequest(`request-${first}`);
    // Simulated lost admission ack: retry is a refusal, not a second provider authorization.
    expect((await post("/maps/admit", request, gate)).status).toBe(409);
    expect(
      (await post("/maps/admit", { ...request, operation: "routes" }, gate))
        .status,
    ).toBe(409);
    expect(
      (await post("/maps/usage", { ...request, outcome: "cancelled" }, gate))
        .status,
    ).toBe(200);
    expect(
      (await post("/maps/usage", { ...request, outcome: "cancelled" }, gate))
        .status,
    ).toBe(200);
    expect(
      (await post("/maps/usage", { ...request, outcome: "succeeded" }, gate))
        .status,
    ).toBe(409);
    expect(
      (await post("/maps/admit", mapsRequest("after-cancel"), gate)).status,
    ).toBe(429);
    // A separate organization object has its own allowance.
    expect(
      (await post("/maps/admit", mapsRequest("request-0"), "maps-other-org"))
        .status,
    ).toBe(200);
  });
  test("Maps preserves burst AND sustained dimensions and refuses missing selected plan", async () => {
    for (const plan of ["burst_test", "sustained_test"]) {
      expect(
        (await post("/maps/admit", mapsRequest("first", plan), plan)).status,
      ).toBe(200);
      const refusal = await post(
        "/maps/admit",
        mapsRequest("second", plan),
        plan,
      );
      expect(refusal.status).toBe(429);
      expect(JSON.parse(await refusal.text()).error.code).toBe("rate_limited");
    }
    const missing = await post(
      "/maps/admit",
      mapsRequest("missing", "no_selected_allowance"),
      "maps-missing",
    );
    expect(missing.status).toBe(503);
    expect(JSON.parse(await missing.text()).error.code).toBe(
      "maps_allowance_unconfigured",
    );
  });
  test("Maps retains original receipts and first outcomes across allowance windows", async () => {
    const gate = "maps-window-receipts";
    const now = Date.parse("2027-01-01T00:02:00Z");
    const later = now + 3_600_000;
    const original = mapsRequest("original");
    original.policy.effectiveUntil = new Date(now + 1000).toISOString();
    expect((await post("/maps/admit", original, gate, now)).status).toBe(200);
    expect(
      (await post("/maps/admit", mapsRequest("new-window"), gate, later))
        .status,
    ).toBe(200);
    expect(
      (await post("/maps/admit", mapsRequest("original"), gate, later)).status,
    ).toBe(409);
    // Usage belongs to the original admission even after its policy expired.
    expect(
      (
        await post(
          "/maps/usage",
          { ...original, outcome: "cancelled" },
          gate,
          later,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/maps/usage",
          { ...original, outcome: "succeeded" },
          gate,
          later,
        )
      ).status,
    ).toBe(409);
    expect(
      await (
        await post(
          "/test/read",
          { key: "maps:usage:key:maps-key:original" },
          gate,
        )
      ).json(),
    ).toEqual({
      operation: "search",
      userId: "maps-user",
      admittedAt: now,
      windowStart: Math.floor(now / 3_600_000) * 3_600_000,
      outcome: "cancelled",
    });
    const otherCredential = mapsRequest("original");
    otherCredential.credential.credentialId = "maps-other-key";
    expect(
      (await post("/maps/admit", otherCredential, gate, later)).status,
    ).toBe(200);
    expect(
      await (
        await post("/test/read", { key: "maps:allowance:window" }, gate)
      ).json(),
    ).toMatchObject({
      start: Math.floor(later / 3_600_000) * 3_600_000,
      used: 2,
    });
  });
  test("Maps refuses malformed policy, expired windows, and credential revocation before admission", async () => {
    const gate = "maps-revocation",
      request = mapsRequest("request");
    expect(
      (await post("/maps/admit", { ...request, operation: ["search"] }, gate))
        .status,
    ).toBe(400);
    expect(
      (
        await post(
          "/maps/admit",
          {
            ...request,
            policy: {
              ...request.policy,
              effectiveUntil: "2020-01-01T00:00:00Z",
            },
          },
          gate,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await post(
          "/credential/revoke",
          { organizationId: "org-miniflare", credentialId: "maps-key" },
          gate,
        )
      ).status,
    ).toBe(200);
    expect((await post("/maps/admit", request, gate)).status).toBe(403);
  });

  test("Maps count and replay tombstones survive a Worker restart, without touching zero monetary funds", async () => {
    const gate = "maps-restart";
    const ledger = {
      availableUsd: 0,
      balanceCeilingUsd: 0,
      activeEstimateUsd: 0,
      uncollectedDebtUsd: 0,
    };
    await post("/test/seed", { ledger }, gate);
    expect((await post("/maps/admit", mapsRequest("first"), gate)).status).toBe(
      200,
    );
    await mf.dispose();
    mf = new Miniflare(config);
    expect((await post("/maps/admit", mapsRequest("first"), gate)).status).toBe(
      409,
    );
    expect(
      (await post("/maps/admit", mapsRequest("second"), gate)).status,
    ).toBe(200);
    expect((await post("/maps/admit", mapsRequest("third"), gate)).status).toBe(
      200,
    );
    expect(
      (await post("/maps/admit", mapsRequest("fourth"), gate)).status,
    ).toBe(429);
    expect(
      await (await post("/test/read", { key: "ledger" }, gate)).json(),
    ).toEqual(ledger);
    const usage = await (
      await post("/test/read", { key: "maps:usage:key:maps-key:first" }, gate)
    ).json();
    expect(Object.keys(usage as object).sort()).toEqual([
      "admittedAt",
      "operation",
      "outcome",
      "userId",
      "windowStart",
    ]);
  });
  test("Maps refuses corrupted storage and carries rate tokens across allowance resets", async () => {
    const now = Date.now();
    await post(
      "/test/seed",
      {
        "maps:allowance:window": {
          start: 0,
          end: now - 1,
          used: 1,
          burst: { tokens: 0, at: now },
          sustained: { tokens: 0, at: now },
        },
      },
      "maps-reset",
    );
    expect(
      (
        await post(
          "/maps/admit",
          mapsRequest("new-window", "burst_test"),
          "maps-reset",
        )
      ).status,
    ).toBe(429);
    await post(
      "/test/seed",
      { "maps:allowance:window": { start: 0, end: now + 10000, used: -1 } },
      "maps-corrupt",
    );
    expect(
      (await post("/maps/admit", mapsRequest("corrupt"), "maps-corrupt"))
        .status,
    ).toBe(503);
  });
  test("Maps has its own limits when shared plan limits are off", async () => {
    const gate = "maps-only-rate-policy";
    await post(
      "/test/config",
      {
        ELIZA_CLOUD_PLAN_RATE_LIMITS: "",
        ELIZA_CLOUD_MAPS_PLAN_RATE_LIMITS: JSON.stringify({
          selected: true,
          plans: {
            default: {
              burst: { capacity: 1, refillPerSecond: 0.001 },
              sustained: { capacity: 10, refillPerSecond: 1 },
            },
          },
        }),
      },
      gate,
    );
    expect((await post("/maps/admit", mapsRequest("first"), gate)).status).toBe(
      200,
    );
    expect(
      (await post("/maps/admit", mapsRequest("second"), gate)).status,
    ).toBe(429);
  });
  test("Maps requires selected burst and sustained configuration as well as an allowance", async () => {
    const absentOrUnselected = [
      "",
      JSON.stringify({
        selected: false,
        plans: {
          default: {
            burst: { capacity: 2, refillPerSecond: 1 },
            sustained: { capacity: 2, refillPerSecond: 1 },
          },
        },
      }),
      JSON.stringify({ selected: true, plans: {} }),
    ];
    for (const [index, value] of absentOrUnselected.entries()) {
      const gate = `maps-rate-unconfigured-${index}`;
      await post("/test/config", { ELIZA_CLOUD_PLAN_RATE_LIMITS: value }, gate);
      const result = await post("/maps/admit", mapsRequest("request"), gate);
      expect(result.status).toBe(503);
      expect(
        ((await result.json()) as { error: { code: string } }).error.code,
      ).toBe("maps_allowance_unconfigured");
    }
  });
});

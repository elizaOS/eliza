/** Runs the production Maps allowance against actual SQLite Durable Object transactions. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, type MiniflareOptions } from "miniflare";

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
      durableObjects: { GATES: { className: "MapsTestGate", useSQLite: true } },
      bindings: {
        ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES: JSON.stringify({
          selected: true,
          plans: {
            maps_test: { requests: 3, windowSeconds: 3600 },
            burst_test: { requests: 100, windowSeconds: 3600 },
            sustained_test: { requests: 100, windowSeconds: 3600 },
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
          },
        }),
      },
    };
    mf = new Miniflare(config);
  });
  afterAll(async () => {
    await mf?.dispose();
    if (persistence) await rm(persistence, { recursive: true, force: true });
  });
  async function post(
    path: string,
    body: Record<string, unknown>,
    gate: string,
  ) {
    return mf.dispatchFetch(`https://maps.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-gate": gate },
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

/**
 * Exercises the cross-environment routing verifier: a staging custom domain that
 * is answered by the production environment (or vice-versa) is a hard failure -
 * that is the "staging pointing at prod CF" regression this guard exists to
 * catch. Transient/rollout states (unreachable origin, pre-beacon build) are
 * tolerated unless their strictness flag is set. The wrangler-sync case keeps the
 * domain matrix from drifting away from the real Worker routes.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  classifyProbe,
  decideRoutingVerdict,
  ENVIRONMENT_ROUTING,
  fetchServedEnvironment,
  KNOWN_ENVIRONMENTS,
  parseServedEnvironment,
} from "../verify-environment-routing.mjs";
import { selectMatrix } from "../verify-environment-routing-cli.mjs";

describe("parseServedEnvironment", () => {
  it("extracts the environment from a valid /api/health body", () => {
    expect(
      parseServedEnvironment(
        JSON.stringify({ status: "ok", environment: "staging" }),
      ),
    ).toBe("staging");
  });

  it("trims surrounding whitespace", () => {
    expect(
      parseServedEnvironment(JSON.stringify({ environment: "  production  " })),
    ).toBe("production");
  });

  it("returns null when the field is absent (build predates the beacon)", () => {
    expect(parseServedEnvironment(JSON.stringify({ status: "ok" }))).toBeNull();
  });

  it("returns null for blank / null environment", () => {
    expect(
      parseServedEnvironment(JSON.stringify({ environment: "  " })),
    ).toBeNull();
    expect(
      parseServedEnvironment(JSON.stringify({ environment: null })),
    ).toBeNull();
  });

  it("returns null for unparseable / non-object bodies (SPA index.html fallthrough)", () => {
    expect(parseServedEnvironment("<!doctype html>")).toBeNull();
    expect(parseServedEnvironment("")).toBeNull();
    expect(parseServedEnvironment(JSON.stringify("staging"))).toBeNull();
    // @ts-expect-error deliberately wrong type
    expect(parseServedEnvironment(undefined)).toBeNull();
  });
});

describe("classifyProbe", () => {
  const P = {
    domain: "cloud-staging.eliza.app",
    expected: "staging" as const,
  };

  it("ok when the observed env matches expected", () => {
    const r = classifyProbe({ ...P, observed: "staging", reachable: true });
    expect(r.status).toBe("ok");
  });

  it("MISROUTED when a staging domain is answered by production", () => {
    const r = classifyProbe({ ...P, observed: "production", reachable: true });
    expect(r.status).toBe("misrouted");
    expect(r.message).toContain("MISROUTED");
  });

  it("MISROUTED in the reverse direction (prod domain answered by staging)", () => {
    const r = classifyProbe({
      domain: "cloud.eliza.app",
      expected: "production",
      observed: "staging",
      reachable: true,
    });
    expect(r.status).toBe("misrouted");
  });

  it("beacon_missing when reachable but no environment field", () => {
    const r = classifyProbe({ ...P, observed: null, reachable: true });
    expect(r.status).toBe("beacon_missing");
  });

  it("unreachable when the origin did not return a usable answer", () => {
    const r = classifyProbe({
      ...P,
      observed: null,
      reachable: false,
      detail: "HTTP 502",
    });
    expect(r.status).toBe("unreachable");
    expect(r.message).toContain("HTTP 502");
  });

  it("unexpected_env for an unrecognized environment string", () => {
    const r = classifyProbe({ ...P, observed: "qa", reachable: true });
    expect(r.status).toBe("unexpected_env");
  });
});

describe("decideRoutingVerdict", () => {
  const probe = (over: Record<string, unknown>) =>
    classifyProbe({
      domain: "d",
      expected: "staging",
      observed: "staging",
      reachable: true,
      ...over,
    });

  it("passes when every probe is ok", () => {
    const v = decideRoutingVerdict({
      probes: [probe({}), probe({ domain: "e" })],
    });
    expect(v.ok).toBe(true);
    expect(v.failures).toHaveLength(0);
  });

  it("FAILS on any misrouted probe (the core regression)", () => {
    const v = decideRoutingVerdict({
      probes: [probe({}), probe({ observed: "production" })],
    });
    expect(v.ok).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0].status).toBe("misrouted");
  });

  it("FAILS on an unexpected env regardless of flags", () => {
    const v = decideRoutingVerdict({ probes: [probe({ observed: "qa" })] });
    expect(v.ok).toBe(false);
  });

  it("treats beacon_missing as a warning by default, a failure with requireBeacon", () => {
    const probes = [probe({ observed: null })];
    expect(decideRoutingVerdict({ probes }).ok).toBe(true);
    expect(decideRoutingVerdict({ probes }).warnings).toHaveLength(1);
    expect(decideRoutingVerdict({ probes, requireBeacon: true }).ok).toBe(
      false,
    );
  });

  it("fails on unreachable by default, warns when requireReachable is false", () => {
    const probes = [probe({ observed: null, reachable: false })];
    expect(decideRoutingVerdict({ probes }).ok).toBe(false);
    expect(decideRoutingVerdict({ probes, requireReachable: false }).ok).toBe(
      true,
    );
  });

  it("summary reports status counts", () => {
    const v = decideRoutingVerdict({
      probes: [probe({}), probe({ observed: "production" })],
    });
    expect(v.summary).toContain("misrouted=1");
    expect(v.summary).toContain("ok=1");
  });

  it("handles an empty / non-array probe list", () => {
    expect(decideRoutingVerdict({ probes: [] }).ok).toBe(true);
    // @ts-expect-error deliberately wrong type
    expect(decideRoutingVerdict({ probes: null }).ok).toBe(true);
  });
});

describe("fetchServedEnvironment - network boundary", () => {
  const noSleep = async () => {};

  it("returns the observed env on a 200 with a valid beacon", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ environment: "staging" }),
    })) as unknown as typeof fetch;
    const r = await fetchServedEnvironment("cloud-staging.eliza.app", {
      fetchImpl,
      sleep: noSleep,
    });
    expect(r).toMatchObject({ observed: "staging", reachable: true });
  });

  it("is reachable-but-beaconless on a 200 without the field", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;
    const r = await fetchServedEnvironment("cloud.eliza.app", {
      fetchImpl,
      sleep: noSleep,
    });
    expect(r).toMatchObject({ observed: null, reachable: true });
  });

  it("requests https://<domain>/api/health", async () => {
    let requested = "";
    const fetchImpl = (async (url: string) => {
      requested = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ environment: "production" }),
      };
    }) as unknown as typeof fetch;
    await fetchServedEnvironment("api.eliza.app///", {
      fetchImpl,
      sleep: noSleep,
    });
    expect(requested).toBe("https://api.eliza.app/api/health");
  });

  it("retries and succeeds after a transient failure", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 2) throw new Error("ECONNRESET");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ environment: "staging" }),
      };
    }) as unknown as typeof fetch;
    const r = await fetchServedEnvironment("staging.eliza.app", {
      fetchImpl,
      sleep: noSleep,
    });
    expect(calls).toBe(2);
    expect(r.reachable).toBe(true);
  });

  it("reports unreachable after exhausting retries on non-200", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    })) as unknown as typeof fetch;
    const r = await fetchServedEnvironment("api-staging.eliza.app", {
      fetchImpl,
      attempts: 2,
      sleep: noSleep,
    });
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("502");
  });

  it("reports unreachable when fetch always throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const r = await fetchServedEnvironment("staging.eliza.app", {
      fetchImpl,
      attempts: 2,
      sleep: noSleep,
    });
    expect(r.reachable).toBe(false);
  });

  it("returns unreachable for a blank domain without touching the network", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as typeof fetch;
    const r = await fetchServedEnvironment("   ", {
      fetchImpl,
      sleep: noSleep,
    });
    expect(r.reachable).toBe(false);
    expect(called).toBe(false);
  });
});

describe("selectMatrix", () => {
  it("returns the whole matrix for all / undefined", () => {
    expect(selectMatrix("all")).toHaveLength(ENVIRONMENT_ROUTING.length);
    expect(selectMatrix(undefined)).toHaveLength(ENVIRONMENT_ROUTING.length);
  });

  it("filters to one environment (and accepts the prod alias)", () => {
    const staging = selectMatrix("staging");
    expect(staging.every((e) => e.environment === "staging")).toBe(true);
    expect(staging.length).toBeGreaterThan(0);
    const prod = selectMatrix("prod");
    expect(prod.every((e) => e.environment === "production")).toBe(true);
  });
});

describe("ENVIRONMENT_ROUTING matrix integrity", () => {
  it("has unique canonical domains under eliza.app with a known env", () => {
    const domains = ENVIRONMENT_ROUTING.map((e) => e.domain);
    expect(new Set(domains).size).toBe(domains.length);
    for (const { domain, environment } of ENVIRONMENT_ROUTING) {
      expect(domain.endsWith("eliza.app")).toBe(true);
      expect(KNOWN_ENVIRONMENTS).toContain(environment);
    }
  });

  it("keeps staging Pages hosts off the Worker while retaining API and wildcard routes", () => {
    const wrangler = readFileSync(
      new URL("../../api/wrangler.toml", import.meta.url),
      "utf8",
    );
    const stagingBlock = wrangler.slice(
      wrangler.indexOf("[env.staging]"),
      wrangler.indexOf("[env.production]"),
    );
    const routeHosts = [
      ...stagingBlock.matchAll(/pattern\s*=\s*"([^"/]+)\/\*"/g),
    ].map((m) => m[1]);
    expect(routeHosts).not.toContain("staging.eliza.app");
    expect(routeHosts).not.toContain("cloud-staging.eliza.app");
    expect(routeHosts).toContain("api-staging.eliza.app");
    expect(routeHosts).toContain("relay-staging.eliza.app");

    // Agent, hosted-site, tunnel, and legacy wildcard ingress all remain
    // Worker-owned. Exact browser hosts are Pages-owned above.
    const wildcardHosts = routeHosts.filter((h) => h.includes("*"));
    expect(wildcardHosts).toEqual([
      "*.cloud-staging.eliza.app",
      "*.sites-staging.eliza.app",
      "*.staging.elizacloud.ai",
      "*.tunnel-staging.elizacloud.ai",
      "*.sites-staging.elizacloud.ai",
    ]);
    const stagingMatrix = new Set(
      ENVIRONMENT_ROUTING.filter((e) => e.environment === "staging").map(
        (e) => e.domain,
      ),
    );
    expect(stagingMatrix.size).toBeGreaterThan(0);
    expect(stagingMatrix).toEqual(
      new Set([
        "staging.eliza.app",
        "cloud-staging.eliza.app",
        "api-staging.eliza.app",
        "relay-staging.eliza.app",
      ]),
    );
  });
});

import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// Mirrors AGENT_ROUTING_TTL_SECONDS in ../redis (30 days). Asserted directly so
// a wrong-duration TTL regression can't pass a mere `> 0` check.
const THIRTY_DAYS_SECONDS = 30 * 24 * 3600;

const PREV_MOCK = process.env.MOCK_REDIS;

beforeAll(() => {
  process.env.MOCK_REDIS = "1";
});

afterAll(() => {
  if (PREV_MOCK === undefined) {
    delete process.env.MOCK_REDIS;
  } else {
    process.env.MOCK_REDIS = PREV_MOCK;
  }
});

// ioredis-mock instances share one in-memory store, so a probe client created
// here observes exactly the keys the module-under-test's own client wrote. This
// lets us assert the real state transitions (not just "did not throw").
function probeClient() {
  const requireCJS = createRequire(`${process.cwd()}/package.json`);
  // biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop with ioredis-mock
  const mod = requireCJS("ioredis-mock") as any;
  const Ctor = mod?.default ?? mod;
  return new Ctor();
}

describe("operator capabilities/redis (MOCK_REDIS=1)", () => {
  test("setServerState writes status + url with a routing TTL", async () => {
    const { setServerState } = await import("../redis");
    const probe = probeClient();
    await probe.del("server:s1:status", "server:s1:url");

    await setServerState("s1", "ready", "http://s1.local");

    expect(await probe.get("server:s1:status")).toBe("ready");
    expect(await probe.get("server:s1:url")).toBe("http://s1.local");
    // Both keys carry the 30-day agent-routing TTL, not a permanent write and
    // not some other duration. Assert the actual window (allowing a few seconds
    // of clock slack), so a regression to a wrong TTL — or a missing EX — fails.
    for (const key of ["server:s1:status", "server:s1:url"]) {
      const ttl = await probe.ttl(key);
      expect(ttl, `${key} TTL`).toBeGreaterThan(THIRTY_DAYS_SECONDS - 60);
      expect(ttl, `${key} TTL`).toBeLessThanOrEqual(THIRTY_DAYS_SECONDS);
    }
  });

  test("setAgentServer maps an agent to its server; removeAgentServer clears it", async () => {
    const { setAgentServer, removeAgentServer } = await import("../redis");
    const probe = probeClient();
    await probe.del("agent:a1:server");

    await setAgentServer("a1", "s1");
    expect(await probe.get("agent:a1:server")).toBe("s1");
    const agentTtl = await probe.ttl("agent:a1:server");
    expect(agentTtl).toBeGreaterThan(THIRTY_DAYS_SECONDS - 60);
    expect(agentTtl).toBeLessThanOrEqual(THIRTY_DAYS_SECONDS);

    await removeAgentServer("a1");
    expect(await probe.get("agent:a1:server")).toBeNull();
  });

  test("cleanupServer removes server status/url + every tracked agent mapping", async () => {
    const { setServerState, setAgentServer, cleanupServer } = await import(
      "../redis"
    );
    const probe = probeClient();

    await setServerState("s2", "ready", "http://s2.local");
    await setAgentServer("a2", "s2");
    await setAgentServer("a3", "s2");
    // Also plant the keda activity key cleanup is documented to purge.
    await probe.set("keda:s2:activity", "1");

    // Precondition: everything is present before cleanup.
    expect(await probe.get("server:s2:status")).toBe("ready");
    expect(await probe.get("agent:a2:server")).toBe("s2");

    await cleanupServer("s2", ["a2", "a3"]);

    expect(await probe.get("server:s2:status")).toBeNull();
    expect(await probe.get("server:s2:url")).toBeNull();
    expect(await probe.get("keda:s2:activity")).toBeNull();
    expect(await probe.get("agent:a2:server")).toBeNull();
    expect(await probe.get("agent:a3:server")).toBeNull();
  });

  test("cleanupServer with no agent ids still purges the server keys", async () => {
    const { setServerState, cleanupServer } = await import("../redis");
    const probe = probeClient();

    await setServerState("s3", "draining", "http://s3.local");
    await cleanupServer("s3", []);

    expect(await probe.get("server:s3:status")).toBeNull();
    expect(await probe.get("server:s3:url")).toBeNull();
  });
});

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MOCK_ENVIRONMENTS } from "../../scripts/mocks/start-mocks.ts";
import { startSyntheticScenarioWorld } from "../src/scenario-world.ts";
import { SqliteSyntheticEnvironmentLeaseStore } from "../src/sqlite-lease-store.ts";

test("all registered API services start in one leased world, with complete mutation and fault evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synthetic-api-world-"));
  const store = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(root, "lease.sqlite"),
  );
  const world = await startSyntheticScenarioWorld({
    leaseStore: store,
    manifest: {
      version: 1,
      namespace: "world-all-services",
      manifestId: "all-v1",
      domains: Object.fromEntries(MOCK_ENVIRONMENTS.map((name) => [name, {}])),
    },
  });
  try {
    for (const endpoint of Object.values(world.endpoints)) {
      const response = await fetch(`${endpoint}/__mock/requests`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ requests: [] });
    }
    const response = await fetch(
      `${world.endpoints.slack}/api/chat.postMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C001", text: "world mutation" }),
      },
    );
    expect((await response.json()).ok).toBe(true);
    expect(JSON.stringify(world.snapshot())).toContain("world mutation");
    await world.installFault({
      id: "google-once",
      scope: "google",
      operation: "GET /calendar/v3/calendars/primary/events",
      count: 1,
      mode: "error",
      data: { statusCode: 429 },
    });
    const googleUrl = `${world.endpoints.google}/calendar/v3/calendars/primary/events`;
    const faulted = await fetch(googleUrl);
    expect(faulted.status).toBe(429);
    await faulted.text();
    const recovered = await fetch(googleUrl);
    expect(recovered.status).toBe(200);
    await recovered.text();
    expect(world.requestLedger().filter((entry) => entry.faultId)).toHaveLength(
      1,
    );
    const ledger = world.requestLedger();
    const slackWrite = ledger.find((entry) => entry.service === "slack");
    expect(slackWrite).toBeDefined();
    if (slackWrite) slackWrite.body.text = "tampered observer copy";
    expect(
      world.requestLedger().find((entry) => entry.service === "slack")?.body
        .text,
    ).toBe("world mutation");
    world.assertComplete();
    const missing = await fetch(
      `${world.endpoints.google}/unimplemented-route`,
    );
    expect(missing.status).toBe(404);
    await missing.text();
    expect(() => world.assertComplete()).toThrow("unmatched");
  } finally {
    await world.close();
    expect((await store.read(world.namespace))?.status).toBe("released");
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("failed seeds release ownership, and independent namespaces cannot share mock state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synthetic-api-isolation-"));
  const store = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(root, "lease.sqlite"),
  );
  try {
    await expect(
      startSyntheticScenarioWorld({
        leaseStore: store,
        manifest: {
          version: 1,
          namespace: "failed",
          manifestId: "bad-seed",
          domains: { slack: { seed: [{ method: "GET", path: "/missing" }] } },
        },
      }),
    ).rejects.toThrow("Seed failed");
    expect((await store.read("failed"))?.status).toBe("released");
    const worlds = await Promise.all(
      ["one", "two"].map((namespace) =>
        startSyntheticScenarioWorld({
          leaseStore: store,
          manifest: {
            version: 1,
            namespace,
            manifestId: "same-manifest",
            domains: { slack: {} },
          },
        }),
      ),
    );
    try {
      expect(worlds[0].endpoints.slack).not.toBe(worlds[1].endpoints.slack);
      const response = await fetch(
        `${worlds[0].endpoints.slack}/api/chat.postMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: "C001",
            text: "only-in-first-world",
          }),
        },
      );
      await response.text();
      expect(JSON.stringify(worlds[1].snapshot())).not.toContain(
        "only-in-first-world",
      );
      expect(worlds[1].requestLedger()).toHaveLength(0);
    } finally {
      await Promise.all(worlds.map((world) => world.close()));
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("reseeding preserves API state identity, interleaved ledgers are ordered, and consumers cannot erase evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synthetic-repeatable-"));
  const store = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(root, "lease.sqlite"),
  );
  const manifest = {
    version: 1 as const,
    namespace: "repeatable",
    manifestId: "stable",
    domains: {
      slack: {
        seed: [
          {
            method: "POST",
            path: "/api/chat.postMessage",
            body: { channel: "C001", text: "repeatable seed" },
          },
        ],
      },
      google: {},
    },
  };
  try {
    const first = await startSyntheticScenarioWorld({
      leaseStore: store,
      manifest,
    });
    const expected = first.snapshot();
    await first.close();
    const second = await startSyntheticScenarioWorld({
      leaseStore: store,
      manifest,
    });
    try {
      expect(second.snapshot()).toEqual(expected);
      await (
        await fetch(
          `${second.endpoints.google}/calendar/v3/calendars/primary/events`,
        )
      ).text();
      await (
        await fetch(`${second.endpoints.slack}/api/chat.postMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: "C001", text: "last" }),
        })
      ).text();
      expect(second.requestLedger().map((entry) => entry.sequence)).toEqual([
        1, 2, 3,
      ]);
      const denied = await fetch(`${second.endpoints.slack}/__mock/requests`, {
        method: "DELETE",
      });
      expect(denied.status).toBe(403);
      await denied.text();
      expect(second.requestLedger()).toHaveLength(4);
      expect(() => second.assertComplete()).toThrow("unmatched");
    } finally {
      await second.close();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("closing a world interrupts a partial HTTP body before waiting for its lease heartbeat", async () => {
  const { connect } = await import("node:net");
  const root = await mkdtemp(path.join(tmpdir(), "synthetic-partial-request-"));
  const store = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(root, "lease.sqlite"),
  );
  const world = await startSyntheticScenarioWorld({
    leaseStore: store,
    leaseDurationMs: 30_000,
    manifest: {
      version: 1,
      namespace: "partial-request",
      manifestId: "partial",
      domains: { slack: {} },
    },
  });
  const slackEndpoint = world.endpoints.slack;
  if (!slackEndpoint)
    throw new Error("World did not expose its Slack endpoint");
  const endpoint = new URL(slackEndpoint);
  const socket = connect(Number(endpoint.port), endpoint.hostname);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      "POST /api/chat.postMessage HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{",
    );
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        world.close(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("world cleanup blocked behind request")),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect((await store.read("partial-request"))?.status).toBe("released");
  } finally {
    socket.destroy();
    await world.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("seed-command cancellation does not cancel an already-published world", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "synthetic-seed-cancellation-"),
  );
  const store = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(root, "lease.sqlite"),
  );
  const command = new AbortController();
  const manifest = {
    version: 1 as const,
    namespace: "seed-cancellation",
    manifestId: "seed-cancellation",
    domains: {
      slack: {
        seed: [
          {
            method: "POST",
            path: "/api/chat.postMessage",
            body: { channel: "C001", text: "seeded" },
          },
        ],
      },
    },
  };
  const world = await startSyntheticScenarioWorld({
    leaseStore: store,
    manifest,
    initializationSignal: command.signal,
  });
  try {
    const reason = new Error("seed command completed");
    command.abort(reason);
    expect(world.signal.aborted).toBe(false);
    const response = await fetch(
      `${world.endpoints.slack}/api/chat.postMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C001", text: "after seed" }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(JSON.stringify(world.snapshot())).toContain("after seed");
    await expect(
      startSyntheticScenarioWorld({
        leaseStore: store,
        manifest: { ...manifest, namespace: "cancelled-before-acquire" },
        initializationSignal: command.signal,
      }),
    ).rejects.toBe(reason);
    expect(await store.read("cancelled-before-acquire")).toBeNull();
  } finally {
    await world.close();
    expect((await store.read(manifest.namespace))?.status).toBe("released");
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

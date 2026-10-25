import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSyntheticControlHandler,
  SyntheticControlClient,
  SyntheticControlSession,
} from "../../src/synthetic-control/index.ts";
import { createSyntheticWorldControlAuthority } from "../src/control-authority.ts";
import { SqliteSyntheticEnvironmentLeaseStore } from "../src/sqlite-lease-store.ts";

test("real control sessions seed API state, observe it and reset before releasing the lease", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "synthetic-world-control-"),
  );
  const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(directory, "leases.sqlite"),
  );
  const authority = createSyntheticWorldControlAuthority({
    namespace: "control-test",
    leaseStore,
  });
  const token = "synthetic-control-test-token";
  const handler = createSyntheticControlHandler({
    namespace: "control-test",
    token,
    authority,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      (await handler(request)) ?? new Response("missing", { status: 404 }),
  });
  const client = new SyntheticControlClient({
    baseUrl: server.url.origin,
    token,
    namespace: "control-test",
  });
  let session: SyntheticControlSession | undefined;
  try {
    await expect(
      SyntheticControlSession.open({
        client,
        manifest: {
          version: 1,
          namespace: "control-test",
          manifestId: "invalid-seed",
          domains: {
            slack: {
              seed: [{ method: "POST", path: "/not-a-real-route", body: {} }],
            },
          },
        },
      }),
    ).rejects.toThrow();
    expect((await leaseStore.read("control-test"))?.status).toBe("released");
    session = await SyntheticControlSession.open({
      client,
      manifest: {
        version: 1,
        namespace: "control-test",
        manifestId: "slack-seed",
        domains: {
          slack: {
            seed: [
              {
                method: "POST",
                path: "/api/chat.postMessage",
                body: { channel: "C001", text: "seeded through actual API" },
              },
            ],
          },
        },
      },
    });
    const replayOptions = {
      commandId: "install-once",
      expectedGeneration: await authority.generation(),
      leaseId: session.leaseId,
    };
    const fault = {
      id: "once",
      scope: "slack",
      operation: "GET /api/conversations.list",
      mode: "error" as const,
      count: 1,
    };
    const installed = await client.command(
      { type: "fault.install", fault },
      replayOptions,
    );
    expect(
      await client.command({ type: "fault.install", fault }, replayOptions),
    ).toEqual(installed);
    await expect(
      client.command({ type: "fault.clear" }, replayOptions),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await session.execute({ type: "fault.clear" });
    const snapshot = await session.execute({ type: "snapshot" });
    expect(JSON.stringify(snapshot)).toContain("seeded through actual API");
    const ledger = await session.execute({ type: "ledger.query" });
    expect(JSON.stringify(ledger)).toContain("/api/chat.postMessage");
    await expect(
      session.execute({ type: "time.advance", milliseconds: 100 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_COMMAND" });
    await session.close();
    expect((await leaseStore.read("control-test"))?.status).toBe("released");
  } finally {
    await authority.close();
    await server.stop(true);
    leaseStore.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

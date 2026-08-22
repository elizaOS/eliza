/** Proves the shared control client against a real control-plane mock in an independent OS process. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  createSyntheticControlHandler,
  type JsonValue,
  SyntheticControlClient,
  SyntheticControlDirtySessionError,
  SyntheticControlProtocolError,
  SyntheticControlSession,
  type SyntheticResetReceipt,
} from "@elizaos/shared/synthetic-control";

const TOKEN = "synthetic-control-test-token-0001";
const children: Array<ReturnType<typeof Bun.spawn>> = [];

async function startAuthority(): Promise<{
  child: ReturnType<typeof Bun.spawn>;
  client: SyntheticControlClient;
  url: string;
  pid: number;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=eliza-source",
      "test/fixtures/synthetic-control-authority.ts",
    ],
    {
      cwd: import.meta.dir.replace(/\/test$/, ""),
      env: { ...process.env, SYNTHETIC_CONTROL_TOKEN: TOKEN },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(child);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`authority exited before ready: ${stderr}`);
    }
    buffered += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  const ready = JSON.parse(buffered.slice(0, buffered.indexOf("\n"))) as {
    type: string;
    url: string;
    pid: number;
  };
  if (ready.type !== "ready")
    throw new Error("authority emitted invalid ready record");
  return {
    child,
    client: new SyntheticControlClient({ baseUrl: ready.url, token: TOKEN }),
    url: ready.url,
    pid: ready.pid,
  };
}

async function rejectionCode(
  promise: Promise<unknown>,
): Promise<SyntheticControlProtocolError["code"]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SyntheticControlProtocolError) return error.code;
    throw error;
  }
  throw new Error("expected synthetic control command to reject");
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }),
  );
});

describe("synthetic control subprocess protocol", () => {
  test("bounds client timeouts and redacts authority failures on the HTTP boundary", async () => {
    expect(
      () =>
        new SyntheticControlClient({
          baseUrl: "http://127.0.0.1:1",
          token: TOKEN,
          timeoutMs: 0,
        }),
    ).toThrow("between 1 and 300000");

    const secret = "provider_api_key=do-not-return-this";
    const handler = createSyntheticControlHandler({
      token: TOKEN,
      authority: {
        generation: () => 7,
        execute: async () => {
          throw new Error(secret);
        },
      },
    });
    const response = await handler(
      new Request("http://127.0.0.1/__eliza/synthetic-control/v1", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          commandId: "secret-failure",
          command: { type: "health" },
        }),
      }),
    );
    const body = await response?.text();
    expect(body).not.toContain(secret);
    expect(JSON.parse(body ?? "{}")).toMatchObject({
      ok: false,
      generation: 7,
      error: {
        code: "COMMAND_FAILED",
        message: "control authority failed the command",
      },
    });

    const generationFailure = createSyntheticControlHandler({
      token: TOKEN,
      authority: {
        generation: () => {
          throw new Error(secret);
        },
        execute: async () => ({ unreachable: true }),
      },
    });
    const failedHealth = await generationFailure(
      new Request("http://127.0.0.1/__eliza/synthetic-control/v1", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          commandId: "generation-failure",
          command: { type: "health" },
        }),
      }),
    );
    expect(failedHealth?.status).toBe(503);
    expect(await failedHealth?.text()).not.toContain(secret);

    const invalidRequest = await handler(
      new Request("http://127.0.0.1/__eliza/synthetic-control/v1", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          commandId: "invalid-secret-command",
          command: { type: secret },
        }),
      }),
    );
    const invalidBody = await invalidRequest?.text();
    expect(invalidBody).not.toContain(secret);
    expect(JSON.parse(invalidBody ?? "{}")).toMatchObject({
      ok: false,
      generation: 7,
      error: {
        code: "INVALID_REQUEST",
        message: "control request is invalid",
      },
    });
  });

  test("marks post-mutation seed failures dirty instead of fabricating cleanup", async () => {
    let generation = 0;
    let leaseHeld = false;
    const handler = createSyntheticControlHandler({
      token: TOKEN,
      authority: {
        generation: () => generation,
        execute: async (command): Promise<JsonValue> => {
          if (command.type === "health") return { status: "ready" };
          if (command.type === "lease.acquire") {
            leaseHeld = true;
            generation += 1;
            return { leaseId: "partial-seed-lease" };
          }
          if (command.type === "seed") {
            generation += 1;
            throw new Error("seed failed after its first production write");
          }
          if (command.type === "lease.release") {
            leaseHeld = false;
            generation += 1;
            return { released: true };
          }
          return {};
        },
      },
    });
    const client = new SyntheticControlClient({
      baseUrl: "http://127.0.0.1",
      token: TOKEN,
      fetch: async (input, init) => {
        const response = await handler(new Request(input, init));
        if (!response) throw new Error("control handler declined request");
        return response;
      },
    });
    let dirty: SyntheticControlDirtySessionError | null = null;
    try {
      await SyntheticControlSession.open({
        client,
        manifest: {
          version: 1,
          namespace: "partial-seed",
          manifestId: "partial-seed",
          domains: {},
        },
      });
    } catch (error) {
      if (error instanceof SyntheticControlDirtySessionError) dirty = error;
      else throw error;
    }
    expect(dirty).toMatchObject({
      leaseId: "partial-seed-lease",
      lastKnownGeneration: 2,
    });
    expect(leaseHeld).toBe(true);
  });

  test("rejects lossy manifests before any subprocess request is sent", async () => {
    let fetchCalls = 0;
    const client = new SyntheticControlClient({
      baseUrl: "http://127.0.0.1:1",
      token: TOKEN,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("must not send invalid manifest");
      },
    });
    const code = await rejectionCode(
      client.command({
        type: "seed",
        manifest: {
          version: 1,
          namespace: "invalid",
          manifestId: "lossy",
          domains: { invalid: undefined },
        } as never,
      }),
    ).catch((error) => {
      expect(String(error)).toContain("JSON-only");
      return "INVALID_REQUEST" as const;
    });
    expect(code).toBe("INVALID_REQUEST");
    expect(fetchCalls).toBe(0);
  });

  test("runs the shared scenario and Cloud manifest session with reset-bound teardown", async () => {
    const { child, client } = await startAuthority();
    const session = await SyntheticControlSession.open({
      client,
      owner: "shared-harness",
      manifest: {
        version: 1,
        namespace: "shared-session",
        manifestId: "shared-manifest",
        domains: { notifications: [{ id: "notification-1" }] },
      },
    });
    expect(await session.execute({ type: "snapshot" })).toMatchObject({
      manifest: { manifestId: "shared-manifest" },
    });
    await session.close({ teardown: true, reason: "session verified" });
    expect(await child.exited).toBe(0);
  });

  test("shares one manifest lifecycle with the real control-plane mock HTTP process", async () => {
    const { child, client, url, pid } = await startAuthority();

    const productionHealth = await fetch(`${url}/health`);
    expect(productionHealth.status).toBe(200);

    const health = await client.command({ type: "health" });
    expect(health).toMatchObject({
      generation: 0,
      data: { status: "ready", pid },
    });
    const lease = await client.command(
      { type: "lease.acquire", owner: "scenario-runner", ttlMs: 60_000 },
      { expectedGeneration: health.generation },
    );
    const leaseId = (lease.data as { leaseId: string }).leaseId;
    const seeded = await client.command(
      {
        type: "seed",
        manifest: {
          version: 1,
          namespace: "scenario-24078",
          manifestId: "manifest-1",
          domains: {
            messages: [{ id: "message-1", text: "synthetic hello" }],
            schedule: [{ id: "task-1", at: "2042-01-01T00:00:00.000Z" }],
          },
        },
      },
      { expectedGeneration: lease.generation, leaseId },
    );
    const resetReceipt = (
      seeded.data as unknown as { receipt: SyntheticResetReceipt }
    ).receipt;
    const advanced = await client.command(
      { type: "time.advance", milliseconds: 3_600_000 },
      { expectedGeneration: seeded.generation, leaseId },
    );
    const faulted = await client.command(
      {
        type: "fault.install",
        fault: {
          id: "provider-error",
          scope: "provider",
          mode: "error",
          count: 1,
          errorCode: "synthetic_failure",
        },
      },
      { expectedGeneration: advanced.generation, leaseId },
    );
    const cleared = await client.command(
      { type: "fault.clear", scope: "provider" },
      { expectedGeneration: faulted.generation, leaseId },
    );
    const snapshot = await client.command(
      { type: "snapshot" },
      { expectedGeneration: cleared.generation, leaseId },
    );
    expect(snapshot.data).toMatchObject({
      logicalTimeMs: 3_600_000,
      manifest: { manifestId: "manifest-1" },
    });
    const ledger = await client.command(
      { type: "ledger.query", afterSequence: 0, limit: 100 },
      { expectedGeneration: snapshot.generation, leaseId },
    );
    expect(
      (ledger.data as { entries: unknown[] }).entries.length,
    ).toBeGreaterThanOrEqual(3);

    const reset = await client.command(
      { type: "reset", receipt: resetReceipt },
      { expectedGeneration: ledger.generation, leaseId },
    );
    const released = await client.command(
      { type: "lease.release", leaseId },
      { expectedGeneration: reset.generation, leaseId },
    );
    const reacquired = await client.command(
      { type: "lease.acquire", owner: "teardown", ttlMs: 60_000 },
      { expectedGeneration: released.generation },
    );
    const teardownLeaseId = (reacquired.data as { leaseId: string }).leaseId;
    const teardown = await client.command(
      { type: "teardown", reason: "test complete" },
      { expectedGeneration: reacquired.generation, leaseId: teardownLeaseId },
    );
    expect(teardown.data).toEqual({ accepted: true, leaseReleased: true });
    expect(await child.exited).toBe(0);
  });

  test("fences concurrent commands and reset during an awaited operation", async () => {
    const { client } = await startAuthority();
    const health = await client.command({ type: "health" });
    const lease = await client.command(
      { type: "lease.acquire", owner: "cloud-e2e", ttlMs: 60_000 },
      { expectedGeneration: health.generation },
    );
    const leaseId = (lease.data as { leaseId: string }).leaseId;
    const seeded = await client.command(
      {
        type: "seed",
        manifest: {
          version: 1,
          namespace: "concurrency",
          manifestId: "manifest-concurrency",
          domains: {},
        },
      },
      { expectedGeneration: lease.generation, leaseId },
    );
    const receipt = (
      seeded.data as unknown as { receipt: SyntheticResetReceipt }
    ).receipt;
    const faulted = await client.command(
      {
        type: "fault.install",
        fault: {
          id: "delay-snapshot",
          scope: "control",
          operation: "snapshot",
          mode: "delay",
          count: 1,
          delayMs: 100,
        },
      },
      { expectedGeneration: seeded.generation, leaseId },
    );
    const awaitedSnapshot = client.command(
      { type: "snapshot" },
      { expectedGeneration: faulted.generation, leaseId },
    );
    await Bun.sleep(20);
    const reset = await client.command(
      { type: "reset", receipt },
      { expectedGeneration: faulted.generation, leaseId },
    );
    expect(await rejectionCode(awaitedSnapshot)).toBe("STALE_GENERATION");

    const reseeded = await client.command(
      {
        type: "seed",
        manifest: {
          version: 1,
          namespace: "concurrency",
          manifestId: "manifest-concurrency-2",
          domains: {},
        },
      },
      { expectedGeneration: reset.generation, leaseId },
    );
    const concurrent = await Promise.allSettled([
      client.command(
        { type: "time.advance", milliseconds: 1 },
        { expectedGeneration: reseeded.generation, leaseId },
      ),
      client.command(
        { type: "time.advance", milliseconds: 2 },
        { expectedGeneration: reseeded.generation, leaseId },
      ),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe(
      "STALE_GENERATION",
    );
  });

  test("reports auth, crash, restart, and stale-generation failures without fabricated success", async () => {
    const first = await startAuthority();
    const unauthorized = await fetch(first.client.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        commandId: "auth",
        command: { type: "health" },
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED" },
    });

    const health = await first.client.command({ type: "health" });
    const lease = await first.client.command(
      { type: "lease.acquire", owner: "crash-test", ttlMs: 60_000 },
      { expectedGeneration: health.generation },
    );
    first.child.kill("SIGKILL");
    expect(await first.child.exited).not.toBe(0);
    expect(await rejectionCode(first.client.command({ type: "health" }))).toBe(
      "COMMAND_FAILED",
    );

    const restarted = await startAuthority();
    const restartedHealth = await restarted.client.command({ type: "health" });
    expect(restartedHealth.generation).toBe(0);
    expect(
      await rejectionCode(
        restarted.client.command(
          { type: "snapshot" },
          {
            expectedGeneration: lease.generation,
            leaseId: (lease.data as { leaseId: string }).leaseId,
          },
        ),
      ),
    ).toBe("STALE_GENERATION");
  });
});

/**
 * Exercises snapshot admission through a real Node HTTP socket so the shared
 * mutation drain, per-transfer timeout exemption, and standby read behavior
 * are verified without a mocked request boundary.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  getSnapshotCaptureBarrier,
  type IAgentRuntime,
  type SnapshotMutationLease,
} from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  admitHttpRuntimeRequest,
  applySnapshotTransferTimeoutPolicy,
  snapshotUpgradeUnavailableStatus,
} from "./snapshot-capture-admission.ts";

const servers = new Set<http.Server>();

async function listen(server: http.Server): Promise<string> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  servers.clear();
});

describe("snapshot capture transport admission", () => {
  test("drains a real accepted HTTP mutation and keeps standby reads available", async () => {
    const runtime = {} as IAgentRuntime;
    const barrier = getSnapshotCaptureBarrier(runtime);
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const server = http.createServer((req, res) => {
      void (async () => {
        const method = req.method ?? "GET";
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        applySnapshotTransferTimeoutPolicy(req, res, pathname, 1_000);
        let admission: SnapshotMutationLease | undefined;
        try {
          admission = admitHttpRuntimeRequest(runtime, method, pathname);
        } catch {
          res.statusCode = 503;
          res.end("unavailable");
          return;
        }
        try {
          if (pathname === "/api/read-hold") {
            markStarted?.();
            await hold;
          }
          res.statusCode = 200;
          res.end(String(req.socket.timeout));
        } finally {
          admission?.release();
        }
      })().catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
    });
    const origin = await listen(server);

    const mutationResponse = fetch(`${origin}/api/read-hold`);
    await started;
    barrier.beginDraining();
    let drained = false;
    const drain = barrier.waitForDrain().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(barrier.status()).toMatchObject({
      activeMutations: 1,
      phase: "draining",
    });

    releaseHold?.();
    expect((await mutationResponse).status).toBe(200);
    await drain;
    barrier.beginCapturing();
    barrier.enterStandby();

    expect((await fetch(`${origin}/`)).status).toBe(200);
    expect((await fetch(`${origin}/api/status`)).status).toBe(200);
    expect((await fetch(`${origin}/api/accounts/oauth/callback`)).status).toBe(
      503,
    );
    expect((await fetch(`${origin}/api/ingest/share?consume=1`)).status).toBe(
      503,
    );
    expect(snapshotUpgradeUnavailableStatus(runtime)).toMatchObject({
      activeMutations: 0,
      phase: "standby",
    });
    const snapshotResponse = await fetch(`${origin}/api/snapshot`, {
      method: "POST",
    });
    expect(snapshotResponse.status).toBe(200);
    expect(await snapshotResponse.text()).toBe("0");
  });

  test("exempts only the transfer while the next keep-alive request regains its body deadline", async () => {
    const sockets: http.IncomingMessage["socket"][] = [];
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      sockets.push(req.socket);
      applySnapshotTransferTimeoutPolicy(req, res, pathname, 75);
      void (async () => {
        try {
          for await (const _chunk of req) {
            // Reading the real socket body is the behavior under test.
          }
        } catch {
          return;
        }
        if (!res.writableEnded) res.end("ok");
      })();
    });
    server.requestTimeout = 0;
    server.headersTimeout = 1_000;
    server.timeout = 0;
    const origin = new URL(await listen(server));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    const slowPost = async (
      pathname: string,
      bodyDelayMs: number,
    ): Promise<number> =>
      await new Promise<number>((resolve, reject) => {
        let settled = false;
        const request = http.request(
          {
            agent,
            headers: { "Content-Length": "2" },
            host: origin.hostname,
            method: "POST",
            path: pathname,
            port: origin.port,
          },
          (response) => {
            response.resume();
            response.once("end", () => {
              settled = true;
              resolve(response.statusCode ?? 0);
            });
          },
        );
        request.once("error", (error) => {
          if (!settled) reject(error);
        });
        request.write("a");
        setTimeout(() => {
          if (!request.destroyed) request.end("b");
        }, bodyDelayMs);
      });

    expect(await slowPost("/api/restore", 150)).toBe(200);
    expect(await slowPost("/api/mutate", 150)).toBe(408);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]).toBe(sockets[0]);
    agent.destroy();
  });
});

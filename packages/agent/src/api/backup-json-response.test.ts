/**
 * Exercises the real HTTP transport used to stream large agent backup JSON
 * without substituting a response mock for Node's buffering behavior.
 */

import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBackupStateData } from "../services/agent-backup.ts";
import { writeAgentBackupJsonResponse } from "./backup-json-response.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function serveSnapshot(
  snapshot: AgentBackupStateData,
): Promise<Response> {
  const server = http.createServer((_req, res) => {
    void writeAgentBackupJsonResponse(res, snapshot);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return fetch(`http://127.0.0.1:${address.port}`);
}

function snapshotWithConfig(
  config: Record<string, unknown>,
): AgentBackupStateData {
  return {
    memories: [],
    config,
    workspaceFiles: {},
    manifest: {
      schemaVersion: 1,
      format: "elizaos.agent-backup",
      createdAt: "2026-08-13T00:00:00.000Z",
      agentId: "00000000-0000-4000-8000-000000000000",
      components: {
        database: { kind: "none", reason: "test", sha256: "db" },
        media: {
          kind: "file-set",
          rootLabel: "state-dir",
          files: [],
          sha256: "media",
        },
        vault: {
          kind: "file-set",
          rootLabel: "state-dir",
          files: [],
          sha256: "vault",
        },
        character: { runtimeCharacter: {}, sha256: "character" },
        stateFiles: {
          kind: "file-set",
          rootLabel: "state-dir",
          files: [],
          sha256: "state",
        },
      },
      integrity: { componentHashes: {} },
    },
  };
}

describe("writeAgentBackupJsonResponse", () => {
  it("round-trips a multi-chunk backup response through a real HTTP server", async () => {
    const largeValue = "backup-data-".repeat(300_000);
    const snapshot = snapshotWithConfig({ largeValue });

    const response = await serveSnapshot(snapshot);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual(snapshot);
  });

  it("preserves escaping, surrogate pairs, arrays, and JSON omission rules", async () => {
    const boundaryPrefix = "x".repeat(256 * 1024 - 1);
    const snapshot = snapshotWithConfig({
      text: `${boundaryPrefix}😀\n"done`,
      array: [undefined, Number.NaN, true],
      omitted: undefined,
      date: new Date("2026-08-13T00:00:00.000Z"),
    });

    const response = await serveSnapshot(snapshot);
    const parsed = (await response.json()) as AgentBackupStateData;

    expect(parsed.config).toEqual({
      text: `${boundaryPrefix}😀\n"done`,
      array: [null, null, true],
      date: "2026-08-13T00:00:00.000Z",
    });
  });

  it("settles with a typed rejection when the client disconnects during backpressure", async () => {
    // Real transport: the client reads a few KB, pauses while the server is
    // backpressured (write() returned false), then destroys its socket. The
    // drain event never arrives after 'close', so the writer must reject via
    // the close race instead of parking on `once(res, "drain")` forever.
    const snapshot = snapshotWithConfig({
      blob: "0123456789abcdef".repeat(1024 * 1024),
    });
    const server = http.createServer((_req, res) => {
      void writeAgentBackupJsonResponse(res, snapshot).then(
        () => outcome.resolve({ kind: "resolved" }),
        (err: unknown) =>
          outcome.resolve({
            kind: "rejected",
            name: (err as Error)?.name,
            code: (err as { code?: string })?.code,
          }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");

    const outcome = Promise.withResolvers<{
      kind: "resolved" | "rejected";
      name?: string;
      code?: string;
    }>();

    const socket = net.connect(address.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      "POST /api/snapshot HTTP/1.1\r\nHost: test\r\nContent-Length: 0\r\n\r\n",
    );

    let received = 0;
    let backpressured = false;
    socket.on("data", (chunk) => {
      received += chunk.length;
      // Stop reading so the server's write buffer fills and res.write()
      // starts returning false — a genuine backpressure state.
      if (received > 16 * 1024) {
        backpressured = true;
        socket.pause();
      }
    });

    await vi.waitFor(
      () => {
        if (!backpressured) throw new Error("backpressure not reached yet");
      },
      { timeout: 10_000, interval: 50 },
    );
    socket.destroy();

    await expect(
      Promise.race([
        outcome.promise,
        new Promise<"hang">((resolve) =>
          setTimeout(() => resolve("hang"), 5_000),
        ),
      ]),
    ).resolves.toEqual({
      kind: "rejected",
      name: "AgentBackupClientDisconnectedError",
      code: "AGENT_BACKUP_CLIENT_DISCONNECTED",
    });
  });
});

import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { captureBackendLogs } from "./backend-log-capture.mjs";

/** @type {import("node:http").Server[]} */
const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("captureBackendLogs", () => {
  it("returns a bounded timeout instead of hanging on a non-responsive backend", async () => {
    const apiBase = await listen(
      createServer((_req, _res) => {
        // Intentionally never respond; the capture helper must abort.
      }),
    );

    const startedAt = Date.now();
    const result = await captureBackendLogs({ apiBase, timeoutMs: 50 });
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({
      ok: false,
      reason: "timeout after 50ms",
    });
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

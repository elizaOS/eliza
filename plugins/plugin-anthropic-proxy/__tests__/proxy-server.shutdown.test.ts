/**
 * Verifies that ProxyServer.stop() terminates deterministically even when the
 * local HTTP server has an active keep-alive connection. Before the fix,
 * server.close() only stopped accepting new connections but never fired its
 * callback until every existing socket closed on its own — causing teardown
 * to hang until the test runner timed out.
 */

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

describe("ProxyServer.stop() determinism", () => {
  let stoppedServer: { stop: () => Promise<void>; getUrl: () => string } | null = null;

  afterEach(async () => {
    if (stoppedServer) {
      await stoppedServer.stop().catch(() => undefined);
      stoppedServer = null;
    }
  });

  it("resolves stop() promptly while a keep-alive connection is open", async () => {
    const { ProxyServer } = await import("../src/proxy/server.js");
    const server = new ProxyServer({
      port: 0,
      bindHost: "127.0.0.1",
      envToken: "test-token",
    });
    await server.start();
    stoppedServer = null;

    // Open a keep-alive connection but do not close it.
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${server.getUrl()}/health`, { agent }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });

    // stop() must resolve within 2 s even though the keep-alive socket is
    // still technically open from the agent's perspective.
    await expect(
      Promise.race([
        server.stop(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("stop() timed out")), 2000)
        ),
      ])
    ).resolves.toBeUndefined();

    agent.destroy();
  });
});

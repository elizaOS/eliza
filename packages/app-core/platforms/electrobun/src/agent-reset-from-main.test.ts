/**
 * Integration coverage for `postAgentResetFromMain`.
 *
 * The poster (`agent-reset-from-main.ts`) is the main-process path Settings /
 * menu reset uses: it probes candidate API bases with `GET /api/status`, picks
 * the first reachable one, then POSTs `/api/agent/reset`. We drive the REAL
 * poster against a REAL `node:http` server that serves those two endpoints, so
 * the candidate picker, the real `fetch`, and the response handling are all
 * exercised over a real loopback port.
 *
 * A full `startApiServer` boot is not used here: the electrobun vitest lane
 * (`vitest.electrobun.config.ts`) only aliases `@elizaos/app-core` / `core` /
 * `shared` to src and stubs `electrobun/bun`; it does NOT alias `@elizaos/agent`
 * or `@elizaos/plugin-sql`, so a real runtime cannot boot under it. A focused
 * real-HTTP stub of `/api/status` + `/api/agent/reset` is the correct shape for
 * this lane and proves the poster's contract end-to-end.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postAgentResetFromMain } from "./agent-reset-from-main";

interface ResetStubServer {
  base: string;
  statusHits: string[];
  resetHits: Array<{ method: string; body: string }>;
  close: () => Promise<void>;
}

async function startResetStubServer(options?: {
  resetStatus?: number;
  resetBody?: unknown;
}): Promise<ResetStubServer> {
  const statusHits: string[] = [];
  const resetHits: Array<{ method: string; body: string }> = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/api/status") {
      statusHits.push(url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "running", agentName: "stub" }));
      return;
    }
    if (req.method === "POST" && url === "/api/agent/reset") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        resetHits.push({
          method: req.method ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(options?.resetStatus ?? 200, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(options?.resetBody ?? { ok: true }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("reset stub server did not bind");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    statusHits,
    resetHits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("postAgentResetFromMain (real HTTP)", () => {
  let stub: ResetStubServer | null = null;
  const prevApiBase = process.env.ELIZA_DESKTOP_API_BASE;
  const prevApiPort = process.env.ELIZA_API_PORT;
  const prevPort = process.env.ELIZA_PORT;

  beforeEach(() => {
    // Keep the env-derived candidate pointed at a port nothing listens on so the
    // only reachable base is the explicit override we pass in.
    process.env.ELIZA_DESKTOP_API_BASE = "http://127.0.0.1:1";
    delete process.env.ELIZA_API_PORT;
    delete process.env.ELIZA_PORT;
  });

  afterEach(async () => {
    await stub?.close();
    stub = null;
    if (prevApiBase === undefined) delete process.env.ELIZA_DESKTOP_API_BASE;
    else process.env.ELIZA_DESKTOP_API_BASE = prevApiBase;
    if (prevApiPort === undefined) delete process.env.ELIZA_API_PORT;
    else process.env.ELIZA_API_PORT = prevApiPort;
    if (prevPort === undefined) delete process.env.ELIZA_PORT;
    else process.env.ELIZA_PORT = prevPort;
  });

  it("reaches /api/agent/reset on the override base and returns ok", async () => {
    stub = await startResetStubServer();

    const result = await postAgentResetFromMain({
      apiBaseOverride: stub.base,
      resetTimeoutMs: 5000,
    });

    expect(result).toEqual({ ok: true });
    // The picker probed the reachable base via GET /api/status...
    expect(stub.statusHits.length).toBeGreaterThan(0);
    // ...then POSTed the reset to the same base.
    expect(stub.resetHits).toHaveLength(1);
    expect(stub.resetHits[0]?.method).toBe("POST");
    expect(stub.resetHits[0]?.body).toBe("{}");
  });

  it("selects the reachable override even when an env candidate is dead", async () => {
    stub = await startResetStubServer();
    // ELIZA_DESKTOP_API_BASE (port 1, dead) is also a candidate; the override is
    // pushed first and is the only one that answers /api/status, so it wins.
    const result = await postAgentResetFromMain({
      apiBaseOverride: stub.base,
      resetTimeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(stub.resetHits).toHaveLength(1);
  });

  it("surfaces an HTTP error from /api/agent/reset", async () => {
    stub = await startResetStubServer({
      resetStatus: 500,
      resetBody: { error: "boom" },
    });

    const result = await postAgentResetFromMain({
      apiBaseOverride: stub.base,
      resetTimeoutMs: 5000,
    });

    expect(result).toEqual({ ok: false, error: "boom" });
    expect(stub.resetHits).toHaveLength(1);
  });

  it("fails when no candidate API base is reachable", async () => {
    // No stub server; override points at a dead port.
    const result = await postAgentResetFromMain({
      apiBaseOverride: "http://127.0.0.1:1",
      resetTimeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("API");
    }
  });
});

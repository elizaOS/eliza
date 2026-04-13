import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DEFAULT_CONFIG } from "../types";
import { __shutdownForTests } from "../runtimeManager";
import { createApiServer } from "../server";

async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

describe("capacitor backend HTTP API", () => {
  let server: Server | null = null;
  let baseUrl = "";
  let dataDir = "";

  beforeEach(async () => {
    dataDir = await makeTempDir("eliza-capacitor-http-");
    process.env.LOCALDB_DATA_DIR = dataDir;
    await __shutdownForTests();

    server = createApiServer();
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await __shutdownForTests();
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
    server = null;
    baseUrl = "";
  });

  it("health check works", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toContain("eliza");
  });

  it("chat produces a response and history includes it", async () => {
    // reset
    await fetch(`${baseUrl}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: DEFAULT_CONFIG }),
    });

    const chatRes = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: DEFAULT_CONFIG, text: "hello" }),
    });
    expect(chatRes.status).toBe(200);
    const chatBody = (await chatRes.json()) as {
      responseText: string;
      effectiveMode: string;
    };
    expect(chatBody.responseText.trim().length).toBeGreaterThan(0);

    const histRes = await fetch(`${baseUrl}/history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: DEFAULT_CONFIG }),
    });
    const histBody = (await histRes.json()) as {
      history: Array<{ role: string; text: string }>;
    };
    expect(histBody.history.length).toBeGreaterThanOrEqual(2);
    expect(histBody.history.some((m) => m.role === "assistant")).toBe(true);
  });
});


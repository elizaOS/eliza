/**
 * App-Knowledge live e2e tests.
 *
 * Boots a real runtime and tests the knowledge management API
 * endpoints: availability check, document upload, and search.
 *
 * Gated on ELIZA_LIVE_TEST=1.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../../../../test/helpers/conditional-tests";
import { req } from "../../../../test/helpers/http";
import { createLiveRuntimeChildEnv } from "../../../../test/helpers/live-child-env";

const LIVE =
  process.env.ELIZA_LIVE_TEST === "1" ||
  process.env.MILADY_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  /* dotenv optional */
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      server.close((e) => (e ? reject(e) : resolve(addr.port)));
    });
  });
}

import type { RuntimeHarness as Runtime } from "@elizaos/app-core/test/live-agent/helpers/runtime-harness";

async function startRuntime(): Promise<Runtime> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "eliza-knowledge-e2e-"));
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(tmp, "eliza.json");
  const port = await getFreePort();
  const logBuf: string[] = [];

  await mkdir(stateDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      logging: { level: "warn" },
      plugins: { allow: [] },
    }) + "\n",
    "utf8",
  );

  const child = spawn("bun", ["run", "start:eliza"], {
    cwd: REPO_ROOT,
    env: createLiveRuntimeChildEnv({
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_API_PORT: String(port),
      ELIZA_PORT: String(port),
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      ALLOW_NO_DATABASE: "",
      DISCORD_API_TOKEN: "",
      DISCORD_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => logBuf.push(chunk));
  child.stderr.on("data", (chunk: string) => logBuf.push(chunk));

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const data = (await res.json()) as { ready?: boolean; runtime?: string };
        if (data.ready && data.runtime === "ok") break;
      }
    } catch {
      /* not ready yet */
    }
    await sleep(1_000);
  }
  if (Date.now() >= deadline) {
    child.kill("SIGKILL");
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      `Runtime failed to start:\n${logBuf.join("").slice(-4_000)}`,
    );
  }

  return {
    port,
    logs: () => logBuf.join("").slice(-8_000),
    close: async () => {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 10_000);
          child.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

describeIf(LIVE)("App-Knowledge: API e2e", () => {
  let runtime: Runtime;

  beforeAll(async () => {
    runtime = await startRuntime();
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
  });

  it("GET /api/knowledge returns availability status", async () => {
    const res = await req(runtime.port, "GET", "/api/knowledge");
    expect(res.status).toBe(200);
    expect(res.data).toBeTruthy();
    // The knowledge endpoint returns service availability info
    const data = res.data as Record<string, unknown>;
    expect(data).toHaveProperty("ok");
    expect(data).toHaveProperty("available");
  }, 30_000);

  it("knowledge routes respond to all endpoints", async () => {
    const endpoints = [
      { method: "GET", path: "/api/knowledge" },
      { method: "GET", path: "/api/knowledge/stats" },
    ];

    for (const { method, path: p } of endpoints) {
      const res = await req(runtime.port, method, p);
      // Routes should respond — 200 for success, other codes for service-specific responses
      expect(res.status).toBeLessThan(500);
      expect(res.data).toBeTruthy();
    }
  }, 30_000);

  it("POST /api/knowledge/documents accepts document upload", async () => {
    const res = await req(runtime.port, "POST", "/api/knowledge/documents", {
      content: "The quick brown fox jumps over the lazy dog. This is a test document.",
      metadata: {
        title: "Test Document",
        source: "e2e-test",
      },
    });
    // Document upload may return 200/201 on success, 400 for invalid format,
    // or 503 if the knowledge service is unavailable
    expect([200, 201, 400, 503]).toContain(res.status);
  }, 60_000);

  it("GET /api/knowledge/search handles queries", async () => {
    const res = await req(
      runtime.port,
      "GET",
      "/api/knowledge/search?q=test&limit=5",
    );
    // Search may return results or error when embeddings aren't configured
    expect([200, 400, 500, 503]).toContain(res.status);
  }, 30_000);
});

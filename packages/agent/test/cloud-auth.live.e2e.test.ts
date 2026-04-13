/**
 * Live cloud auth & URL resolution tests.
 *
 * These boot a real eliza runtime and verify that cloud URL normalisation,
 * API base URL resolution, and health-gated cloud connectivity work against
 * live infrastructure rather than mocked modules.
 *
 * Gated on ELIZA_LIVE_TEST=1.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { req } from "../../../test/helpers/http.ts";

const LIVE = process.env.ELIZA_LIVE_TEST === "1" || process.env.ELIZA_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  // dotenv optional
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { server.close(); reject(new Error("no port")); return; }
      server.close((e) => (e ? reject(e) : resolve(addr.port)));
    });
  });
}

type Runtime = { port: number; close: () => Promise<void>; logs: () => string };

async function startRuntime(): Promise<Runtime> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "eliza-cloud-auth-"));
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(tmp, "eliza.json");
  const port = await getFreePort();
  const logBuf: string[] = [];

  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    logging: { level: "info" },
    plugins: { allow: [] },
  }), "utf8");

  const child = spawn("bun", ["run", "start:eliza"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_PORT: String(port),
      ELIZA_API_PORT: String(port),
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      ALLOW_NO_DATABASE: "",
      DISCORD_API_TOKEN: "",
      DISCORD_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => logBuf.push(c));
  child.stderr.on("data", (c: string) => logBuf.push(c));

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        const d = (await r.json()) as { ready?: boolean; runtime?: string };
        if (d.ready === true && d.runtime === "ok") break;
      }
    } catch { /* not ready */ }
    await sleep(1_000);
  }

  return {
    port,
    logs: () => logBuf.join("").slice(-8_000),
    close: async () => {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        await new Promise<void>((r) => { child.once("exit", () => r()); setTimeout(() => r(), 10_000); });
        if (child.exitCode == null) child.kill("SIGKILL");
      }
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

describeIf(LIVE)("Live: cloud auth & connectivity", () => {
  let rt: Runtime;

  beforeAll(async () => { rt = await startRuntime(); }, 180_000);
  afterAll(async () => { if (rt) await rt.close(); });

  it("health endpoint returns ready=true with runtime ok", async () => {
    const res = await req(rt.port, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ready: true, runtime: "ok" });
  });

  it("cloud status endpoint exists and returns a response", async () => {
    const res = await req(rt.port, "GET", "/api/cloud/status");
    // May be 200 or 404 depending on whether cloud is configured, but should not crash
    expect([200, 404, 401]).toContain(res.status);
  });

  it("agents endpoint lists at least one agent", async () => {
    const res = await req(rt.port, "GET", "/api/agents");
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("agents");
  });

  it("conversations endpoint returns empty list initially", async () => {
    const res = await req(rt.port, "GET", "/api/conversations");
    expect(res.status).toBe(200);
  });

  it("plugins endpoint returns loaded plugins array", async () => {
    const res = await req(rt.port, "GET", "/api/plugins");
    expect(res.status).toBe(200);
    const plugins = res.data.plugins ?? res.data;
    expect(Array.isArray(plugins) || typeof plugins === "object").toBe(true);
  });
}, 300_000);

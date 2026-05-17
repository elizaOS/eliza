/**
 * Live connector health tests.
 *
 * Boots a real eliza runtime and exercises the connector health/status
 * endpoints for Discord, Telegram, Signal, and other connectors.
 *
 * Replaces deleted mock tests for discord-connector, telegram-connector, etc.
 * Gated on ELIZA_LIVE_TEST=1.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";
import { req } from "../helpers/http.ts";
import { createLiveRuntimeChildEnv } from "../helpers/live-child-env.ts";

const LIVE = process.env.ELIZA_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);

try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  /* dotenv optional */
}

const CONNECTOR_CASES = [
  {
    name: "discord",
    pluginId: "discord",
    tokenKeys: ["DISCORD_BOT_TOKEN", "DISCORD_API_TOKEN"],
  },
  {
    name: "telegram",
    pluginId: "telegram",
    tokenKeys: ["TELEGRAM_BOT_TOKEN"],
  },
] as const;
const CONFIGURED_CONNECTORS = CONNECTOR_CASES.filter((connector) =>
  connector.tokenKeys.some((key) => process.env[key]?.trim()),
);
const LIVE_CONNECTOR_SUITE_ENABLED = LIVE && CONFIGURED_CONNECTORS.length > 0;

if (!LIVE_CONNECTOR_SUITE_ENABLED) {
  const warnings = [
    !LIVE ? "set ELIZA_LIVE_TEST=1" : null,
    CONFIGURED_CONNECTORS.length === 0
      ? "provide at least one real connector token (Discord or Telegram) to run connector live tests"
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  console.info(
    `[connector-health-live] suite skipped until setup is complete: ${warnings.join(" | ")}`,
  );
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

import type { RuntimeHarness as Runtime } from "./helpers/runtime-harness";

async function startRuntime(): Promise<Runtime> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "eliza-connectors-"));
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(tmp, "eliza.json");
  const port = await getFreePort();
  const logBuf: string[] = [];
  const allowPlugins = CONFIGURED_CONNECTORS.map(
    (connector) => connector.pluginId,
  );

  await mkdir(stateDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      logging: { level: "info" },
      plugins: { allow: allowPlugins },
    }),
    "utf8",
  );

  const child = spawn("bun", ["run", "start:eliza"], {
    cwd: REPO_ROOT,
    env: createLiveRuntimeChildEnv({
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_PORT: String(port),
      ELIZA_API_PORT: String(port),
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      ALLOW_NO_DATABASE: "",
    }),
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
    } catch {
      /* not ready */
    }
    await sleep(1_000);
  }

  return {
    port,
    logs: () => logBuf.join("").slice(-8_000),
    close: async () => {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        await new Promise<void>((r) => {
          child.once("exit", () => r());
          setTimeout(() => r(), 10_000);
        });
        if (child.exitCode == null) child.kill("SIGKILL");
      }
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

describeIf(LIVE_CONNECTOR_SUITE_ENABLED)(
  "Live: connector health endpoints",
  () => {
    let rt: Runtime;

    beforeAll(async () => {
      rt = await startRuntime();
    }, 180_000);
    afterAll(async () => {
      if (rt) await rt.close();
    });

    it("lists each configured real connector in the live runtime", async () => {
      const res = await req(rt.port, "GET", "/api/connectors");
      expect(res.status).toBe(200);
      const connectors = Array.isArray(res.data)
        ? (res.data as Array<Record<string, unknown>>)
        : Array.isArray(res.data.connectors)
          ? (res.data.connectors as Array<Record<string, unknown>>)
          : [];
      expect(connectors.length).toBeGreaterThan(0);

      for (const connector of CONFIGURED_CONNECTORS) {
        expect(
          connectors.some((entry) => {
            const id = String(entry.id ?? entry.name ?? "").toLowerCase();
            const label = String(entry.label ?? "").toLowerCase();
            return (
              id.includes(connector.name) || label.includes(connector.name)
            );
          }),
        ).toBe(true);
      }
    });

    it("runtime does not crash when queried for unknown connector", async () => {
      const res = await req(
        rt.port,
        "GET",
        "/api/connectors/nonexistent-connector",
      );
      expect(res.status).toBe(404);
    });
  },
  300_000,
);

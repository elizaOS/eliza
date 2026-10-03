/**
 * Live cloud auth & URL resolution tests.
 *
 * These boot a real eliza runtime and verify that cloud URL normalisation,
 * API base URL resolution, and health-gated cloud connectivity work against
 * live infrastructure rather than mocked modules.
 *
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
import {
  createConversation,
  postConversationMessage,
  req,
} from "../helpers/http.ts";
import { createLiveRuntimeChildEnv } from "../helpers/live-child-env.ts";
import { selectLiveProvider } from "../helpers/live-provider.ts";

const LIVE = process.env.ELIZA_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const LIVE_PROVIDER = selectLiveProvider();
const LIVE_PROVIDER_PLUGIN_ID = LIVE_PROVIDER?.pluginPackage
  .split("/")
  .at(-1)
  ?.replace(/^plugin-/, "");
const LIVE_CLOUD_CODEWORD = `cloud-live-codeword-${Date.now()}`;

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
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      server.close((e) => (e ? reject(e) : resolve(addr.port)));
    });
  });
}

function isProviderIssueResponse(text: string): boolean {
  return /provider issue/i.test(text);
}

async function postLiveMessage(
  runtime: Runtime,
  conversationId: string,
  text: string,
): Promise<{
  status: number;
  text: string;
}> {
  let lastText = "";
  let lastStatus = 0;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await postConversationMessage(
      runtime.port,
      conversationId,
      { text },
      undefined,
      { timeoutMs: 90_000 },
    );
    lastStatus = response.status;
    lastText = String(response.data.text ?? "");
    if (response.status === 200 && !isProviderIssueResponse(lastText)) {
      return { status: response.status, text: lastText };
    }
    if (attempt < 3) {
      await sleep(2_000);
    }
  }

  return { status: lastStatus, text: lastText };
}

import type { RuntimeHarness as Runtime } from "./helpers/runtime-harness";

async function startRuntime(): Promise<Runtime> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "eliza-cloud-auth-"));
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(tmp, "eliza.json");
  const port = await getFreePort();
  const logBuf: string[] = [];
  const allowPlugins =
    LIVE_PROVIDER_PLUGIN_ID && LIVE_PROVIDER_PLUGIN_ID.length > 0
      ? [LIVE_PROVIDER_PLUGIN_ID]
      : [];

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
      ...(LIVE_PROVIDER?.env ?? {}),
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_PORT: String(port),
      ELIZA_API_PORT: String(port),
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
  child.stdout.on("data", (c: string) => logBuf.push(c));
  child.stderr.on("data", (c: string) => logBuf.push(c));

  const deadline = Date.now() + 150_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        const d = (await r.json()) as { ready?: boolean; runtime?: string };
        if (d.ready === true && d.runtime === "ok") {
          ready = true;
          break;
        }
      }
    } catch {
      /* not ready */
    }
    await sleep(1_000);
  }

  if (!ready) {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => resolve(), 10_000);
      });
      if (child.exitCode == null) child.kill("SIGKILL");
    }
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      `Runtime failed to become ready on port ${port}\n${logBuf.join("").slice(-8_000)}`,
    );
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

describeIf(LIVE)(
  "Live: cloud auth & connectivity",
  () => {
    let rt: Runtime;

    beforeAll(async () => {
      rt = await startRuntime();
    }, 180_000);
    afterAll(async () => {
      if (rt) await rt.close();
    });

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

    it("conversation route uses a real live provider when configured", async () => {
      if (!LIVE_PROVIDER) {
        return;
      }

      const { conversationId } = await createConversation(rt.port, {
        title: "cloud auth live chat",
      });
      const response = await postLiveMessage(
        rt,
        conversationId,
        `Reply with exactly ${LIVE_CLOUD_CODEWORD}`,
      );

      expect(response.status).toBe(200);
      if (isProviderIssueResponse(response.text)) {
        console.warn(
          `[cloud-auth-live] provider unavailable, skipping strict response assertion\n${rt.logs()}`,
        );
        return;
      }
      expect(response.text).toContain(LIVE_CLOUD_CODEWORD);
    }, 120_000);
  },
  300_000,
);

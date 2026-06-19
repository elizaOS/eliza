/**
 * Live database & conversation roundtrip tests.
 *
 * Boots a real eliza runtime and exercises the real database layer:
 * - Create, list, get conversations
 * - Post messages and retrieve history
 * - Memory persistence
 *
 * Replaces deleted mock tests for database-api, cloud-persistence, etc.
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
const LIVE_DB_CODEWORD = `db-live-codeword-${Date.now()}`;

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
  const tmp = await mkdtemp(path.join(os.tmpdir(), "eliza-db-live-"));
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
  "Live: database & conversation roundtrip",
  () => {
    let rt: Runtime;

    beforeAll(async () => {
      rt = await startRuntime();
    }, 180_000);
    afterAll(async () => {
      if (rt) await rt.close();
    });

    it("creates a conversation through the real API", async () => {
      const res = await createConversation(rt.port, { title: "live db test" });
      expect(res.status).toBe(200);
      expect(res.conversationId).toBeTruthy();
    });

    it("lists conversations after creation", async () => {
      await createConversation(rt.port, { title: "list test" });
      const res = await req(rt.port, "GET", "/api/conversations");
      expect(res.status).toBe(200);
      const convos = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data.conversations)
          ? res.data.conversations
          : [];
      expect(convos.length).toBeGreaterThanOrEqual(1);
    });

    it("posts a message and retrieves it from history", async () => {
      const { conversationId } = await createConversation(rt.port, {
        title: "message roundtrip",
      });

      const msgRes = LIVE_PROVIDER
        ? await postLiveMessage(
            rt,
            conversationId,
            `Reply with exactly ${LIVE_DB_CODEWORD}`,
          )
        : await postLiveMessage(
            rt,
            conversationId,
            "Hello from the live database test",
          );
      expect(msgRes.status).toBe(200);
      if (LIVE_PROVIDER) {
        const text = msgRes.text;
        if (isProviderIssueResponse(text)) {
          console.warn(
            `[database-conversation-live] provider unavailable, skipping strict assistant assertion\n${rt.logs()}`,
          );
        } else {
          expect(text.length).toBeGreaterThan(0);
          expect(text).toContain(LIVE_DB_CODEWORD);
        }
      }

      const histRes = await req(
        rt.port,
        "GET",
        `/api/conversations/${conversationId}/messages`,
      );
      expect(histRes.status).toBe(200);
      const messages = Array.isArray(histRes.data.messages)
        ? (histRes.data.messages as Array<{ role?: unknown; text?: unknown }>)
        : [];
      expect(messages.length).toBeGreaterThan(0);
      expect(
        messages.some(
          (message) =>
            message.role === "user" && typeof message.text === "string",
        ),
      ).toBe(true);
      if (LIVE_PROVIDER && !isProviderIssueResponse(msgRes.text)) {
        expect(
          messages.some(
            (message) =>
              message.role === "assistant" &&
              typeof message.text === "string" &&
              message.text.includes(LIVE_DB_CODEWORD),
          ),
        ).toBe(true);
      }
    });

    it("agents endpoint returns agent metadata with database state", async () => {
      const res = await req(rt.port, "GET", "/api/agents");
      expect(res.status).toBe(200);
      const agents = res.data.agents ?? res.data;
      expect(agents).toBeTruthy();
    });
  },
  300_000,
);

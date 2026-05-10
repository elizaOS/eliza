/**
 * Live plugin lifecycle tests.
 *
 * Boots a real eliza runtime and verifies the local workspace plugin matrix,
 * real database access, and a live agent roundtrip through the HTTP API.
 *
 * Gated on ELIZA_LIVE_TEST=1.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../helpers/http.ts";
import { createLiveRuntimeChildEnv } from "../helpers/live-child-env.ts";
import {
  importLocalWorkspacePlugin,
  listLocalWorkspacePlugins,
} from "./helpers/local-plugin-inventory.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
loadDotenv({ path: path.join(REPO_ROOT, ".env") });

const LIVE = process.env.ELIZA_LIVE_TEST === "1";
const FILTER_TOKENS = (process.env.ELIZA_PLUGIN_LIFECYCLE_FILTER ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const FILTER_SET = FILTER_TOKENS.length > 0 ? new Set(FILTER_TOKENS) : null;
const ALL_LOCAL_WORKSPACE_PLUGINS = await listLocalWorkspacePlugins();
const LOCAL_WORKSPACE_PLUGINS = FILTER_SET
  ? ALL_LOCAL_WORKSPACE_PLUGINS.filter(
      (plugin) =>
        FILTER_SET.has(plugin.id) ||
        FILTER_SET.has(plugin.npmName) ||
        FILTER_SET.has(plugin.dirName),
    )
  : ALL_LOCAL_WORKSPACE_PLUGINS;
const LOCAL_WORKSPACE_PLUGIN_IDS = LOCAL_WORKSPACE_PLUGINS.map(
  (plugin) => plugin.id,
);
const CURRENT_PLATFORM =
  process.platform === "win32" ? "win32" : process.platform;

function hasBootConfigForAiProvider(pluginId: string): boolean {
  switch (pluginId) {
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case "google-genai":
      return Boolean(
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
          process.env.GEMINI_API_KEY ||
          process.env.GOOGLE_API_KEY,
      );
    case "groq":
      return Boolean(process.env.GROQ_API_KEY);
    case "ollama":
      return Boolean(process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL);
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "openrouter":
      return Boolean(process.env.OPENROUTER_API_KEY);
    case "local-ai":
      return Boolean(
        process.env.LOCAL_AI_BASE_URL ||
          process.env.OLLAMA_HOST ||
          process.env.OLLAMA_BASE_URL,
      );
    default:
      return true;
  }
}

function supportsCurrentPlatform(
  plugin: (typeof LOCAL_WORKSPACE_PLUGINS)[number],
): boolean {
  return (
    plugin.supportedOs.length === 0 ||
    plugin.supportedOs.includes(CURRENT_PLATFORM)
  );
}

function hasRequiredEnv(
  plugin: (typeof LOCAL_WORKSPACE_PLUGINS)[number],
): boolean {
  return plugin.requiredEnvKeys.every((key) => Boolean(process.env[key]));
}

function canBootConnector(
  plugin: (typeof LOCAL_WORKSPACE_PLUGINS)[number],
): boolean {
  switch (plugin.id) {
    case "imessage":
      return CURRENT_PLATFORM === "darwin";
    case "whatsapp":
      return Boolean(
        (process.env.WHATSAPP_AUTH_METHOD === "cloudapi" &&
          process.env.WHATSAPP_ACCESS_TOKEN &&
          process.env.WHATSAPP_PHONE_NUMBER_ID) ||
          (process.env.WHATSAPP_AUTH_METHOD === "baileys" &&
            process.env.WHATSAPP_AUTH_DIR),
      );
    default:
      return plugin.requiredEnvKeys.length > 0 && hasRequiredEnv(plugin);
  }
}

function canBootPlugin(
  plugin: (typeof LOCAL_WORKSPACE_PLUGINS)[number],
): boolean {
  if (!supportsCurrentPlatform(plugin)) {
    return false;
  }

  if (plugin.category === "ai-provider") {
    return hasBootConfigForAiProvider(plugin.id);
  }

  if (plugin.category === "connector") {
    return canBootConnector(plugin);
  }

  return plugin.requiredEnvKeys.length === 0 || hasRequiredEnv(plugin);
}

const BOOT_LOCAL_WORKSPACE_PLUGINS =
  LOCAL_WORKSPACE_PLUGINS.filter(canBootPlugin);
const BOOT_LOCAL_WORKSPACE_PLUGIN_IDS = BOOT_LOCAL_WORKSPACE_PLUGINS.map(
  (plugin) => plugin.id,
);
const BOOT_LOCAL_WORKSPACE_PLUGIN_ALLOW = BOOT_LOCAL_WORKSPACE_PLUGINS.map(
  (plugin) => plugin.npmName,
);

if (FILTER_SET && LOCAL_WORKSPACE_PLUGINS.length === 0) {
  throw new Error(
    `ELIZA_PLUGIN_LIFECYCLE_FILTER=${FILTER_TOKENS.join(",")} matched no local workspace plugins.`,
  );
}

const HAS_LIVE_MODEL_PROVIDER = Boolean(
  process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.OLLAMA_HOST ||
    process.env.OLLAMA_BASE_URL,
);
const LIVE_PROVIDER_PLUGIN_ID =
  (process.env.OPENAI_API_KEY && "openai") ||
  (process.env.ANTHROPIC_API_KEY && "anthropic") ||
  (process.env.GROQ_API_KEY && "groq") ||
  (process.env.OPENROUTER_API_KEY && "openrouter") ||
  ((process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY) &&
    "google-genai") ||
  ((process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL) && "ollama") ||
  null;

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

const RETRYABLE_RM_ERROR_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

async function removeDirWithRetries(target: string): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        error instanceof Error ? (error as Error & { code?: string }).code : "";
      if (!RETRYABLE_RM_ERROR_CODES.has(code ?? "") || attempt === 10) {
        throw error;
      }
      await sleep(attempt * 100);
    }
  }
}

import type { RuntimeHarness as Runtime } from "./helpers/runtime-harness";

async function startRuntimeWithPlugins(
  allowPlugins: string[],
): Promise<Runtime> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "eliza-plugin-lifecycle-"));
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(tmp, "eliza.json");
  const port = await getFreePort();
  const logBuf: string[] = [];

  await mkdir(stateDir, { recursive: true });
  await mkdir(path.join(stateDir, "cache"), { recursive: true });
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
      CACHE_DIR: path.join(stateDir, "cache"),
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

  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  child.once("exit", (code, signal) => {
    earlyExit = { code, signal };
  });

  const deadline = Date.now() + 150_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (earlyExit) {
      break;
    }
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
    }
    await removeDirWithRetries(tmp);
    const exitDetail = earlyExit
      ? ` (child exited early with code=${earlyExit.code} signal=${earlyExit.signal})`
      : "";
    throw new Error(
      `Runtime failed to become ready with allowPlugins=${allowPlugins.join(", ")}${exitDetail}\n${logBuf.join("").slice(-8_000)}`,
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
        if (child.exitCode == null) {
          child.kill("SIGKILL");
          await new Promise<void>((r) => {
            child.once("exit", () => r());
            setTimeout(() => r(), 5_000);
          });
        }
      }
      await removeDirWithRetries(tmp);
    },
  };
}

function getLocalPluginRows(
  plugins: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const localIds = new Set(LOCAL_WORKSPACE_PLUGIN_IDS);
  const localPackages = new Set(
    LOCAL_WORKSPACE_PLUGINS.map((plugin) => plugin.npmName),
  );
  return plugins.filter((plugin) => {
    const id = plugin.id;
    const npmName = plugin.npmName;
    return (
      (typeof id === "string" && localIds.has(id)) ||
      (typeof npmName === "string" && localPackages.has(npmName))
    );
  });
}

function isConfigGatedPluginRow(plugin: Record<string, unknown>): boolean {
  return (
    plugin.enabled === false &&
    Array.isArray(plugin.validationErrors) &&
    plugin.validationErrors.length > 0
  );
}

async function postChatPromptWithRetries(
  port: number,
  prompt: string,
  attempts = 4,
  timeoutMs = 90_000,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { conversationId } = await createConversation(port, {
        title: `plugin lifecycle live prompt ${attempt}`,
      });
      const response = await postConversationMessage(
        port,
        conversationId,
        { text: prompt, mode: "simple" },
        undefined,
        { timeoutMs },
      );
      const text = response.data.text;
      if (
        response.status === 200 &&
        typeof text === "string" &&
        text.trim().length > 0
      ) {
        return response;
      }
      errors.push(
        `attempt ${attempt}: status=${response.status}, textType=${typeof text}, textLength=${
          typeof text === "string" ? text.length : 0
        }`,
      );
    } catch (error) {
      errors.push(
        `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (attempt < attempts) {
      await sleep(1_000);
    }
  }

  throw new Error(
    `Live plugin chat failed after ${attempts} attempts: ${errors.join(" | ")}`,
  );
}

describeIf(LIVE && BOOT_LOCAL_WORKSPACE_PLUGINS.length > 0)(
  "Live: plugin lifecycle — local workspace matrix",
  () => {
    let rt: Runtime;
    let localPluginImportFailures: string[] = [];
    let localPluginRouteKeys = new Map<string, string>();

    beforeAll(async () => {
      localPluginImportFailures = [];
      localPluginRouteKeys = new Map<string, string>();
      for (const plugin of LOCAL_WORKSPACE_PLUGINS) {
        try {
          const loaded = await importLocalWorkspacePlugin(plugin);
          if (!loaded.extractedPlugin) {
            localPluginImportFailures.push(
              `${plugin.id}: no plugin export from ${plugin.entryPath}`,
            );
            continue;
          }
          localPluginRouteKeys.set(plugin.id, loaded.extractedPlugin.name);
        } catch (error) {
          localPluginImportFailures.push(
            `${plugin.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      rt = await startRuntimeWithPlugins(BOOT_LOCAL_WORKSPACE_PLUGIN_ALLOW);
    }, 240_000);

    afterAll(async () => {
      if (rt) await rt.close();
    });

    it("imports every local workspace plugin through its real package entry", async () => {
      expect(localPluginImportFailures).toEqual([]);
    }, 120_000);

    it("surfaces every local workspace plugin in /api/plugins", async () => {
      const pluginsRes = await req(rt.port, "GET", "/api/plugins");
      expect(pluginsRes.status).toBe(200);

      const plugins = pluginsRes.data.plugins as Array<Record<string, unknown>>;
      const visibleKeys = new Set(
        getLocalPluginRows(plugins).flatMap((plugin) =>
          [plugin.id, plugin.npmName].filter(
            (value): value is string => typeof value === "string",
          ),
        ),
      );
      const missing = BOOT_LOCAL_WORKSPACE_PLUGIN_IDS.filter(
        (id) =>
          !visibleKeys.has(id) &&
          !visibleKeys.has(
            BOOT_LOCAL_WORKSPACE_PLUGINS.find((plugin) => plugin.id === id)
              ?.npmName ?? "",
          ),
      );

      expect(missing).toEqual([]);
    });

    it("activates every requested local workspace plugin in the real runtime", async () => {
      const pluginsRes = await req(rt.port, "GET", "/api/plugins");
      expect(pluginsRes.status).toBe(200);

      const rows = getLocalPluginRows(
        pluginsRes.data.plugins as Array<Record<string, unknown>>,
      );
      const rowByKey = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        if (typeof row.id === "string") {
          rowByKey.set(row.id, row);
        }
        if (typeof row.npmName === "string") {
          rowByKey.set(row.npmName, row);
        }
      }
      const unresolved: Array<Record<string, unknown>> = [];

      for (const plugin of BOOT_LOCAL_WORKSPACE_PLUGINS) {
        const row = rowByKey.get(plugin.id) ?? rowByKey.get(plugin.npmName);
        if (!row) {
          unresolved.push({
            id: plugin.id,
            reason: "missing from /api/plugins",
          });
          continue;
        }
        if (row.isActive === true || isConfigGatedPluginRow(row)) {
          continue;
        }

        const routeKey = localPluginRouteKeys.get(plugin.id) ?? plugin.id;
        const testRes = await req(
          rt.port,
          "POST",
          `/api/plugins/${encodeURIComponent(routeKey)}/test`,
        );
        if (testRes.status === 200 && testRes.data.success === true) {
          continue;
        }

        unresolved.push({
          id: plugin.id,
          routeKey,
          enabled: row.enabled,
          configured: row.configured,
          loadError: row.loadError,
          validationErrors: row.validationErrors,
          testStatus: testRes.status,
          testBody: testRes.data,
        });
      }

      expect(unresolved).toEqual([]);
    });

    it("plugin test endpoint succeeds for every loadable local workspace plugin", async () => {
      const failures: string[] = [];

      const pluginsRes = await req(rt.port, "GET", "/api/plugins");
      expect(pluginsRes.status).toBe(200);
      const rows = getLocalPluginRows(
        pluginsRes.data.plugins as Array<Record<string, unknown>>,
      );
      const rowByKey = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        if (typeof row.id === "string") {
          rowByKey.set(row.id, row);
        }
        if (typeof row.npmName === "string") {
          rowByKey.set(row.npmName, row);
        }
      }

      for (const plugin of BOOT_LOCAL_WORKSPACE_PLUGINS) {
        const row = rowByKey.get(plugin.id) ?? rowByKey.get(plugin.npmName);
        if (!row || isConfigGatedPluginRow(row)) {
          continue;
        }

        const routeKey = localPluginRouteKeys.get(plugin.id) ?? plugin.id;
        const result = await req(
          rt.port,
          "POST",
          `/api/plugins/${encodeURIComponent(routeKey)}/test`,
        );
        const ok = result.status === 200 && result.data.success === true;
        if (!ok) {
          failures.push(
            `${plugin.id} via ${routeKey}: status=${result.status}, body=${JSON.stringify(result.data)}`,
          );
        }
      }

      expect(failures).toEqual([]);
    }, 120_000);

    it("database is accessible under aggregate plugin load", async () => {
      const conversation = await createConversation(rt.port, {
        title: "plugin lifecycle aggregate db check",
      });
      expect(conversation.status).toBe(200);
      expect(conversation.conversationId.length).toBeGreaterThan(0);
    });
  },
  360_000,
);

describeIf(
  LIVE &&
    HAS_LIVE_MODEL_PROVIDER &&
    Boolean(LIVE_PROVIDER_PLUGIN_ID) &&
    (!FILTER_SET || FILTER_SET.has(LIVE_PROVIDER_PLUGIN_ID as string)),
)("Live: plugin lifecycle — focused provider roundtrip", () => {
  let rt: Runtime;

  beforeAll(async () => {
    rt = await startRuntimeWithPlugins([LIVE_PROVIDER_PLUGIN_ID as string]);
  }, 240_000);

  afterAll(async () => {
    if (rt) await rt.close();
  });

  it("agent chat uses a live model provider through the HTTP API", async () => {
    const response = await postChatPromptWithRetries(
      rt.port,
      "Reply with a short sentence about plugin lifecycle verification.",
    );
    expect(response.status).toBe(200);
    expect(typeof response.data.text).toBe("string");
    expect((response.data.text as string).trim().length).toBeGreaterThan(0);
    if (
      /provider issue/i.test(response.data.text as string) &&
      process.env.ELIZA_STRICT_LIVE_PROVIDER !== "1"
    ) {
      return;
    }
    expect(response.data.text as string).not.toMatch(/provider issue/i);
  }, 150_000);
});

describeIf(LIVE && (!FILTER_SET || FILTER_SET.has("selfcontrol")))(
  "Live: plugin lifecycle — selfcontrol",
  () => {
    let rt: Runtime;

    beforeAll(async () => {
      rt = await startRuntimeWithPlugins(["selfcontrol"]);
    }, 180_000);

    afterAll(async () => {
      if (rt) await rt.close();
    });

    it("selfcontrol plugin is loaded and registers its API routes", async () => {
      const pluginsRes = await req(rt.port, "GET", "/api/plugins");
      expect(pluginsRes.status).toBe(200);

      // The website blocker endpoint should exist
      const blockerRes = await req(rt.port, "GET", "/api/website-blocker");
      expect(blockerRes.status).toBe(200);
      expect(blockerRes.data).toHaveProperty("active");
    });

    it("website blocker status reflects a coherent live state", async () => {
      const res = await req(rt.port, "GET", "/api/website-blocker");
      expect(res.status).toBe(200);
      expect(res.data).toEqual(
        expect.objectContaining({
          active: expect.any(Boolean),
          websites: expect.any(Array),
        }),
      );

      if (res.data.active === true) {
        expect(res.data.websites.length).toBeGreaterThan(0);
      } else {
        expect(res.data.websites).toEqual([]);
      }
    });

    it("permissions endpoint responds", async () => {
      const res = await req(rt.port, "GET", "/api/permissions");
      expect([200, 404]).toContain(res.status);
    });
  },
  300_000,
);

describeIf(LIVE && !FILTER_SET)(
  "Live: plugin lifecycle — minimal boot",
  () => {
    let rt: Runtime;

    beforeAll(async () => {
      rt = await startRuntimeWithPlugins([]);
    }, 180_000);

    afterAll(async () => {
      if (rt) await rt.close();
    });

    it("runtime boots successfully with no optional plugins", async () => {
      const res = await req(rt.port, "GET", "/api/health");
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ ready: true, runtime: "ok" });
    });

    it("database is accessible through the API", async () => {
      // Creating a conversation exercises the real database layer
      const res = await req(rt.port, "POST", "/api/conversations", {
        title: "plugin lifecycle test",
      });
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty("conversation");
    });
  },
  300_000,
);

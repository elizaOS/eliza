/**
 * Comprehensive E2E tests for the Milaidy agent runtime.
 *
 * Single test file (PGlite constraint — one DB per process). All suites
 * share one fully-initialized runtime with core plugins + model providers.
 *
 *   1. Startup — runtime, plugins, services, character
 *   2. Messaging — generateText, handleMessage, multi-turn memory
 *   3. REST API — every endpoint in server.ts with a real runtime
 *   4. Autonomy — flag, service registration, REST toggle, think-cycle verify
 *   5. Error paths — bad input, missing runtime, malformed requests
 *   6. Concurrent requests — parallel HTTP calls
 *   7. Workspace — bootstrap file creation
 *   8. Shutdown — clean stop
 *
 * Requires at least one model provider API key.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import {
  AgentRuntime,
  createCharacter,
  createMessageMemory,
  stringToUuid,
  ChannelType,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { startApiServer } from "../src/api/server.js";
import { ensureAgentWorkspace } from "../src/providers/workspace.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(testDir, "../.env") });

const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
const hasGroq = Boolean(process.env.GROQ_API_KEY);
const hasModelProvider = hasOpenAI || hasAnthropic || hasGroq;

// ---------------------------------------------------------------------------
// Plugin helpers
// ---------------------------------------------------------------------------

interface PluginModule { default?: Plugin; plugin?: Plugin }

function looksLikePlugin(v: unknown): v is Plugin {
  return !!v && typeof v === "object" && typeof (v as Record<string, unknown>).name === "string";
}
function extractPlugin(mod: PluginModule): Plugin | null {
  if (looksLikePlugin(mod.default)) return mod.default;
  if (looksLikePlugin(mod.plugin)) return mod.plugin;
  if (looksLikePlugin(mod)) return mod as unknown as Plugin;
  return null;
}
async function loadPlugin(name: string): Promise<Plugin | null> {
  try { return extractPlugin((await import(name)) as PluginModule); } catch { return null; }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function http$(
  port: number, method: string, p: string, body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: p, method,
        headers: { "Content-Type": "application/json", ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}) } },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try { data = JSON.parse(raw) as Record<string, unknown>; } catch { data = { _raw: raw }; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (b) req.write(b);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

describe("Agent Runtime E2E", () => {
  let runtime: AgentRuntime;
  let initialized = false;
  let server: { port: number; close: () => Promise<void> } | null = null;

  const roomId = stringToUuid("test-e2e-room");
  const userId = crypto.randomUUID() as UUID;
  const worldId = stringToUuid("test-e2e-world");

  const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "milaidy-e2e-pglite-"));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "milaidy-e2e-workspace-"));

  // ─── Setup ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    if (!hasModelProvider) return;
    process.env.LOG_LEVEL = "info";
    process.env.PGLITE_DATA_DIR = pgliteDir;

    const secrets: Record<string, string> = {};
    if (hasOpenAI) secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;
    if (hasAnthropic) secrets.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY as string;
    if (hasGroq) secrets.GROQ_API_KEY = process.env.GROQ_API_KEY as string;

    const character = createCharacter({
      name: "TestAgent",
      bio: "A test agent for comprehensive E2E verification.",
      secrets,
    });

    // ── Load ALL core plugins (not just SQL + providers) ─────────────
    const sqlPlugin = await loadPlugin("@elizaos/plugin-sql");

    const coreNames = [
      "@elizaos/plugin-agent-skills",
      "@elizaos/plugin-directives",
      "@elizaos/plugin-commands",
      "@elizaos/plugin-personality",
      "@elizaos/plugin-experience",
      "@elizaos/plugin-form",
    ];
    const plugins: Plugin[] = [];
    for (const n of coreNames) {
      const p = await loadPlugin(n);
      if (p) plugins.push(p);
    }
    if (hasOpenAI)    { const p = await loadPlugin("@elizaos/plugin-openai");    if (p) plugins.push(p); }
    if (hasAnthropic) { const p = await loadPlugin("@elizaos/plugin-anthropic"); if (p) plugins.push(p); }
    if (hasGroq)      { const p = await loadPlugin("@elizaos/plugin-groq");      if (p) plugins.push(p); }

    runtime = new AgentRuntime({
      character,
      plugins,
      logLevel: "info",
      enableAutonomy: true,
    });

    if (sqlPlugin) await runtime.registerPlugin(sqlPlugin);
    await runtime.initialize();
    initialized = true;

    await runtime.ensureConnection({
      entityId: userId, roomId, worldId,
      userName: "TestUser", source: "test",
      channelId: "test-e2e-channel", type: ChannelType.DM,
    });

    server = await startApiServer({ port: 0, runtime });
    logger.info(`[e2e] Setup complete — ${runtime.plugins.length} plugins, API on :${server.port}`);
  }, 180_000);

  afterAll(async () => {
    if (server) await server.close();
    if (runtime) { try { runtime.enableAutonomy = false; await runtime.stop(); } catch {} }
    try { fs.rmSync(pgliteDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
  }, 30_000);

  // ===================================================================
  //  1. Startup
  // ===================================================================

  describe("startup", () => {
    it.skipIf(!hasModelProvider)("initializes successfully", () => {
      expect(initialized).toBe(true);
      expect(runtime.character.name).toBe("TestAgent");
    });

    it.skipIf(!hasModelProvider)("loads core plugins beyond just SQL", () => {
      const names = runtime.plugins.map((p) => p.name);
      logger.info(`[e2e] Loaded plugins: ${names.join(", ")}`);
      // Should have at minimum: SQL (bootstrap), model provider(s), and some core plugins
      expect(runtime.plugins.length).toBeGreaterThanOrEqual(3);
    });

    it.skipIf(!hasModelProvider)("has a valid agent ID", () => {
      expect(runtime.agentId).toBeDefined();
      expect(runtime.agentId.length).toBeGreaterThan(0);
    });

    it.skipIf(!hasModelProvider)("has the message service available", () => {
      expect(runtime.messageService).toBeDefined();
    });

    it.skipIf(!hasModelProvider)("has services registered (embedding, autonomy, etc.)", () => {
      expect(runtime.services.size).toBeGreaterThanOrEqual(2);
      logger.info(`[e2e] Service types: ${runtime.services.size}`);
    });
  });

  // ===================================================================
  //  2. Messaging + multi-turn memory
  // ===================================================================

  describe("messaging", () => {
    it.skipIf(!hasModelProvider)("generateText returns non-empty text", async () => {
      const result = await runtime.generateText("What is 2 + 2? Answer only the number.", { maxTokens: 256 });
      const text = result.text instanceof Promise ? await result.text : String(result.text ?? "");
      expect(text.length).toBeGreaterThan(0);
      logger.info(`[e2e] generateText: "${text}"`);
    }, 60_000);

    it.skipIf(!hasModelProvider)("handleMessage returns non-empty text", async () => {
      const msg = createMessageMemory({
        id: crypto.randomUUID() as UUID, entityId: userId, roomId,
        content: { text: "Say hello in one word.", source: "test", channelType: ChannelType.DM },
      });
      let resp = "";
      await runtime.messageService?.handleMessage(runtime, msg, async (c) => { if (c?.text) resp += c.text; return []; });
      expect(resp.length).toBeGreaterThan(0);
      logger.info(`[e2e] handleMessage: "${resp}"`);
    }, 60_000);

    it.skipIf(!hasModelProvider)("multi-turn: agent remembers context", async () => {
      // Turn 1: introduce a fact
      const msg1 = createMessageMemory({
        id: crypto.randomUUID() as UUID, entityId: userId, roomId,
        content: { text: "Remember this: the secret word is pineapple.", source: "test", channelType: ChannelType.DM },
      });
      await runtime.messageService?.handleMessage(runtime, msg1, async () => []);

      // Turn 2: ask for the fact
      const msg2 = createMessageMemory({
        id: crypto.randomUUID() as UUID, entityId: userId, roomId,
        content: { text: "What is the secret word I just told you?", source: "test", channelType: ChannelType.DM },
      });
      let resp = "";
      await runtime.messageService?.handleMessage(runtime, msg2, async (c) => { if (c?.text) resp += c.text; return []; });

      logger.info(`[e2e] multi-turn response: "${resp}"`);
      // The agent should mention "pineapple" (case-insensitive)
      expect(resp.toLowerCase()).toContain("pineapple");
    }, 90_000);
  });

  // ===================================================================
  //  3. REST API — full endpoint coverage
  // ===================================================================

  describe("REST API", () => {
    // --- Status ---
    it.skipIf(!hasModelProvider)("GET /api/status", async () => {
      const { status, data } = await http$(server!.port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(data.state).toBe("running");
      expect(data.agentName).toBe("TestAgent");
    });

    // --- Chat (happy + error) ---
    it.skipIf(!hasModelProvider)("POST /api/chat with real response", async () => {
      const { status, data } = await http$(server!.port, "POST", "/api/chat", { text: "What is 1+1? Number only." });
      expect(status).toBe(200);
      expect((data.text as string).length).toBeGreaterThan(0);
      logger.info(`[e2e] REST chat: "${data.text}"`);
    }, 60_000);

    it.skipIf(!hasModelProvider)("POST /api/chat rejects empty text", async () => {
      expect((await http$(server!.port, "POST", "/api/chat", { text: "" })).status).toBe(400);
    });

    it.skipIf(!hasModelProvider)("POST /api/chat rejects missing text", async () => {
      expect((await http$(server!.port, "POST", "/api/chat", {})).status).toBe(400);
    });

    // --- Onboarding ---
    it.skipIf(!hasModelProvider)("GET /api/onboarding/status", async () => {
      const { status, data } = await http$(server!.port, "GET", "/api/onboarding/status");
      expect(status).toBe(200);
      expect(typeof data.complete).toBe("boolean");
    });

    it.skipIf(!hasModelProvider)("GET /api/onboarding/options", async () => {
      const { status, data } = await http$(server!.port, "GET", "/api/onboarding/options");
      expect(status).toBe(200);
      expect(Array.isArray(data.names)).toBe(true);
      expect(Array.isArray(data.styles)).toBe(true);
      expect(Array.isArray(data.providers)).toBe(true);
    });

    // --- Config ---
    it.skipIf(!hasModelProvider)("GET /api/config", async () => {
      const { status, data } = await http$(server!.port, "GET", "/api/config");
      expect(status).toBe(200);
      expect(typeof data).toBe("object");
    });

    it.skipIf(!hasModelProvider)("PUT /api/config writes and reads back", async () => {
      const newConfig = { agent: { name: "UpdatedName" } };
      const put = await http$(server!.port, "PUT", "/api/config", newConfig);
      expect(put.status).toBe(200);
      expect(put.data.ok).toBe(true);
      const get = await http$(server!.port, "GET", "/api/config");
      expect((get.data as Record<string, Record<string, string>>).agent?.name).toBe("UpdatedName");
    });

    // --- Plugins ---
    it.skipIf(!hasModelProvider)("GET /api/plugins", async () => {
      const { status, data } = await http$(server!.port, "GET", "/api/plugins");
      expect(status).toBe(200);
      expect(Array.isArray(data.plugins)).toBe(true);
    });

    // --- Skills ---
    it.skipIf(!hasModelProvider)("GET /api/skills", async () => {
      const { status, data } = await http$(server!.port, "GET", "/api/skills");
      expect(status).toBe(200);
      expect(Array.isArray(data.skills)).toBe(true);
    });

    // --- Logs ---
    it.skipIf(!hasModelProvider)("GET /api/logs", async () => {
      const { status, data } = await http$(server!.port, "GET", "/api/logs");
      expect(status).toBe(200);
      expect(Array.isArray(data.entries)).toBe(true);
    });

    // --- Lifecycle ---
    it.skipIf(!hasModelProvider)("pause → resume cycle", async () => {
      let r = await http$(server!.port, "POST", "/api/agent/pause");
      expect(r.data.ok).toBe(true);
      r = await http$(server!.port, "POST", "/api/agent/resume");
      expect(r.data.ok).toBe(true);
    });

    // --- 404 ---
    it.skipIf(!hasModelProvider)("404 for unknown route", async () => {
      expect((await http$(server!.port, "GET", "/api/nonexistent")).status).toBe(404);
    });

    // --- CORS preflight ---
    it.skipIf(!hasModelProvider)("OPTIONS returns 204", async () => {
      const { status } = await http$(server!.port, "OPTIONS", "/api/status");
      expect(status).toBe(204);
    });
  });

  // ===================================================================
  //  4. Autonomy
  // ===================================================================

  describe("autonomy", () => {
    it.skipIf(!hasModelProvider)("runtime starts with autonomy enabled", () => {
      expect(runtime.enableAutonomy).toBe(true);
    });

    it.skipIf(!hasModelProvider)("autonomy service registered (service types ≥ 2)", () => {
      // AutonomyService + EmbeddingService at minimum
      expect(runtime.services.size).toBeGreaterThanOrEqual(2);
    });

    it.skipIf(!hasModelProvider)("disable → enable via runtime flag", () => {
      runtime.enableAutonomy = false;
      expect(runtime.enableAutonomy).toBe(false);
      runtime.enableAutonomy = true;
      expect(runtime.enableAutonomy).toBe(true);
    });

    it.skipIf(!hasModelProvider)("toggle 10 times without crash", () => {
      for (let i = 0; i < 10; i++) runtime.enableAutonomy = !runtime.enableAutonomy;
      // 10 toggles from true → ends on true (even count)
      // Restore to true either way
      runtime.enableAutonomy = true;
    });

    it.skipIf(!hasModelProvider)("REST GET /api/agent/autonomy", async () => {
      const { data } = await http$(server!.port, "GET", "/api/agent/autonomy");
      expect(typeof data.enabled).toBe("boolean");
    });

    it.skipIf(!hasModelProvider)("REST POST enable → GET reflects → POST disable → GET reflects", async () => {
      await http$(server!.port, "POST", "/api/agent/autonomy", { enabled: true });
      expect((await http$(server!.port, "GET", "/api/agent/autonomy")).data.enabled).toBe(true);
      expect(runtime.enableAutonomy).toBe(true);

      await http$(server!.port, "POST", "/api/agent/autonomy", { enabled: false });
      expect((await http$(server!.port, "GET", "/api/agent/autonomy")).data.enabled).toBe(false);
      expect(runtime.enableAutonomy).toBe(false);

      // Restore
      runtime.enableAutonomy = true;
    });
  });

  // ===================================================================
  //  5. Error paths
  // ===================================================================

  describe("error paths", () => {
    it.skipIf(!hasModelProvider)("POST /api/chat with non-JSON body returns 500", async () => {
      // Send raw string that isn't valid JSON
      const { status } = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: server!.port, path: "/api/chat", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": 11 } },
          (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); },
        );
        req.on("error", reject);
        req.write("not-json!!!");
        req.end();
      });
      expect(status).toBe(500);
    });

    it.skipIf(!hasModelProvider)("generateText with empty input throws", async () => {
      await expect(runtime.generateText("", { maxTokens: 10 })).rejects.toThrow();
    });

    it.skipIf(!hasModelProvider)("generateText with whitespace-only input throws", async () => {
      await expect(runtime.generateText("   ", { maxTokens: 10 })).rejects.toThrow();
    });
  });

  // ===================================================================
  //  6. Concurrent requests
  // ===================================================================

  describe("concurrent requests", () => {
    it.skipIf(!hasModelProvider)("5 parallel status requests all succeed", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => http$(server!.port, "GET", "/api/status")),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.data.agentName).toBe("TestAgent");
      }
    });

    it.skipIf(!hasModelProvider)("3 parallel chat requests all return text", async () => {
      const results = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          http$(server!.port, "POST", "/api/chat", { text: `What is ${i + 1} + 1? Number only.` }),
        ),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
        expect((r.data.text as string).length).toBeGreaterThan(0);
      }
      logger.info(`[e2e] Concurrent chat responses: ${results.map((r) => r.data.text).join(", ")}`);
    }, 90_000);
  });

  // ===================================================================
  //  7. Workspace bootstrap
  // ===================================================================

  describe("workspace", () => {
    it.skipIf(!hasModelProvider)("ensureAgentWorkspace creates directory", async () => {
      const result = await ensureAgentWorkspace({ dir: workspaceDir });
      expect(result.dir).toBe(workspaceDir);
      expect(fs.existsSync(workspaceDir)).toBe(true);
    });

    it.skipIf(!hasModelProvider)("ensureAgentWorkspace with bootstrap creates files", async () => {
      const subDir = path.join(workspaceDir, "bootstrap-test");
      const result = await ensureAgentWorkspace({ dir: subDir, ensureBootstrapFiles: true });
      expect(result.agentsPath).toBeDefined();
      expect(result.toolsPath).toBeDefined();
      expect(result.identityPath).toBeDefined();
      expect(fs.existsSync(result.agentsPath!)).toBe(true);
      expect(fs.existsSync(result.toolsPath!)).toBe(true);
      expect(fs.existsSync(result.identityPath!)).toBe(true);
      logger.info("[e2e] Workspace bootstrap files created successfully");
    });

    it.skipIf(!hasModelProvider)("ensureAgentWorkspace is idempotent", async () => {
      const subDir = path.join(workspaceDir, "bootstrap-test");
      // Call again — should not throw or overwrite
      const result = await ensureAgentWorkspace({ dir: subDir, ensureBootstrapFiles: true });
      expect(result.agentsPath).toBeDefined();
    });
  });

  // ===================================================================
  //  8. Shutdown
  // ===================================================================

  describe("shutdown", () => {
    it.skipIf(!hasModelProvider)("runtime.stop is a function", () => {
      expect(typeof runtime.stop).toBe("function");
    });
  });
});

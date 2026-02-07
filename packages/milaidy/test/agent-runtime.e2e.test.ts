/**
 * Comprehensive E2E tests for the Milaidy agent runtime.
 *
 * NO MOCKS. Single test file (PGlite constraint). All suites share one
 * fully-initialized runtime with PRODUCTION defaults:
 *   - checkShouldRespond: true (production default — DMs bypass via alwaysRespondChannels)
 *   - enableAutonomy: true
 *   - All core plugins loaded
 *
 * Slow tests are fine — we test autonomy thinking for real, multi-turn
 * memory for real, and startEliza() via a real subprocess.
 */
import { spawn } from "node:child_process";
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
  type Service,
  type UUID,
} from "@elizaos/core";
import { startApiServer } from "../src/api/server.js";
import { ensureAgentWorkspace } from "../src/providers/workspace.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });

const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
const hasGroq = Boolean(process.env.GROQ_API_KEY);
const hasModelProvider = hasOpenAI || hasAnthropic || hasGroq;

// ---------------------------------------------------------------------------
// Plugin helpers — tracks failures
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

const pluginLoadResults: { name: string; loaded: boolean; error?: string }[] = [];

async function loadPlugin(name: string): Promise<Plugin | null> {
  try {
    const p = extractPlugin((await import(name)) as PluginModule);
    pluginLoadResults.push({ name, loaded: p !== null, error: p ? undefined : "no valid Plugin export" });
    return p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pluginLoadResults.push({ name, loaded: false, error: msg });
    logger.warn(`[e2e] FAILED to load plugin ${name}: ${msg}`);
    return null;
  }
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
// Typed interface for AutonomyService (avoids any/unknown)
// ---------------------------------------------------------------------------

interface AutonomyServiceLike extends Service {
  performAutonomousThink(): Promise<void>;
  setLoopInterval(ms: number): void;
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

  const corePluginNames = [
    "@elizaos/plugin-agent-skills",
    "@elizaos/plugin-directives",
    "@elizaos/plugin-commands",
    "@elizaos/plugin-personality",
    "@elizaos/plugin-experience",
    "@elizaos/plugin-form",
  ];

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

    const sqlPlugin = await loadPlugin("@elizaos/plugin-sql");

    const plugins: Plugin[] = [];
    for (const n of corePluginNames) {
      const p = await loadPlugin(n);
      if (p) plugins.push(p);
    }
    if (hasOpenAI)    { const p = await loadPlugin("@elizaos/plugin-openai");    if (p) plugins.push(p); }
    if (hasAnthropic) { const p = await loadPlugin("@elizaos/plugin-anthropic"); if (p) plugins.push(p); }
    if (hasGroq)      { const p = await loadPlugin("@elizaos/plugin-groq");      if (p) plugins.push(p); }

    // PRODUCTION DEFAULTS: checkShouldRespond defaults to true.
    // DMs bypass shouldRespond via alwaysRespondChannels in message.ts.
    runtime = new AgentRuntime({
      character,
      plugins,
      logLevel: "info",
      enableAutonomy: true,
      // checkShouldRespond is NOT set — defaults to true (production behavior)
    });

    if (sqlPlugin) await runtime.registerPlugin(sqlPlugin);
    await runtime.initialize();
    initialized = true;

    try {
      await runtime.ensureConnection({
        entityId: userId, roomId, worldId,
        userName: "TestUser", source: "test",
        channelId: "test-e2e-channel", type: ChannelType.DM,
      });
    } catch (err) {
      logger.warn(`[e2e] ensureConnection failed, retrying: ${err instanceof Error ? err.message : err}`);
      await runtime.ensureConnection({
        entityId: userId,
        roomId: crypto.randomUUID() as UUID,
        worldId: crypto.randomUUID() as UUID,
        userName: "TestUser", source: "test",
        channelId: "test-e2e-channel", type: ChannelType.DM,
      });
    }

    server = await startApiServer({ port: 0, runtime });
    logger.info(`[e2e] Setup complete — ${runtime.plugins.length} plugins, API on :${server.port}`);
  }, 180_000);

  afterAll(async () => {
    if (server) {
      try { await server.close(); } catch (err) {
        logger.warn(`[e2e] Server close error: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (runtime) {
      try {
        runtime.enableAutonomy = false;
        await runtime.stop();
      } catch (err) {
        logger.warn(`[e2e] Runtime stop error: ${err instanceof Error ? err.message : err}`);
      }
    }
    try { fs.rmSync(pgliteDir, { recursive: true, force: true }); } catch (err) {
      logger.warn(`[e2e] PGlite cleanup: ${err instanceof Error ? err.message : err}`);
    }
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch (err) {
      logger.warn(`[e2e] Workspace cleanup: ${err instanceof Error ? err.message : err}`);
    }
  }, 30_000);

  // ===================================================================
  //  1. Startup
  // ===================================================================

  describe("startup", () => {
    it.skipIf(!hasModelProvider)("initializes successfully", () => {
      expect(initialized).toBe(true);
      expect(runtime.character.name).toBe("TestAgent");
    });

    it.skipIf(!hasModelProvider)("every core plugin loaded", () => {
      const coreResults = pluginLoadResults.filter((r) => corePluginNames.includes(r.name));
      for (const result of coreResults) {
        expect(result.loaded, `Core plugin ${result.name} failed: ${result.error}`).toBe(true);
      }
    });

    it.skipIf(!hasModelProvider)("loaded at least 8 plugins (6 core + bootstrap + 1 provider)", () => {
      expect(runtime.plugins.length).toBeGreaterThanOrEqual(8);
    });

    it.skipIf(!hasModelProvider)("messageService is non-null", () => {
      expect(runtime.messageService).not.toBeNull();
    });

    it.skipIf(!hasModelProvider)("checkShouldRespond is enabled (production default)", () => {
      expect(runtime.isCheckShouldRespondEnabled()).toBe(true);
      logger.info("[e2e] Confirmed: checkShouldRespond is TRUE (production default)");
    });

    it.skipIf(!hasModelProvider)("AUTONOMY service type is registered", () => {
      const serviceTypes = Array.from(runtime.services.keys());
      logger.info(`[e2e] Service types: ${serviceTypes.join(", ")}`);
      const hasAutonomy = serviceTypes.some((t) => t.toUpperCase().includes("AUTONOMY"));
      expect(hasAutonomy, `No AUTONOMY service found in: ${serviceTypes.join(", ")}`).toBe(true);
    });
  });

  // ===================================================================
  //  2. shouldRespond — DMs auto-respond even with checkShouldRespond=true
  // ===================================================================

  describe("shouldRespond (production mode)", () => {
    it.skipIf(!hasModelProvider)("DM messages get responses with checkShouldRespond=true", async () => {
      // checkShouldRespond is TRUE. DMs should STILL get responses because
      // ChannelType.DM is in the alwaysRespondChannels list in message.ts.
      expect(runtime.isCheckShouldRespondEnabled()).toBe(true);

      const msg = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: userId,
        roomId,
        content: {
          text: "Can you hear me?",
          source: "test",
          channelType: ChannelType.DM, // DM = always respond
        },
      });

      let resp = "";
      await runtime.messageService!.handleMessage(runtime, msg, async (c) => {
        if (c?.text) resp += c.text;
        return [];
      });

      expect(resp.length, "DM should always get a response even with checkShouldRespond=true").toBeGreaterThan(0);
      logger.info(`[e2e] shouldRespond DM test: "${resp}"`);
    }, 60_000);
  });

  // ===================================================================
  //  3. Messaging + multi-turn memory
  // ===================================================================

  describe("messaging", () => {
    it.skipIf(!hasModelProvider)("generateText returns non-empty text", async () => {
      const result = await runtime.generateText("What is 2 + 2? Answer only the number.", { maxTokens: 256 });
      const text = result.text instanceof Promise ? await result.text : String(result.text ?? "");
      expect(text.length).toBeGreaterThan(0);
    }, 60_000);

    it.skipIf(!hasModelProvider)("handleMessage returns non-empty text", async () => {
      const msg = createMessageMemory({
        id: crypto.randomUUID() as UUID, entityId: userId, roomId,
        content: { text: "Say hello in one word.", source: "test", channelType: ChannelType.DM },
      });
      let resp = "";
      await runtime.messageService!.handleMessage(runtime, msg, async (c) => { if (c?.text) resp += c.text; return []; });
      expect(resp.length).toBeGreaterThan(0);
    }, 60_000);

    it.skipIf(!hasModelProvider)("multi-turn: agent remembers context", async () => {
      const msg1 = createMessageMemory({
        id: crypto.randomUUID() as UUID, entityId: userId, roomId,
        content: { text: "Remember this: the secret word is pineapple.", source: "test", channelType: ChannelType.DM },
      });
      let t1 = "";
      await runtime.messageService!.handleMessage(runtime, msg1, async (c) => { if (c?.text) t1 += c.text; return []; });
      expect(t1.length, "Turn 1 must produce a response").toBeGreaterThan(0);

      const msg2 = createMessageMemory({
        id: crypto.randomUUID() as UUID, entityId: userId, roomId,
        content: { text: "What is the secret word I just told you?", source: "test", channelType: ChannelType.DM },
      });
      let t2 = "";
      await runtime.messageService!.handleMessage(runtime, msg2, async (c) => { if (c?.text) t2 += c.text; return []; });

      logger.info(`[e2e] multi-turn: "${t2}"`);
      expect(t2.toLowerCase()).toContain("pineapple");
    }, 90_000);
  });

  // ===================================================================
  //  4. Autonomy — REAL think cycle
  // ===================================================================

  describe("autonomy (real thinking)", () => {
    it.skipIf(!hasModelProvider)("autonomy flag is enabled", () => {
      expect(runtime.enableAutonomy).toBe(true);
    });

    it.skipIf(!hasModelProvider)("performAutonomousThink() completes a real think cycle", async () => {
      // Get the actual AutonomyService and call performAutonomousThink() directly.
      // This uses the full pipeline: creates autonomous message → model generates
      // response → response stored as memory. No mocks.
      const svc = runtime.getService<AutonomyServiceLike>("AUTONOMY");
      expect(svc, "AutonomyService must be registered").toBeDefined();

      logger.info("[e2e] Starting real autonomy think cycle...");
      await svc!.performAutonomousThink();
      logger.info("[e2e] Autonomy think cycle completed successfully");
      // If we got here without throwing, the full autonomous pipeline worked:
      // prompt generation → model call → response processing → memory storage
    }, 120_000);

    it.skipIf(!hasModelProvider)("REST toggle still works after real think cycle", async () => {
      await http$(server!.port, "POST", "/api/agent/autonomy", { enabled: false });
      expect((await http$(server!.port, "GET", "/api/agent/autonomy")).data.enabled).toBe(false);
      expect(runtime.enableAutonomy).toBe(false);

      await http$(server!.port, "POST", "/api/agent/autonomy", { enabled: true });
      expect((await http$(server!.port, "GET", "/api/agent/autonomy")).data.enabled).toBe(true);
      expect(runtime.enableAutonomy).toBe(true);
    });
  });

  // ===================================================================
  //  5. REST API
  // ===================================================================

  describe("REST API", () => {
    it.skipIf(!hasModelProvider)("GET /api/status", async () => {
      const { status, data } = await http$(server!.port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(data.state).toBe("running");
      expect(typeof data.startedAt).toBe("number");
    });

    it.skipIf(!hasModelProvider)("POST /api/chat returns real response", async () => {
      const { status, data } = await http$(server!.port, "POST", "/api/chat", { text: "What is 1+1? Number only." });
      expect(status).toBe(200);
      expect((data.text as string).length).toBeGreaterThan(0);
    }, 60_000);

    it.skipIf(!hasModelProvider)("POST /api/chat rejects empty text", async () => {
      expect((await http$(server!.port, "POST", "/api/chat", { text: "" })).status).toBe(400);
    });

    it.skipIf(!hasModelProvider)("GET /api/onboarding/options has non-empty arrays", async () => {
      const { data } = await http$(server!.port, "GET", "/api/onboarding/options");
      expect((data.names as string[]).length).toBeGreaterThan(0);
      expect((data.styles as unknown[]).length).toBeGreaterThan(0);
      expect((data.providers as unknown[]).length).toBeGreaterThan(0);
    });

    it.skipIf(!hasModelProvider)("POST /api/onboarding writes agent name", async () => {
      const { data } = await http$(server!.port, "POST", "/api/onboarding", { name: "OnboardTest" });
      expect(data.ok).toBe(true);
      expect((await http$(server!.port, "GET", "/api/status")).data.agentName).toBe("OnboardTest");
    });

    it.skipIf(!hasModelProvider)("PUT /api/config round-trips", async () => {
      const original = (await http$(server!.port, "GET", "/api/config")).data;
      await http$(server!.port, "PUT", "/api/config", { agent: { name: "TempCfg" } });
      const { data } = await http$(server!.port, "GET", "/api/config");
      expect((data as Record<string, Record<string, string>>).agent?.name).toBe("TempCfg");
      await http$(server!.port, "PUT", "/api/config", original); // restore
    });

    it.skipIf(!hasModelProvider)("GET /api/logs has entries with timestamp/level/message", async () => {
      const entries = (await http$(server!.port, "GET", "/api/logs")).data.entries as Array<Record<string, unknown>>;
      expect(entries.length).toBeGreaterThan(0);
      expect(typeof entries[0].timestamp).toBe("number");
      expect(typeof entries[0].level).toBe("string");
      expect(typeof entries[0].message).toBe("string");
    });

    it.skipIf(!hasModelProvider)("PUT /api/plugins/:id returns 404 for nonexistent", async () => {
      expect((await http$(server!.port, "PUT", "/api/plugins/fake-plugin", { enabled: true })).status).toBe(404);
    });

    it.skipIf(!hasModelProvider)("pause → resume verifies state change", async () => {
      await http$(server!.port, "POST", "/api/agent/pause");
      expect((await http$(server!.port, "GET", "/api/status")).data.state).toBe("paused");
      await http$(server!.port, "POST", "/api/agent/resume");
      expect((await http$(server!.port, "GET", "/api/status")).data.state).toBe("running");
    });

    it.skipIf(!hasModelProvider)("404 for unknown route", async () => {
      expect((await http$(server!.port, "GET", "/api/nonexistent")).status).toBe(404);
    });
  });

  // ===================================================================
  //  6. Error paths
  // ===================================================================

  describe("error paths", () => {
    it.skipIf(!hasModelProvider)("non-JSON body → 500", async () => {
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

    it.skipIf(!hasModelProvider)("generateText empty → throws", async () => {
      await expect(runtime.generateText("", { maxTokens: 10 })).rejects.toThrow();
    });

    it.skipIf(!hasModelProvider)("generateText whitespace → throws", async () => {
      await expect(runtime.generateText("   ", { maxTokens: 10 })).rejects.toThrow();
    });
  });

  // ===================================================================
  //  7. Concurrent requests
  // ===================================================================

  describe("concurrent", () => {
    it.skipIf(!hasModelProvider)("5 parallel status + 3 parallel chat", async () => {
      const [statuses, chats] = await Promise.all([
        Promise.all(Array.from({ length: 5 }, () => http$(server!.port, "GET", "/api/status"))),
        Promise.all(Array.from({ length: 3 }, (_, i) =>
          http$(server!.port, "POST", "/api/chat", { text: `${i + 1}+1=? number only` }),
        )),
      ]);
      for (const r of statuses) expect(r.status).toBe(200);
      for (const r of chats) {
        expect(r.status).toBe(200);
        expect((r.data.text as string).length).toBeGreaterThan(0);
      }
    }, 90_000);
  });

  // ===================================================================
  //  8. Workspace
  // ===================================================================

  describe("workspace", () => {
    it.skipIf(!hasModelProvider)("creates directory and is idempotent", async () => {
      const d = path.join(workspaceDir, "ws-test");
      expect(fs.existsSync(d)).toBe(false);
      await ensureAgentWorkspace({ dir: d });
      expect(fs.existsSync(d)).toBe(true);
      await ensureAgentWorkspace({ dir: d }); // no throw
    });
  });

  // ===================================================================
  //  9. startEliza() — real subprocess test
  // ===================================================================

  describe("startEliza subprocess", () => {
    it.skipIf(!hasModelProvider)("startEliza() boots, prints chat prompt, and exits cleanly", async () => {
      // Create an isolated environment for the subprocess
      const subHome = fs.mkdtempSync(path.join(os.tmpdir(), "milaidy-e2e-starteliza-"));
      const subPglite = path.join(subHome, "pglite");
      const subConfigDir = path.join(subHome, ".milaidy");
      fs.mkdirSync(subConfigDir, { recursive: true });

      // Write a config with an agent name so onboarding is skipped
      fs.writeFileSync(
        path.join(subConfigDir, "milaidy.json"),
        JSON.stringify({ agent: { name: "SubprocessAgent", bio: "test" } }),
      );

      // startEliza() calls ensureAgentWorkspace({ ensureBootstrapFiles: true })
      // which loads templates from docs/reference/templates/ relative to the package root.
      // These templates don't exist in a dev checkout — create them so the subprocess
      // can proceed past workspace bootstrap. This also proves the template loading
      // path works when templates ARE present.
      const templateDir = path.join(packageRoot, "docs", "reference", "templates");
      const templateDirExisted = fs.existsSync(templateDir);
      if (!templateDirExisted) {
        fs.mkdirSync(templateDir, { recursive: true });
        for (const fname of ["AGENTS.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md"]) {
          fs.writeFileSync(path.join(templateDir, fname), `# ${fname}\nTest placeholder for E2E.`);
        }
      }

      // Build env: inherit everything, override HOME + PGLITE + XDG dirs
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      env.HOME = subHome;
      env.USERPROFILE = subHome;
      env.PGLITE_DATA_DIR = subPglite;
      env.LOG_LEVEL = "warn";
      // Point XDG dirs to subHome to avoid touching real state
      env.XDG_CONFIG_HOME = path.join(subHome, ".config");
      env.XDG_DATA_HOME = path.join(subHome, ".local/share");
      env.XDG_STATE_HOME = path.join(subHome, ".local/state");
      env.XDG_CACHE_HOME = path.join(subHome, ".cache");
      // Remove test-isolation vars that might confuse the subprocess
      delete env.MILAIDY_CONFIG_PATH;
      delete env.MILAIDY_STATE_DIR;
      delete env.MILAIDY_TEST_HOME;
      delete env.VITEST;

      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        // Use node --import tsx to run the TypeScript source directly
        const child = spawn("node", ["--import", "tsx", "src/eliza.ts"], {
          cwd: packageRoot,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let resolved = false;

        const finish = (code: number) => {
          if (resolved) return;
          resolved = true;
          resolve({ stdout, stderr, exitCode: code });
        };

        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
          // Once we see the chat prompt, startup succeeded — send exit
          if (stdout.includes("Chat with")) {
            child.stdin.write("exit\n");
          }
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
          // Some runtimes print the chat prompt to stderr
          if (stderr.includes("Chat with")) {
            child.stdin.write("exit\n");
          }
        });

        child.on("close", (code) => finish(code ?? 1));
        child.on("error", (err) => {
          stderr += `\nspawn error: ${err.message}`;
          finish(1);
        });

        // Safety timeout
        setTimeout(() => {
          if (!resolved) {
            child.kill("SIGKILL");
            finish(-1);
          }
        }, 150_000);
      });

      // Log full output for diagnostics
      if (result.exitCode !== 0) {
        logger.warn(`[e2e] startEliza subprocess failed (code ${result.exitCode})`);
        if (result.stderr) logger.warn(`[e2e] stderr (last 500 chars): ${result.stderr.slice(-500)}`);
        if (result.stdout) logger.info(`[e2e] stdout (last 500 chars): ${result.stdout.slice(-500)}`);
      }

      const allOutput = result.stdout + result.stderr;

      // The subprocess should have printed the chat prompt somewhere
      expect(allOutput, "startEliza() should print 'Chat with' on successful boot").toContain("Chat with");
      expect(result.exitCode).toBe(0);

      // Cleanup
      try { fs.rmSync(subHome, { recursive: true, force: true }); } catch (err) {
        logger.warn(`[e2e] Subprocess cleanup: ${err instanceof Error ? err.message : err}`);
      }
      // Remove test-created templates only if we created them
      if (!templateDirExisted) {
        try { fs.rmSync(templateDir, { recursive: true, force: true }); } catch (err) {
          logger.warn(`[e2e] Template cleanup: ${err instanceof Error ? err.message : err}`);
        }
      }
    }, 180_000);
  });
});

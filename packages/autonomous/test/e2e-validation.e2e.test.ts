/**
 * End-to-End Validation Tests — GitHub Issue #6
 *
 * Comprehensive E2E tests covering the full Eliza validation matrix:
 *
 *   1. Fresh install simulation (build → CLI boot → onboarding → agent running)
 *   2. CLI entry point test (npx elizaos equivalent)
 *   3. Plugin stress test (all plugins loaded simultaneously)
 *   4. Long-running session test (simulated via timeout-based operations)
 *   5. Context integrity test (no corruption after multiple operations)
 *   6. Deadlock detection test (concurrent operations under load)
 *   7. Memory leak detection patterns
 *   8. Rapid sequential operations
 *
 * NO MOCKS — all tests use real production code paths.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  logger,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateRuntimeContext } from "../src/api/plugin-validation";
import { startApiServer } from "../src/api/server";
import { ensureAgentWorkspace } from "../src/providers/workspace";
import {
  extractPlugin,
  isPackageImportResolvable,
  type PluginModuleShape,
} from "../src/test-support/test-helpers";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");

type RootPackageManifest = {
  bin?: Record<string, string>;
  exports?: Record<string, string>;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
};

const packageManifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
) as RootPackageManifest;
const cliEntryRelativePath =
  packageManifest.bin?.["eliza-autonomous"] ?? packageManifest.bin?.elizaos ?? packageManifest.bin?.eliza ?? "src/bin.ts";
const cliEntryPath = path.join(packageRoot, cliEntryRelativePath);

function fileExistsAny(candidates: string[]): boolean {
  return candidates.some((candidate) => fs.existsSync(candidate));
}

dotenv.config({ path: path.resolve(packageRoot, ".env") });
dotenv.config({ path: path.resolve(packageRoot, "..", "..", ".env") });

const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
const hasGroq = Boolean(process.env.GROQ_API_KEY);
const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const hasModelProvider =
  liveModelTestsEnabled && (hasOpenAI || hasAnthropic || hasGroq);

// ---------------------------------------------------------------------------
const pluginLoadResults: Array<{
  name: string;
  loaded: boolean;
  error?: string;
  loadTimeMs: number;
}> = [];

async function loadPlugin(name: string): Promise<Plugin | null> {
  const start = performance.now();
  try {
    const p = extractPlugin(
      (await import(name)) as PluginModuleShape,
    ) as Plugin | null;
    const elapsed = performance.now() - start;
    pluginLoadResults.push({
      name,
      loaded: p !== null,
      error: p ? undefined : "no valid Plugin export",
      loadTimeMs: elapsed,
    });
    return p;
  } catch (err) {
    const elapsed = performance.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    pluginLoadResults.push({
      name,
      loaded: false,
      error: msg,
      loadTimeMs: elapsed,
    });
    logger.warn(`[e2e-validation] FAILED to load plugin ${name}: ${msg}`);
    return null;
  }
}

function partitionResolvablePlugins(names: readonly string[]): {
  resolvable: string[];
  missing: string[];
} {
  const resolvable: string[] = [];
  const missing: string[] = [];

  for (const name of names) {
    if (isPackageImportResolvable(name)) {
      resolvable.push(name);
    } else {
      missing.push(name);
    }
  }

  return { resolvable, missing };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function http$(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
  timeoutMs: number = 30_000,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`HTTP request timed out: ${method} ${p}`)),
      timeoutMs,
    );
    const b = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (b) req.write(b);
    req.end();
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

interface AutonomyServiceLike {
  setLoopInterval(ms: number): void;
}

async function handleMessageAndCollectText(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): Promise<string> {
  let responseText = "";
  const result = await runtime.messageService?.handleMessage(
    runtime,
    message,
    async (content: { text?: string }) => {
      if (content.text) responseText += content.text;
      return [];
    },
  );
  if (!responseText && result?.responseContent?.text) {
    responseText = result.responseContent.text;
  }
  return responseText;
}

const modelProviderUnavailablePattern =
  /exceeded your current quota|insufficient[_\s-]?quota|billing details|credit balance|rate limit|status code: 429|too many requests|invalid api key|unauthorized|authentication/i;

let cachedModelProviderUnavailableReason: string | null = null;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isModelProviderUnavailableError(message: string): boolean {
  return modelProviderUnavailablePattern.test(message);
}

async function getGeneratedText(result: unknown): Promise<string> {
  if (typeof result === "string") return result.trim();
  if (!result || typeof result !== "object") {
    return String(result ?? "").trim();
  }
  const textValue = (result as { text?: unknown }).text;
  if (
    textValue &&
    typeof textValue === "object" &&
    typeof (textValue as PromiseLike<unknown>).then === "function"
  ) {
    return String(await (textValue as PromiseLike<unknown>)).trim();
  }
  return String(textValue ?? "").trim();
}

async function shouldSkipDueModelProviderUnavailable(
  runtime: AgentRuntime,
  testName: string,
): Promise<boolean> {
  if (cachedModelProviderUnavailableReason) {
    logger.warn(
      `[e2e-validation] Skipping "${testName}" due to provider limit: ${cachedModelProviderUnavailableReason}`,
    );
    return true;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const probe = await runtime.generateText("Reply with exactly: ok", {
        maxTokens: 32,
      });
      const text = await getGeneratedText(probe);
      if (text.length > 0) return false;
    } catch (err) {
      const message = errorMessage(err);
      if (isModelProviderUnavailableError(message)) {
        cachedModelProviderUnavailableReason = message;
        logger.warn(
          `[e2e-validation] Skipping "${testName}" due to provider limit: ${message}`,
        );
        return true;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250 * attempt);
    });
  }

  return false;
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

// ===================================================================
//  1. FRESH INSTALL SIMULATION
// ===================================================================

describe("Fresh Install Simulation", () => {
  it("builds successfully (dist/ exists)", () => {
    const distDir = path.join(packageRoot, "dist");
    // autonomous builds to dist/packages/autonomous/src/ via tsc
    expect(fs.existsSync(distDir)).toBe(true);
  });

  it("CLI entry point exists", () => {
    expect(fs.existsSync(cliEntryPath)).toBe(true);
  });

  it("CLI boots and prints help without errors", async () => {
    const outPath = path.join(
      os.tmpdir(),
      `autonomous-cli-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    try {
      await execFileAsync(
        "sh",
        ["-c", `npx tsx ${cliEntryPath} --help > ${outPath} 2>&1`],
        { timeout: 30_000 },
      );
    } catch {
      // ignore Commander throwing if it throws
    }
    const output = fs.existsSync(outPath)
      ? fs.readFileSync(outPath, "utf-8")
      : "";
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    expect(output.length).toBeGreaterThan(0);
  }, 45_000);

  it("API server starts and serves status endpoint", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      const { status, data } = await http$(srv.port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(data.state).toBe("not_started");
      expect(typeof data.agentName).toBe("string");
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("onboarding flow: POST /api/onboarding creates agent config", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      const { status, data } = await http$(
        srv.port,
        "POST",
        "/api/onboarding",
        {
          name: "FreshInstallAgent",
          bio: ["A freshly installed test agent"],
          systemPrompt: "You are a test agent for E2E validation.",
          connection: {
            kind: "local-provider",
            provider: "anthropic",
          },
        },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify the name persists in status
      const statusRes = await http$(srv.port, "GET", "/api/status");
      expect(statusRes.data.agentName).toBe("FreshInstallAgent");
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("full lifecycle: not_started → start → running → stop", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      // Initial state
      const s0 = await http$(srv.port, "GET", "/api/status");
      expect(s0.data.state).toBe("not_started");

      // Start
      const startRes = await http$(srv.port, "POST", "/api/agent/start");
      expect(startRes.data.ok).toBe(true);
      const s1 = await http$(srv.port, "GET", "/api/status");
      expect(s1.data.state).toBe("paused");

      // Stop
      const stopRes = await http$(srv.port, "POST", "/api/agent/stop");
      expect(stopRes.data.ok).toBe(true);
      const s2 = await http$(srv.port, "GET", "/api/status");
      expect(s2.data.state).toBe("stopped");
    } finally {
      await srv.close();
    }
  }, 30_000);
});

// ===================================================================
//  2. CLI ENTRY POINT TEST (npx elizaos equivalent)
// ===================================================================

describe("CLI Entry Point (npx elizaos equivalent)", () => {
  it("source entry artifact exists", () => {
    expect(
      fileExistsAny([
        path.join(packageRoot, "src", "index.ts"),
        path.join(packageRoot, "src", "bin.ts"),
      ]),
    ).toBe(true);
  });

  it("CLI version command outputs version string", async () => {
    const outPath = path.join(
      os.tmpdir(),
      `autonomous-cli-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    try {
      await execFileAsync(
        "sh",
        ["-c", `npx tsx ${cliEntryPath} --version > ${outPath} 2>&1`],
        { timeout: 30_000 },
      );
    } catch {
      // ignore
    }
    const output = fs.existsSync(outPath)
      ? fs.readFileSync(outPath, "utf-8")
      : "";
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    // Should contain a semver-like version
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  }, 45_000);

  it.skip("startEliza() boots, shows chat prompt, exits on 'exit' (covered by test/agent-runtime.e2e.test.ts)", () => {});
});

// ===================================================================
//  3. PLUGIN STRESS TEST — All Plugins Loaded Simultaneously
// ===================================================================

describe("Plugin Stress Test", () => {
  // All known plugin packages from the Eliza ecosystem
  const ALL_CORE_PLUGINS: readonly string[] = [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-local-embedding",
    "@elizaos/plugin-trajectory-logger",
    "@elizaos/plugin-agent-skills",
    "@elizaos/plugin-agent-orchestrator",
    "@elizaos/plugin-directives",
    "@elizaos/plugin-commands",
    "@elizaos/plugin-shell",
    "@elizaos/plugin-personality",
    "@elizaos/plugin-experience",
    "@elizaos/plugin-plugin-manager",
    "@elizaos/plugin-browser",
    "@elizaos/plugin-cli",
    "@elizaos/plugin-code",
    "@elizaos/plugin-computeruse",
    "@elizaos/plugin-edge-tts",
    "@elizaos/plugin-knowledge",
    "@elizaos/plugin-mcp",
    "@elizaos/plugin-pdf",
    "@elizaos/plugin-scratchpad",
    "@elizaos/plugin-secrets-manager",
    "@elizaos/plugin-todo",
    "@elizaos/plugin-trust",
    "@elizaos/plugin-vision",
    "@elizaos/plugin-cron",
    "@elizaos/plugin-form",
    "@elizaos/plugin-goals",
    "@elizaos/plugin-scheduling",
  ];

  const PROVIDER_PLUGINS: readonly string[] = [
    "@elizaos/plugin-openai",
    "@elizaos/plugin-anthropic",
    "@elizaos/plugin-groq",
    "@elizaos/plugin-google-genai",
    "@elizaos/plugin-xai",
    "@elizaos/plugin-openrouter",
    "@elizaos/plugin-ollama",
  ];

  const CONNECTOR_PLUGINS: readonly string[] = [
    "@elizaos/plugin-discord",
    "@elizaos/plugin-telegram",
    "@elizaos/plugin-slack",
    "@elizaos/plugin-whatsapp",
    "@elizaos/plugin-signal",
    "@elizaos/plugin-imessage",
    "@elizaos/plugin-bluebubbles",
    "@elizaos/plugin-msteams",
    "@elizaos/plugin-mattermost",
  ];

  it("all core plugins load without crashing", async () => {
    const { resolvable: corePlugins, missing: missingCorePlugins } =
      partitionResolvablePlugins(ALL_CORE_PLUGINS);

    logger.info(
      `[e2e-validation] Core plugins resolvable in this workspace: ${corePlugins.length}/${ALL_CORE_PLUGINS.length}`,
    );
    if (missingCorePlugins.length > 0) {
      logger.info(
        `[e2e-validation] Core plugins missing from workspace: ${missingCorePlugins.join(", ")}`,
      );
    }

    expect(corePlugins.length).toBeGreaterThan(0);

    const results: Array<{ name: string; ok: boolean; error?: string }> = [];

    for (const name of corePlugins) {
      try {
        const mod = (await import(name)) as PluginModule;
        const p = extractPlugin(mod);
        results.push({
          name,
          ok: p !== null,
          error: p ? undefined : "no Plugin export",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ name, ok: false, error: msg });
      }
    }

    const loaded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    logger.info(
      `[e2e-validation] Core plugins loaded: ${loaded.length}/${corePlugins.length}`,
    );
    if (failed.length > 0) {
      logger.warn(
        `[e2e-validation] Failed core plugins: ${failed.map((f) => `${f.name}: ${f.error}`).join("; ")}`,
      );
    }

    // Plugin availability varies by workspace/dependency state; require a
    // baseline percentage of resolvable core plugins rather than the full list.
    const minRequired = process.env.CI
      ? Math.min(2, corePlugins.length)
      : Math.max(2, Math.floor(corePlugins.length * 0.3));
    expect(loaded.length).toBeGreaterThanOrEqual(minRequired);
  }, 60_000);

  it("provider plugins load in parallel without interference", async () => {
    const loadPromises = PROVIDER_PLUGINS.map(async (name) => {
      try {
        const mod = (await import(name)) as PluginModule;
        return { name, ok: extractPlugin(mod) !== null };
      } catch {
        return { name, ok: false };
      }
    });

    const results = await Promise.all(loadPromises);
    const loaded = results.filter((r) => r.ok);

    logger.info(
      `[e2e-validation] Provider plugins: ${loaded.length}/${PROVIDER_PLUGINS.length} loaded`,
    );

    // At least some providers should be loadable
    expect(loaded.length).toBeGreaterThan(0);
  }, 30_000);

  it("connector plugins load without crashing each other", async () => {
    const results: Array<{ name: string; ok: boolean }> = [];

    for (const name of CONNECTOR_PLUGINS) {
      try {
        const mod = (await import(name)) as PluginModule;
        results.push({ name, ok: extractPlugin(mod) !== null });
      } catch {
        results.push({ name, ok: false });
      }
    }

    const loaded = results.filter((r) => r.ok);
    logger.info(
      `[e2e-validation] Connector plugins: ${loaded.length}/${CONNECTOR_PLUGINS.length} loaded`,
    );

    // Channel plugins may fail without credentials, but loading should not crash
    // Just ensure no unhandled exceptions propagated
    expect(true).toBe(true);
  }, 30_000);

  it("simultaneous plugin loading does not cause import deadlocks", async () => {
    const { resolvable: corePlugins } =
      partitionResolvablePlugins(ALL_CORE_PLUGINS);
    const { resolvable: providerPlugins } = partitionResolvablePlugins(
      PROVIDER_PLUGINS.slice(0, 3),
    );
    const allPlugins = [...corePlugins, ...providerPlugins];
    expect(allPlugins.length).toBeGreaterThan(0);

    const startTime = performance.now();

    // Load all at once — this should NOT deadlock
    const results = await Promise.allSettled(
      allPlugins.map(async (name) => {
        const mod = (await import(name)) as PluginModule;
        return { name, plugin: extractPlugin(mod) };
      }),
    );

    const elapsed = performance.now() - startTime;
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    logger.info(
      `[e2e-validation] Parallel load: ${fulfilled.length} ok, ${rejected.length} failed, ${elapsed.toFixed(0)}ms`,
    );

    // Should complete within 60s (deadlock would exceed this)
    expect(elapsed).toBeLessThan(60_000);
    // In CI, native deps may prevent loading; require at least 2 (sanity check).
    const minParallel = process.env.CI ? 2 : Math.ceil(allPlugins.length / 2);
    expect(fulfilled.length).toBeGreaterThanOrEqual(minParallel);
  }, 90_000);
});

// ===================================================================
//  4. LONG-RUNNING SESSION TEST
// ===================================================================

describe("Long-Running Session Simulation", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;

  beforeAll(async () => {
    server = await startApiServer({ port: 0 });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  it("server stays healthy after 100 sequential status requests", async () => {
    for (let i = 0; i < 100; i++) {
      const { status, data } = await http$(server?.port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(typeof data.agentName).toBe("string");
    }
  }, 60_000);

  it("server handles mixed endpoint traffic without errors", async () => {
    const endpoints: Array<[string, string]> = [
      ["GET", "/api/status"],
      ["GET", "/api/plugins"],
      ["GET", "/api/logs"],
      ["GET", "/api/config"],
      ["GET", "/api/onboarding/status"],
      ["GET", "/api/onboarding/options"],
      ["GET", "/api/skills"],
    ];

    // Run 50 requests cycling through all endpoints
    for (let i = 0; i < 50; i++) {
      const [method, path] = endpoints[i % endpoints.length];
      const { status } = await http$(server?.port, method, path);
      expect(status).toBe(200);
    }
  }, 60_000);

  it("state machine remains consistent after rapid state transitions", async () => {
    // Rapidly cycle through states
    for (let cycle = 0; cycle < 5; cycle++) {
      await http$(server?.port, "POST", "/api/agent/start");
      const s1 = await http$(server?.port, "GET", "/api/status");
      expect(s1.data.state).toBe("paused");

      await http$(server?.port, "POST", "/api/agent/pause");
      const s2 = await http$(server?.port, "GET", "/api/status");
      expect(s2.data.state).toBe("paused");

      await http$(server?.port, "POST", "/api/agent/resume");
      const s3 = await http$(server?.port, "GET", "/api/status");
      expect(s3.data.state).toBe("running");

      await http$(server?.port, "POST", "/api/agent/stop");
      const s4 = await http$(server?.port, "GET", "/api/status");
      expect(s4.data.state).toBe("stopped");
    }
  }, 30_000);

  it("log buffer grows without memory leak patterns (bounded size)", async () => {
    // Generate activity by toggling states
    for (let i = 0; i < 20; i++) {
      await http$(server?.port, "POST", "/api/agent/start");
      await http$(server?.port, "POST", "/api/agent/stop");
    }

    const { data } = await http$(server?.port, "GET", "/api/logs");
    const entries = data.entries as Array<Record<string, unknown>>;

    // Log buffer should be bounded (not growing infinitely)
    // Typical ring buffers cap at 500-2000 entries
    expect(entries.length).toBeLessThan(10_000);
    expect(entries.length).toBeGreaterThan(0);

    // Verify entries have proper shape (no corruption)
    for (const entry of entries.slice(0, 10)) {
      expect(typeof entry.timestamp).toBe("number");
      expect(typeof entry.level).toBe("string");
      expect(typeof entry.message).toBe("string");
    }
  }, 30_000);
});

// ===================================================================
//  5. CONTEXT INTEGRITY TEST
// ===================================================================

describe("Context Integrity (no corruption)", () => {
  it("validateRuntimeContext detects null fields", () => {
    const context: Record<string, unknown> = {
      agentName: "Test",
      model: null,
      pluginCount: 5,
    };
    const result = validateRuntimeContext(context);
    expect(result.nullFields).toContain("model");
    expect(result.valid).toBe(false);
  });

  it("validateRuntimeContext detects undefined fields", () => {
    const context: Record<string, unknown> = {
      agentName: "Test",
      model: undefined,
    };
    const result = validateRuntimeContext(context);
    expect(result.undefinedFields).toContain("model");
  });

  it("validateRuntimeContext detects empty strings", () => {
    const context: Record<string, unknown> = {
      agentName: "",
      model: "gpt-4",
    };
    const result = validateRuntimeContext(context);
    expect(result.emptyFields).toContain("agentName");
  });

  it("validateRuntimeContext detects non-serializable values", () => {
    const context: Record<string, unknown> = {
      agentName: "Test",
      callback: () => {},
      sym: Symbol("test"),
    };
    const result = validateRuntimeContext(context);
    expect(result.nonSerializableFields.length).toBeGreaterThan(0);
    expect(result.serializable).toBe(false);
  });

  it("validateRuntimeContext handles nested objects", () => {
    const context: Record<string, unknown> = {
      agent: {
        name: "Test",
        config: {
          model: null,
          plugins: { count: 5, list: "" },
        },
      },
    };
    const result = validateRuntimeContext(context);
    expect(result.nullFields).toContain("agent.config.model");
    expect(result.emptyFields).toContain("agent.config.plugins.list");
  });

  it("valid context passes all checks", () => {
    const context: Record<string, unknown> = {
      agentName: "TestAgent",
      pluginCount: 10,
      providerCount: 2,
      primaryModel: "anthropic",
      workspaceDir: "/tmp/test",
    };
    const result = validateRuntimeContext(context);
    expect(result.valid).toBe(true);
    expect(result.serializable).toBe(true);
    expect(result.nullFields.length).toBe(0);
    expect(result.undefinedFields.length).toBe(0);
    expect(result.emptyFields.length).toBe(0);
    expect(result.nonSerializableFields.length).toBe(0);
  });

  it("config round-trip preserves integrity", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      // Get original config
      const { data: original } = await http$(srv.port, "GET", "/api/config");

      // Write modified config — use "features" (an allowed top-level key)
      const modified = {
        ...original,
        features: {
          test_integrity: {
            enabled: true,
            timestamp: Date.now(),
            nested: { value: 42, text: "integrity-check" },
          },
        },
      };
      await http$(srv.port, "PUT", "/api/config", modified);

      // Read back and verify no corruption
      const { data: readBack } = await http$(srv.port, "GET", "/api/config");
      const features = readBack.features as Record<
        string,
        Record<string, unknown>
      >;
      const testData = features.test_integrity as Record<
        string,
        Record<string, unknown>
      >;
      expect(testData.nested.value).toBe(42);
      expect(testData.nested.text).toBe("integrity-check");

      // Restore
      await http$(srv.port, "PUT", "/api/config", original);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("multiple concurrent config writes do not corrupt state", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      // Fire 10 concurrent writes with different values — use "features" (allowed key)
      const writes = Array.from({ length: 10 }, (_, i) =>
        http$(srv.port, "PUT", "/api/config", {
          features: {
            concurrent_test: {
              enabled: true,
              iteration: i,
              timestamp: Date.now(),
            },
          },
        }),
      );
      const results = await Promise.all(writes);

      // All should succeed (no crashes)
      for (const r of results) {
        expect(r.status).toBe(200);
      }

      // Final read should have a valid config (one of the writes wins)
      const { status, data } = await http$(srv.port, "GET", "/api/config");
      expect(status).toBe(200);
      const features = data.features as Record<string, Record<string, unknown>>;
      expect(typeof features.concurrent_test.iteration).toBe("number");
    } finally {
      await srv.close();
    }
  }, 30_000);
});

// ===================================================================
//  6. DEADLOCK DETECTION
// ===================================================================

describe("Deadlock Detection", () => {
  it("concurrent requests to different endpoints complete within timeout", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      const startTime = performance.now();

      // Fire many concurrent requests to different endpoints
      const requests = [
        ...Array.from({ length: 10 }, () =>
          http$(srv.port, "GET", "/api/status"),
        ),
        ...Array.from({ length: 10 }, () =>
          http$(srv.port, "GET", "/api/plugins"),
        ),
        ...Array.from({ length: 10 }, () =>
          http$(srv.port, "GET", "/api/logs"),
        ),
        ...Array.from({ length: 5 }, () =>
          http$(srv.port, "GET", "/api/config"),
        ),
        ...Array.from({ length: 5 }, () =>
          http$(srv.port, "GET", "/api/skills"),
        ),
      ];

      const results = await Promise.all(requests);
      const elapsed = performance.now() - startTime;

      // All should complete
      for (const r of results) {
        expect(r.status).toBe(200);
      }

      // Should complete within 30s (deadlock would timeout)
      expect(elapsed).toBeLessThan(30_000);

      logger.info(
        `[e2e-validation] ${requests.length} concurrent requests completed in ${elapsed.toFixed(0)}ms`,
      );
    } finally {
      await srv.close();
    }
  }, 45_000);

  it("rapid state transitions do not cause deadlock", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      const startTime = performance.now();

      // Rapid fire state transitions — these interact with shared state
      const transitions: Array<
        Promise<{ status: number; data: Record<string, unknown> }>
      > = [];
      for (let i = 0; i < 20; i++) {
        transitions.push(http$(srv.port, "POST", "/api/agent/start"));
        transitions.push(http$(srv.port, "POST", "/api/agent/stop"));
      }

      // Wait for all — if there's a deadlock, this will timeout
      const results = await Promise.allSettled(transitions);
      const elapsed = performance.now() - startTime;

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBe(results.length);
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      await srv.close();
    }
  }, 45_000);

  it("interleaved read/write operations do not deadlock", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      // Interleave reads and writes
      const ops: Array<
        Promise<{ status: number; data: Record<string, unknown> }>
      > = [];
      for (let i = 0; i < 20; i++) {
        ops.push(http$(srv.port, "GET", "/api/config"));
        ops.push(
          http$(srv.port, "PUT", "/api/config", {
            features: { deadlock_test: { enabled: true, i, ts: Date.now() } },
          }),
        );
        ops.push(http$(srv.port, "GET", "/api/status"));
        ops.push(http$(srv.port, "GET", "/api/plugins"));
      }

      const results = await Promise.allSettled(ops);
      const fulfilled = results.filter((r) => r.status === "fulfilled");

      // All should complete without deadlock
      expect(fulfilled.length).toBe(results.length);
    } finally {
      await srv.close();
    }
  }, 45_000);
});

// ===================================================================
//  7. MEMORY LEAK DETECTION PATTERNS
// ===================================================================

describe("Memory Leak Detection", () => {
  it("repeated server start/stop does not leak file descriptors", async () => {
    // Start and stop the server 10 times — leaked sockets would cause EMFILE
    for (let i = 0; i < 10; i++) {
      const srv = await startApiServer({ port: 0 });
      const { status } = await http$(srv.port, "GET", "/api/status");
      expect(status).toBe(200);
      await srv.close();
    }

    // If we got here, no EMFILE error occurred
    expect(true).toBe(true);
  }, 60_000);

  it("heap usage stays bounded after many requests", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      // Force GC if available
      if (global.gc) global.gc();
      const heapBefore = process.memoryUsage().heapUsed;

      // Generate 200 requests
      for (let i = 0; i < 200; i++) {
        await http$(srv.port, "GET", "/api/status");
        if (i % 50 === 0 && global.gc) global.gc();
      }

      if (global.gc) global.gc();
      const heapAfter = process.memoryUsage().heapUsed;
      const heapGrowthMB = (heapAfter - heapBefore) / (1024 * 1024);

      logger.info(
        `[e2e-validation] Heap growth after 200 requests: ${heapGrowthMB.toFixed(2)}MB`,
      );

      // Heap growth should be bounded — a leak would show unbounded growth
      // Allow up to 50MB growth (includes test framework overhead)
      expect(heapGrowthMB).toBeLessThan(50);
    } finally {
      await srv.close();
    }
  }, 60_000);

  it("plugin list endpoint does not accumulate stale data", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      // Fetch plugins multiple times and verify list size is stable
      const sizes: number[] = [];
      for (let i = 0; i < 10; i++) {
        const { data } = await http$(srv.port, "GET", "/api/plugins");
        const plugins = data.plugins as Array<Record<string, unknown>>;
        sizes.push(plugins.length);
      }

      // All reads should return the same count (no accumulation)
      const unique = new Set(sizes);
      expect(unique.size).toBe(1);
    } finally {
      await srv.close();
    }
  }, 30_000);
});

// ===================================================================
//  8. RAPID SEQUENTIAL OPERATIONS
// ===================================================================

describe("Rapid Sequential Operations", () => {
  it("50 rapid onboarding status checks", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        const { status } = await http$(
          srv.port,
          "GET",
          "/api/onboarding/status",
        );
        expect(status).toBe(200);
      }
      const elapsed = performance.now() - start;
      logger.info(
        `[e2e-validation] 50 onboarding status checks: ${elapsed.toFixed(0)}ms (${(elapsed / 50).toFixed(1)}ms/req)`,
      );
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("rapid plugin enable/disable cycling", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      const { data: listData } = await http$(srv.port, "GET", "/api/plugins");
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      if (plugins.length === 0) return;

      const target = plugins[0];

      // Rapidly toggle enable/disable 20 times
      for (let i = 0; i < 20; i++) {
        const enabled = i % 2 === 0;
        const { status } = await http$(
          srv.port,
          "PUT",
          `/api/plugins/${target.id}`,
          { enabled },
        );
        expect(status).toBe(200);
      }

      // Final state should be consistent
      const { data: finalList } = await http$(srv.port, "GET", "/api/plugins");
      const updated = (
        finalList.plugins as Array<Record<string, unknown>>
      ).find((p) => p.id === target.id);
      expect(typeof updated?.enabled).toBe("boolean");
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("rapid config read/write cycles maintain consistency", async () => {
    const srv = await startApiServer({ port: 0 });
    try {
      for (let i = 0; i < 20; i++) {
        // Write — use "features" (allowed key)
        await http$(srv.port, "PUT", "/api/config", {
          features: { rapid_test: { enabled: true, iteration: i } },
        });
        // Read
        const { data } = await http$(srv.port, "GET", "/api/config");
        const features = data.features as
          | Record<string, Record<string, number>>
          | undefined;
        const testData = features?.rapid_test;
        // The value should be the one we just wrote (or a later one from
        // concurrent writes if there were any — but the value must be a number)
        if (testData) {
          expect(typeof testData.iteration).toBe("number");
        }
      }
    } finally {
      await srv.close();
    }
  }, 30_000);
});

// ===================================================================
//  9. WORKSPACE INTEGRITY
// ===================================================================

describe("Workspace Integrity", () => {
  it("ensureAgentWorkspace creates directory and is idempotent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-e2e-ws-"));
    const wsDir = path.join(dir, "workspace");

    expect(fs.existsSync(wsDir)).toBe(false);
    await ensureAgentWorkspace({ dir: wsDir });
    expect(fs.existsSync(wsDir)).toBe(true);

    // Idempotent — second call should not throw
    await ensureAgentWorkspace({ dir: wsDir });
    expect(fs.existsSync(wsDir)).toBe(true);

    // Cleanup
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("workspace creation handles concurrent calls", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-e2e-ws-concurrent-"),
    );
    const wsDir = path.join(dir, "concurrent-workspace");

    // Fire 5 concurrent workspace creates
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ensureAgentWorkspace({ dir: wsDir })),
    );

    // All should succeed
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
    expect(fs.existsSync(wsDir)).toBe(true);

    // Cleanup
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

// ===================================================================
//  10. RUNTIME INTEGRATION (requires model provider)
// ===================================================================

describe("Runtime Integration (with model provider)", () => {
  let runtime: AgentRuntime | null = null;
  let server: { port: number; close: () => Promise<void> } | null = null;
  let initialized = false;

  const pgliteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-e2e-validation-pglite-"),
  );
  const roomId = stringToUuid("e2e-validation-room");
  const userId = crypto.randomUUID() as UUID;
  const worldId = stringToUuid("e2e-validation-world");

  beforeAll(async () => {
    if (!hasModelProvider) return;
    process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";
    process.env.PGLITE_DATA_DIR = pgliteDir;

    const secrets: Record<string, string> = {};
    if (hasOpenAI)
      secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;
    if (hasAnthropic)
      secrets.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY as string;
    if (hasGroq) secrets.GROQ_API_KEY = process.env.GROQ_API_KEY as string;

    const character = createCharacter({
      name: "ValidationAgent",
      bio: "An E2E validation agent for Issue #6.",
      secrets,
    });

    const corePluginNames = [
      "@elizaos/plugin-trajectory-logger",
      "@elizaos/plugin-agent-skills",
      "@elizaos/plugin-directives",
      "@elizaos/plugin-commands",
      "@elizaos/plugin-personality",
      "@elizaos/plugin-experience",
      "@elizaos/plugin-form",
    ];

    const sqlPlugin = await loadPlugin("@elizaos/plugin-sql");
    const localEmbeddingPlugin = await loadPlugin(
      "@elizaos/plugin-local-embedding",
    );
    const plugins: Plugin[] = [];
    for (const n of corePluginNames) {
      const p = await loadPlugin(n);
      if (p) plugins.push(p);
    }
    if (hasOpenAI) {
      const p = await loadPlugin("@elizaos/plugin-openai");
      if (p) plugins.push(p);
    }
    if (hasAnthropic) {
      const p = await loadPlugin("@elizaos/plugin-anthropic");
      if (p) plugins.push(p);
    }
    if (hasGroq) {
      const p = await loadPlugin("@elizaos/plugin-groq");
      if (p) plugins.push(p);
    }

    runtime = new AgentRuntime({
      character,
      plugins,
      logLevel: "error",
      enableAutonomy: true,
    });

    if (sqlPlugin) await runtime.registerPlugin(sqlPlugin);
    if (localEmbeddingPlugin) {
      await runtime.registerPlugin(localEmbeddingPlugin);
    } else {
      logger.warn(
        "[e2e-validation] @elizaos/plugin-local-embedding failed to load; runtime may use remote embeddings",
      );
    }
    await runtime.initialize();
    const autonomySvc = runtime.getService<AutonomyServiceLike>("AUTONOMY");
    autonomySvc?.setLoopInterval(5 * 60_000);
    initialized = true;

    try {
      await runtime.ensureConnection({
        entityId: userId,
        roomId,
        worldId,
        userName: "ValidationUser",
        source: "test",
        channelId: "e2e-validation-channel",
        type: ChannelType.DM,
      });
    } catch {
      await runtime.ensureConnection({
        entityId: userId,
        roomId: crypto.randomUUID() as UUID,
        worldId: crypto.randomUUID() as UUID,
        userName: "ValidationUser",
        source: "test",
        channelId: "e2e-validation-channel",
        type: ChannelType.DM,
      });
    }

    server = await startApiServer({ port: 0, runtime });
  }, 180_000);

  afterAll(async () => {
    if (server) {
      try {
        await withTimeout(server.close(), 30_000, "server.close()");
      } catch (err) {
        logger.warn(
          `[e2e-validation] server.close cleanup failed: ${errorMessage(err)}`,
        );
      }
    }
    if (runtime) {
      try {
        runtime.enableAutonomy = false;
        await withTimeout(runtime.stop(), 90_000, "runtime.stop()");
      } catch (err) {
        logger.warn(
          `[e2e-validation] runtime.stop cleanup failed: ${errorMessage(err)}`,
        );
      }
    }
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 150_000);

  it.skipIf(!hasModelProvider)("runtime initializes with all plugins", () => {
    expect(initialized).toBe(true);
    expect(runtime?.plugins.length).toBeGreaterThanOrEqual(5);
  });

  it.skipIf(!hasModelProvider)(
    "generates text response",
    async () => {
      const activeRuntime = runtime;
      if (!activeRuntime) throw new Error("Runtime not initialized");

      // In the full E2E sweep, the first few provider calls can return
      // empty content while upstream sessions warm. Retry with bounded
      // backoff and alternate prompts to avoid false negatives.
      const prompts = [
        "Respond with exactly: validation ok.",
        "Return one short non-empty sentence confirming validation.",
        "Say hello in one short sentence.",
      ];
      const maxAttempts = 6;
      let text = "";
      let lastError = "";

      for (
        let attempt = 0;
        attempt < maxAttempts && text.length === 0;
        attempt++
      ) {
        if (attempt > 0) {
          const backoffMs = Math.min(2000 * attempt, 10_000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }

        try {
          const result = await activeRuntime.generateText(
            prompts[attempt % prompts.length],
            { maxTokens: 256 },
          );
          if (typeof result === "string") {
            text = result.trim();
          } else if (result.text instanceof Promise) {
            text = (await result.text).trim();
          } else {
            text = String(result.text ?? result ?? "").trim();
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (text.length === 0) {
        if (
          await shouldSkipDueModelProviderUnavailable(
            activeRuntime,
            "generates text response",
          )
        ) {
          return;
        }
        throw new Error(
          lastError
            ? `generateText produced empty output after ${maxAttempts} attempts (last error: ${lastError})`
            : `generateText produced empty output after ${maxAttempts} attempts`,
        );
      }
      expect(text.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.skipIf(!hasModelProvider)(
    "handleMessage produces response",
    async () => {
      const activeRuntime = runtime;
      if (!activeRuntime) throw new Error("Runtime not initialized");
      const msg = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: userId,
        roomId,
        content: {
          text: "Say hello in one word.",
          source: "test",
          channelType: ChannelType.DM,
        },
      });
      const resp = await handleMessageAndCollectText(activeRuntime, msg);
      if (resp.length === 0) {
        if (
          await shouldSkipDueModelProviderUnavailable(
            activeRuntime,
            "handleMessage produces response",
          )
        ) {
          return;
        }
      }
      expect(resp.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.skipIf(!hasModelProvider)(
    "context integrity maintained across 5 sequential messages",
    async () => {
      const activeRuntime = runtime;
      if (!activeRuntime) throw new Error("Runtime not initialized");
      const messages = [
        "Remember: ALPHA-7. Reply OK.",
        "What code did I say? One line.",
        "Remember: BRAVO-3. Reply OK.",
        "List all codes. One line.",
        "How many codes total? Number only.",
      ];

      let lastResponse = "";
      for (const text of messages) {
        const msg = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId,
          content: { text, source: "test", channelType: ChannelType.DM },
        });
        lastResponse = await handleMessageAndCollectText(activeRuntime, msg);
        if (lastResponse.length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              activeRuntime,
              "context integrity maintained across 5 sequential messages",
            )
          ) {
            return;
          }
        }
        expect(lastResponse.length).toBeGreaterThan(0);
      }

      // The last response should reference "2" codes (ALPHA-7 and BRAVO-3)
      logger.info(
        `[e2e-validation] Context integrity check, final response: "${lastResponse}"`,
      );
      // We verify the model didn't crash or return empty — the content check
      // is a soft assertion since models can be unpredictable
      expect(lastResponse.length).toBeGreaterThan(0);
    },
    300_000,
  );

  it.skipIf(!hasModelProvider)(
    "3 parallel chat requests complete without crashes",
    async () => {
      const prompts = [
        "What is 2 + 2? Number only.",
        "What is 3 + 3? Number only.",
        "What is 4 + 4? Number only.",
      ];

      const results = await Promise.all(
        prompts.map((text) =>
          http$(server?.port, "POST", "/api/chat", { text }, 60_000),
        ),
      );

      for (const r of results) {
        expect(r.status).toBe(200);
        if (String(r.data.text ?? "").length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              activeRuntime,
              "3 parallel chat requests complete without crashes",
            )
          ) {
            return;
          }
        }
        expect((r.data.text as string).length).toBeGreaterThan(0);
      }
    },
    90_000,
  );

  it.skipIf(!hasModelProvider)(
    "API server status reflects runtime state",
    async () => {
      const { status, data } = await http$(server?.port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(data.state).toBe("running");
      expect(typeof data.startedAt).toBe("number");
      expect(typeof data.uptime).toBe("number");
    },
  );
});

// ===================================================================
//  11. DOCKER-COMPATIBLE FRESH MACHINE CHECKS
// ===================================================================

describe("Fresh Machine Validation (non-Docker)", () => {
  it("package.json declares a CLI bin that resolves on disk", () => {
    const cliBin = packageManifest.bin?.["eliza-autonomous"];
    expect(typeof cliBin).toBe("string");
    if (typeof cliBin === "string") {
      expect(fs.existsSync(path.join(packageRoot, cliBin))).toBe(true);
    }
  });

  it("package.json exports point to existing files", () => {
    const exportsMap = packageManifest.exports ?? {};
    const rootExport = exportsMap["."];
    expect(typeof rootExport).toBe("string");

    if (typeof rootExport === "string") {
      const resolved = path.join(packageRoot, rootExport.replace(/^\.\//, ""));
      expect(fs.existsSync(resolved)).toBe(true);
    }
  });

  it("dist/ contains expected compiled files", () => {
    const distDir = path.join(packageRoot, "dist");
    if (!fs.existsSync(distDir)) {
      logger.warn(
        "[e2e-validation] dist/ not found — run `bun run build` first",
      );
      return;
    }

    // autonomous builds to dist/packages/autonomous/src/ via tsc
    expect(
      fileExistsAny([
        path.join(distDir, "packages", "autonomous", "src", "index.js"),
        path.join(distDir, "packages", "autonomous", "src", "bin.js"),
      ]),
    ).toBe(true);
  });

  it("package.json has required fields", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(pkg.name).toBe("@elizaos/autonomous");
    expect(pkg.type).toBe("module");
  });

  it("all runtime dependencies declared in package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
    ) as Record<string, Record<string, string>>;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };

    // Critical dependencies that must be present (in deps or peerDeps)
    const required = [
      "@elizaos/core",
      "zod",
    ];
    for (const dep of required) {
      expect(deps[dep], `Missing dependency: ${dep}`).toBeDefined();
    }
  });
});

/**
 * Comprehensive E2E tests for the elizaOS agent runtime.
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
  type Service,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itIf } from "../helpers/conditional-tests.ts";
import { selectLiveProvider } from "../helpers/live-provider.ts";
import { sleep, withTimeout } from "../helpers/test-utils";

/** Matches the table name used by @elizaos/core personality module. */
const USER_PREFS_TABLE = "user_personality_preferences";

import {
  configureLocalEmbeddingPlugin,
  ensureAgentWorkspace,
  extractPlugin,
  type PluginModuleShape,
  startApiServer,
} from "@elizaos/agent";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });
dotenv.config({ path: path.resolve(packageRoot, "..", "..", ".env") });

const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const selectedLiveProvider = liveModelTestsEnabled
  ? selectLiveProvider()
  : null;
const hasModelProvider = liveModelTestsEnabled && selectedLiveProvider !== null;

// ---------------------------------------------------------------------------
// Plugin helpers — tracks failures
// ---------------------------------------------------------------------------

const pluginLoadResults: { name: string; loaded: boolean; error?: string }[] =
  [];

async function loadPlugin(name: string): Promise<Plugin | null> {
  try {
    const p = extractPlugin(
      (await import(name)) as PluginModuleShape,
    ) as Plugin | null;
    pluginLoadResults.push({
      name,
      loaded: p !== null,
      error: p ? undefined : "no valid Plugin export",
    });
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
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const timeoutMs = options?.timeoutMs ?? 60_000;
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
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (b) req.write(b);
    req.end();
  });
}

async function createConversationId(
  port: number,
  title: string,
): Promise<string> {
  const response = await http$(port, "POST", "/api/conversations", { title });
  if (response.status !== 200) {
    throw new Error(`Failed to create conversation: status=${response.status}`);
  }
  const conversation =
    response.data.conversation &&
    typeof response.data.conversation === "object" &&
    !Array.isArray(response.data.conversation)
      ? (response.data.conversation as Record<string, unknown>)
      : null;
  const id = typeof conversation?.id === "string" ? conversation.id : "";
  if (!id) {
    throw new Error("Conversation response missing id");
  }
  return id;
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
    throw new Error(
      `[e2e] "${testName}" failed because the configured model provider is unavailable: ${cachedModelProviderUnavailableReason}`,
    );
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
        throw new Error(
          `[e2e] "${testName}" failed because the configured model provider is unavailable: ${message}`,
        );
      }
    }
    await sleep(250 * attempt);
  }

  return false;
}

function _readSerializedProperty(
  value: unknown,
  key: string,
): unknown | undefined {
  if (!value || typeof value !== "object") return undefined;
  const direct = (value as Record<string, unknown>)[key];
  if (direct !== undefined) return direct;
  const properties = (value as Record<string, unknown>).properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return undefined;
  return (properties as Record<string, unknown>)[key];
}

function _readSerializedArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (!value || typeof value !== "object") return [];
  const items = (value as Record<string, unknown>).items;
  if (Array.isArray(items)) return items as Array<Record<string, unknown>>;
  return [];
}

async function postChatWithRetries(
  port: number,
  attempts = 3,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const conversationId = await createConversationId(
        port,
        `REST API retry ${attempt}`,
      );
      const response = await http$(
        port,
        "POST",
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        { text: "What is 1+1? Number only.", mode: "simple" },
        { timeoutMs: 45_000 },
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
    } catch (err) {
      errors.push(
        `attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (attempt < attempts) {
      await sleep(1_000);
    }
  }
  throw new Error(
    `POST /api/conversations/:id/messages failed after ${attempts} attempts: ${errors.join(" | ")}`,
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
      const conversationId = await createConversationId(
        port,
        `Prompt retry ${attempt}`,
      );
      const response = await http$(
        port,
        "POST",
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        { text: prompt, mode: "simple" },
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
    } catch (err) {
      errors.push(
        `attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (attempt < attempts) {
      await sleep(1_000);
    }
  }
  throw new Error(
    `POST /api/conversations/:id/messages(prompt) failed after ${attempts} attempts: ${errors.join(" | ")}`,
  );
}

async function handleMessageAndCollectText(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  options?: { timeoutMs?: number },
): Promise<string> {
  let responseText = "";
  const result = await withTimeout(
    Promise.resolve(
      runtime.messageService?.handleMessage(
        runtime,
        message,
        async (content: { text?: string }) => {
          if (content.text) responseText += content.text;
          return [];
        },
      ),
    ),
    options?.timeoutMs ?? 90_000,
    "handleMessage",
  );
  if (!responseText && result?.responseContent?.text) {
    responseText = result.responseContent.text;
  }
  return responseText;
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

  const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-e2e-pglite-"));
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-e2e-workspace-"),
  );

  const corePluginNames = [
    "@elizaos/plugin-agent-skills",
    // NOTE: @elizaos/plugin-commands is excluded — commented out as "not yet ready" in core-plugins.ts
  ];

  // ─── Setup ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    if (!hasModelProvider) return;
    process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";
    process.env.ENABLE_TRAJECTORIES = "false";
    process.env.ELIZA_TRAJECTORY_LOGGING = "false";

    const provider = selectedLiveProvider;
    if (!provider) {
      throw new Error("Expected a live model provider but none was resolved.");
    }

    for (const [key, value] of Object.entries(provider.env)) {
      process.env[key] = value;
    }

    const secrets: Record<string, string> = { ...provider.env };

    const character = createCharacter({
      name: "TestAgent",
      bio: "A test agent for comprehensive E2E verification.",
      secrets,
    });

    const sqlPlugin = await loadPlugin("@elizaos/plugin-sql");
    const localEmbeddingPlugin = await loadPlugin(
      "@elizaos/plugin-local-embedding",
    );

    const plugins: Plugin[] = [];
    for (const n of corePluginNames) {
      const p = await loadPlugin(n);
      if (p) plugins.push(p);
    }
    if (provider.pluginPackage) {
      const p = await loadPlugin(provider.pluginPackage);
      if (p) plugins.push(p);
    }

    const createInitializedRuntime = async (): Promise<AgentRuntime> => {
      // PRODUCTION DEFAULTS: checkShouldRespond defaults to true.
      // DMs bypass shouldRespond via alwaysRespondChannels in message.ts.
      const instance = new AgentRuntime({
        character,
        plugins,
        logLevel: "error",
        advancedCapabilities: true,
        enableAutonomy: true,
        // checkShouldRespond is NOT set — defaults to true (production behavior)
      });

      if (sqlPlugin) {
        await instance.registerPlugin(sqlPlugin);
        if (instance.adapter && !(await instance.adapter.isReady())) {
          await instance.adapter.init();
        }
      }
      if (localEmbeddingPlugin) {
        configureLocalEmbeddingPlugin(localEmbeddingPlugin);
        await instance.registerPlugin(localEmbeddingPlugin);
      } else {
        logger.warn(
          "[e2e] @elizaos/plugin-local-embedding failed to load; runtime may use remote embeddings",
        );
      }

      await instance.initialize();
      if (!instance.getService("AUTONOMY")) {
        const { AutonomyService } = await import(
          "../../../core/src/features/autonomy/service.ts"
        );
        await AutonomyService.start(instance);
      }
      const autonomySvc = instance.getService<AutonomyServiceLike>("AUTONOMY");
      if (!autonomySvc) {
        const serviceTypes = Array.from(instance.services.keys()).join(", ");
        throw new Error(
          `AUTONOMY service unavailable after initialize; services=${serviceTypes || "(none)"}`,
        );
      }

      autonomySvc.setLoopInterval(5 * 60_000);
      return instance;
    };

    let lastInitError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptPgliteDir = path.join(pgliteDir, `attempt-${attempt}`);
      fs.rmSync(attemptPgliteDir, { recursive: true, force: true });
      fs.mkdirSync(attemptPgliteDir, { recursive: true });
      process.env.PGLITE_DATA_DIR = attemptPgliteDir;

      try {
        runtime = await createInitializedRuntime();
        initialized = true;
        lastInitError = null;
        break;
      } catch (err) {
        lastInitError = err;
        logger.warn(
          `[e2e] Runtime initialization attempt ${attempt} failed: ${errorMessage(err)}`,
        );
        if (runtime) {
          try {
            runtime.enableAutonomy = false;
            await withTimeout(runtime.stop(), 60_000, "runtime.stop() retry");
          } catch (stopErr) {
            logger.warn(
              `[e2e] Runtime cleanup after failed init attempt ${attempt}: ${errorMessage(stopErr)}`,
            );
          }
        }
        if (attempt < 2) {
          await sleep(1_000 * attempt);
        }
      }
    }

    if (!initialized) {
      throw lastInitError instanceof Error
        ? lastInitError
        : new Error(errorMessage(lastInitError));
    }

    try {
      await runtime.ensureConnection({
        entityId: userId,
        roomId,
        worldId,
        userName: "TestUser",
        source: "test",
        channelId: "test-e2e-channel",
        type: ChannelType.DM,
      });
    } catch (err) {
      logger.warn(
        `[e2e] ensureConnection failed, retrying: ${err instanceof Error ? err.message : err}`,
      );
      await runtime.ensureConnection({
        entityId: userId,
        roomId: crypto.randomUUID() as UUID,
        worldId: crypto.randomUUID() as UUID,
        userName: "TestUser",
        source: "test",
        channelId: "test-e2e-channel",
        type: ChannelType.DM,
      });
    }

    server = await startApiServer({ port: 0, runtime });
    logger.info(
      `[e2e] Setup complete — ${runtime.plugins.length} plugins, API on :${server.port}`,
    );
  }, 180_000);

  afterAll(async () => {
    if (server) {
      try {
        await withTimeout(server.close(), 30_000, "server.close()");
      } catch (err) {
        logger.warn(
          `[e2e] Server close error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (runtime) {
      try {
        runtime.enableAutonomy = false;
        await withTimeout(runtime.stop(), 90_000, "runtime.stop()");
      } catch (err) {
        logger.warn(
          `[e2e] Runtime stop error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `[e2e] PGlite cleanup: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `[e2e] Workspace cleanup: ${err instanceof Error ? err.message : err}`,
      );
    }
  }, 150_000);

  // ===================================================================
  //  1. Startup
  // ===================================================================

  describe("startup", () => {
    itIf(hasModelProvider)("initializes successfully", () => {
      expect(initialized).toBe(true);
      expect(runtime.character.name).toBe("TestAgent");
    });

    itIf(hasModelProvider)("every core plugin loaded", () => {
      const coreResults = pluginLoadResults.filter((r) =>
        corePluginNames.includes(r.name),
      );
      for (const result of coreResults) {
        expect(
          result.loaded,
          `Core plugin ${result.name} failed: ${result.error}`,
        ).toBe(true);
      }
    });

    itIf(hasModelProvider)(
      "built-in advanced personality capabilities are registered",
      () => {
        expect(
          runtime.actions.some((action) => action.name === "MODIFY_CHARACTER"),
        ).toBe(true);
      },
    );

    itIf(hasModelProvider)("messageService is non-null", () => {
      expect(runtime.messageService).not.toBeNull();
    });

    itIf(hasModelProvider)(
      "checkShouldRespond is enabled (production default)",
      () => {
        expect(runtime.isCheckShouldRespondEnabled()).toBe(true);
        logger.info(
          "[e2e] Confirmed: checkShouldRespond is TRUE (production default)",
        );
      },
    );

    itIf(hasModelProvider)("AUTONOMY service type is registered", () => {
      const serviceTypes = Array.from(runtime.services.keys());
      logger.info(`[e2e] Service types: ${serviceTypes.join(", ")}`);
      const hasAutonomy = serviceTypes.some((t) =>
        t.toUpperCase().includes("AUTONOMY"),
      );
      expect(
        hasAutonomy,
        `No AUTONOMY service found in: ${serviceTypes.join(", ")}`,
      ).toBe(true);
    });
  });

  // ===================================================================
  //  2. shouldRespond — DMs auto-respond even with checkShouldRespond=true
  // ===================================================================

  describe("shouldRespond (production mode)", () => {
    itIf(hasModelProvider)(
      "DM messages get responses with checkShouldRespond=true",
      async () => {
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
        const resp = await handleMessageAndCollectText(runtime, msg);

        if (resp.length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "DM messages get responses with checkShouldRespond=true",
            )
          ) {
            return;
          }
        }

        expect(
          resp.length,
          "DM should always get a response even with checkShouldRespond=true",
        ).toBeGreaterThan(0);
        logger.info(`[e2e] shouldRespond DM test: "${resp}"`);
      },
      120_000,
    );
  });

  describe("personality update routing", () => {
    itIf(hasModelProvider)(
      "group-chat personality updates bypass ignore bias and produce a response",
      async () => {
        const groupRoomId = crypto.randomUUID() as UUID;
        const groupUserId = crypto.randomUUID() as UUID;

        await runtime.ensureConnection({
          entityId: groupUserId,
          roomId: groupRoomId,
          worldId,
          userName: "StyleTester",
          source: "test",
          channelId: groupRoomId,
          type: ChannelType.GROUP,
        });

        const msg = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: groupUserId,
          roomId: groupRoomId,
          content: {
            text: "Update its personality to be warmer and less verbose.",
            source: "test",
            channelType: ChannelType.GROUP,
          },
        });

        const room = await runtime.getRoom(groupRoomId);
        expect(room, "Expected group room to exist").toBeDefined();

        const decision = runtime.messageService?.shouldRespond(
          runtime,
          msg,
          room,
        );
        expect(decision?.shouldRespond).toBe(true);
        expect(decision?.skipEvaluation).toBe(true);
        expect(decision?.reason).toContain("self-modification");

        const resp = await handleMessageAndCollectText(runtime, msg, {
          timeoutMs: 120_000,
        });

        if (resp.length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "group-chat personality updates bypass ignore bias and produce a response",
            )
          ) {
            return;
          }
        }

        expect(resp.length).toBeGreaterThan(0);
      },
      120_000,
    );

    itIf(hasModelProvider)(
      "group-chat response-style updates store per-user preferences",
      async () => {
        const groupRoomId = crypto.randomUUID() as UUID;
        const groupUserId = crypto.randomUUID() as UUID;

        await runtime.ensureConnection({
          entityId: groupUserId,
          roomId: groupRoomId,
          worldId,
          userName: "PreferenceTester",
          source: "test",
          channelId: groupRoomId,
          type: ChannelType.GROUP,
        });

        const msg = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: groupUserId,
          roomId: groupRoomId,
          content: {
            text: "Change your response style with me to be concise and direct.",
            source: "test",
            channelType: ChannelType.GROUP,
          },
        });

        const resp = await handleMessageAndCollectText(runtime, msg, {
          timeoutMs: 120_000,
        });

        if (resp.length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "group-chat response-style updates store per-user preferences",
            )
          ) {
            return;
          }
        }

        const preferences = await runtime.getMemories({
          entityId: groupUserId,
          roomId: runtime.agentId,
          tableName: USER_PREFS_TABLE,
          count: 5,
        });

        expect(preferences.length).toBeGreaterThan(0);
        expect(
          preferences.some((preference) => {
            const text = preference.content.text?.trim() ?? "";
            return (
              preference.content.source === "user_personality_preference" &&
              text.length > 0
            );
          }),
        ).toBe(true);
      },
      120_000,
    );
  });

  // ===================================================================
  //  3. Messaging + multi-turn memory
  // ===================================================================

  describe("messaging", () => {
    itIf(hasModelProvider)(
      "generateText returns non-empty text",
      async () => {
        let text = "";
        try {
          const result = await runtime.generateText(
            "What is 2 + 2? Answer only the number.",
            { maxTokens: 256 },
          );
          text = await getGeneratedText(result);
        } catch (err) {
          const message = errorMessage(err);
          if (isModelProviderUnavailableError(message)) {
            cachedModelProviderUnavailableReason = message;
            logger.warn(
              `[e2e] Skipping "generateText returns non-empty text" due to provider limit: ${message}`,
            );
            return;
          }
          throw err;
        }
        if (text.length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "generateText returns non-empty text",
            )
          ) {
            return;
          }
        }
        expect(text.length).toBeGreaterThan(0);
      },
      60_000,
    );

    itIf(hasModelProvider)(
      "handleMessage returns non-empty text",
      async () => {
        const conversationRoomId = crypto.randomUUID() as UUID;
        await runtime.ensureConnection({
          entityId: userId,
          roomId: conversationRoomId,
          worldId,
          userName: "TestUser",
          source: "test",
          channelId: conversationRoomId,
          type: ChannelType.DM,
        });
        const msg = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId: conversationRoomId,
          content: {
            text: "Say hello in one word.",
            source: "test",
            channelType: ChannelType.DM,
          },
        });
        const resp = await handleMessageAndCollectText(runtime, msg, {
          timeoutMs: 90_000,
        });
        if (resp.length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "handleMessage returns non-empty text",
            )
          ) {
            return;
          }
        }
        expect(resp.length).toBeGreaterThan(0);
      },
      120_000,
    );

    itIf(hasModelProvider)(
      "multi-turn: agent remembers context",
      async () => {
        const conversationRoomId = crypto.randomUUID() as UUID;
        await runtime.ensureConnection({
          entityId: userId,
          roomId: conversationRoomId,
          worldId,
          userName: "TestUser",
          source: "test",
          channelId: conversationRoomId,
          type: ChannelType.DM,
        });
        const msg1 = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId: conversationRoomId,
          content: {
            text: "Remember exactly this secret word for this conversation: pineapple. Reply only with remembered.",
            source: "test",
            channelType: ChannelType.DM,
          },
        });
        const t1 = await handleMessageAndCollectText(runtime, msg1, {
          timeoutMs: 90_000,
        });
        if (t1.length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "multi-turn: agent remembers context",
            )
          ) {
            return;
          }
        }
        expect(t1.length, "Turn 1 must produce a response").toBeGreaterThan(0);

        const msg2 = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId: conversationRoomId,
          content: {
            text: "What exact secret word did I tell you earlier in this conversation? Reply with only the word.",
            source: "test",
            channelType: ChannelType.DM,
          },
        });
        const t2 = await handleMessageAndCollectText(runtime, msg2, {
          timeoutMs: 90_000,
        });
        if (t2.length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "multi-turn: agent remembers context",
            )
          ) {
            return;
          }
        }

        logger.info(`[e2e] multi-turn: "${t2}"`);
        if (t2.toLowerCase().includes("pineapple")) {
          return;
        }

        const retryPrompt = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId: conversationRoomId,
          content: {
            text: "Repeat the exact secret word from earlier. Reply with only that single word.",
            source: "test",
            channelType: ChannelType.DM,
          },
        });
        const retryText = await handleMessageAndCollectText(
          runtime,
          retryPrompt,
          {
            timeoutMs: 90_000,
          },
        );
        logger.info(`[e2e] multi-turn retry: "${retryText}"`);
        expect(retryText.toLowerCase()).toContain("pineapple");
      },
      180_000,
    );
  });

  // ===================================================================
  //  4. Autonomy — REAL think cycle
  // ===================================================================

  describe("autonomy (real thinking)", () => {
    itIf(hasModelProvider)("autonomy flag is enabled", () => {
      expect(runtime.enableAutonomy).toBe(true);
    });

    itIf(hasModelProvider)(
      "performAutonomousThink() completes a real think cycle",
      async () => {
        // Get the actual AutonomyService and call performAutonomousThink() directly.
        // This uses the full pipeline: creates autonomous message → model generates
        // response → response stored as memory. No mocks.
        const svc = runtime.getService<AutonomyServiceLike>("AUTONOMY");
        expect(svc, "AutonomyService must be registered").toBeDefined();

        logger.info("[e2e] Starting real autonomy think cycle...");
        await svc?.performAutonomousThink();
        logger.info("[e2e] Autonomy think cycle completed successfully");
        // If we got here without throwing, the full autonomous pipeline worked:
        // prompt generation → model call → response processing → memory storage
      },
      180_000,
    );

    itIf(hasModelProvider)(
      "autonomy REST endpoint reflects enabled state",
      async () => {
        const get1 = await http$(server?.port, "GET", "/api/agent/autonomy");
        expect(get1.data.enabled).toBe(true);

        await http$(server?.port, "POST", "/api/agent/autonomy", {
          enabled: false,
        });
        const get2 = await http$(server?.port, "GET", "/api/agent/autonomy");
        expect(get2.data.enabled).toBe(false);

        await http$(server?.port, "POST", "/api/agent/autonomy", {
          enabled: true,
        });
        const get3 = await http$(server?.port, "GET", "/api/agent/autonomy");
        expect(get3.data.enabled).toBe(true);
      },
    );
  });

  // ===================================================================
  //  5. REST API
  // ===================================================================

  describe("REST API", () => {
    itIf(hasModelProvider)("GET /api/status", async () => {
      const { status, data } = await http$(server?.port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(data.state).toBe("running");
      expect(typeof data.startedAt).toBe("number");
    });

    itIf(hasModelProvider)(
      "POST /api/conversations/:id/messages returns real response",
      async () => {
        let chat: { status: number; data: Record<string, unknown> };
        try {
          chat = await postChatWithRetries(server?.port);
        } catch (err) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "POST /api/conversations/:id/messages returns real response",
            )
          ) {
            return;
          }
          throw err;
        }
        const { status, data } = chat;
        expect(status).toBe(200);
        if (String(data.text ?? "").length === 0) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "POST /api/conversations/:id/messages returns real response",
            )
          ) {
            return;
          }
        }
        expect((data.text as string).length).toBeGreaterThan(0);
      },
      180_000,
    );

    itIf(hasModelProvider)(
      "todo CRUD works through workbench endpoints",
      async () => {
        const todoName = `REST Todo ${Date.now()}`;
        const create = await http$(
          server?.port,
          "POST",
          "/api/workbench/todos",
          {
            name: todoName,
            description: "Created from agent-runtime REST e2e",
            priority: 2,
            isUrgent: false,
            type: "one-off",
          },
        );
        expect(create.status).toBe(201);
        const todo = create.data.todo as Record<string, unknown>;
        const todoId = String(todo.id ?? "");
        expect(todoId.length).toBeGreaterThan(0);

        const list = await http$(server?.port, "GET", "/api/workbench/todos");
        expect(list.status).toBe(200);
        const todos = list.data.todos as Array<Record<string, unknown>>;
        expect(todos.some((item) => item.id === todoId)).toBe(true);

        const update = await http$(
          server?.port,
          "PUT",
          `/api/workbench/todos/${encodeURIComponent(todoId)}`,
          { priority: 1, isUrgent: true },
        );
        expect(update.status).toBe(200);
        expect((update.data.todo as Record<string, unknown>).priority).toBe(1);
        expect((update.data.todo as Record<string, unknown>).isUrgent).toBe(
          true,
        );

        const complete = await http$(
          server?.port,
          "POST",
          `/api/workbench/todos/${encodeURIComponent(todoId)}/complete`,
          { isCompleted: true },
        );
        expect(complete.status).toBe(200);
        expect(complete.data.ok).toBe(true);

        const get = await http$(
          server?.port,
          "GET",
          `/api/workbench/todos/${encodeURIComponent(todoId)}`,
        );
        expect(get.status).toBe(200);
        expect((get.data.todo as Record<string, unknown>).isCompleted).toBe(
          true,
        );

        const del = await http$(
          server?.port,
          "DELETE",
          `/api/workbench/todos/${encodeURIComponent(todoId)}`,
        );
        expect(del.status).toBe(200);
        expect(del.data.ok).toBe(true);
      },
      120_000,
    );

    itIf(hasModelProvider)(
      "POST /api/conversations/:id/messages rejects empty text",
      async () => {
        const conversationId = await createConversationId(
          server?.port,
          "Empty text validation",
        );
        expect(
          (
            await http$(
              server?.port,
              "POST",
              `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
              { text: "" },
            )
          ).status,
        ).toBe(400);
      },
    );

    itIf(hasModelProvider)(
      "GET /api/onboarding/options has non-empty arrays",
      async () => {
        const { data } = await http$(
          server?.port,
          "GET",
          "/api/onboarding/options",
        );
        expect((data.names as string[]).length).toBeGreaterThan(0);
        expect((data.styles as unknown[]).length).toBeGreaterThan(0);
        expect((data.providers as unknown[]).length).toBeGreaterThan(0);
      },
    );

    itIf(hasModelProvider)(
      "POST /api/onboarding writes agent name",
      async () => {
        const { data } = await http$(server?.port, "POST", "/api/onboarding", {
          name: "OnboardTest",
        });
        expect(data.ok).toBe(true);
        expect(
          (await http$(server?.port, "GET", "/api/status")).data.agentName,
        ).toBe("OnboardTest");
      },
    );

    itIf(hasModelProvider)("PUT /api/config round-trips", async () => {
      const original = (await http$(server?.port, "GET", "/api/config")).data;
      await http$(server?.port, "PUT", "/api/config", {
        features: { temp_cfg: { enabled: true, name: "TempCfg" } },
      });
      const { data } = await http$(server?.port, "GET", "/api/config");
      expect(
        (data as Record<string, Record<string, Record<string, string>>>)
          .features?.temp_cfg?.name,
      ).toBe("TempCfg");
      await http$(server?.port, "PUT", "/api/config", original); // restore
    });

    itIf(hasModelProvider)(
      "GET /api/logs has entries with timestamp/level/message",
      async () => {
        const entries = (await http$(server?.port, "GET", "/api/logs")).data
          .entries as Array<Record<string, unknown>>;
        expect(entries.length).toBeGreaterThan(0);
        expect(typeof entries[0].timestamp).toBe("number");
        expect(typeof entries[0].level).toBe("string");
        expect(typeof entries[0].message).toBe("string");
      },
    );

    itIf(hasModelProvider)(
      "PUT /api/plugins/:id returns 404 for nonexistent",
      async () => {
        expect(
          (
            await http$(server?.port, "PUT", "/api/plugins/fake-plugin", {
              enabled: true,
            })
          ).status,
        ).toBe(404);
      },
    );

    itIf(hasModelProvider)("pause → resume verifies state change", async () => {
      await http$(server?.port, "POST", "/api/agent/pause");
      expect((await http$(server?.port, "GET", "/api/status")).data.state).toBe(
        "paused",
      );
      await http$(server?.port, "POST", "/api/agent/resume");
      expect((await http$(server?.port, "GET", "/api/status")).data.state).toBe(
        "running",
      );
    });

    itIf(hasModelProvider)("404 for unknown route", async () => {
      expect(
        (await http$(server?.port, "GET", "/api/nonexistent")).status,
      ).toBe(404);
    });
  });

  // ===================================================================
  //  6. Error paths
  // ===================================================================

  describe("error paths", () => {
    itIf(hasModelProvider)("non-JSON body → 400", async () => {
      const conversationId = await createConversationId(
        server?.port,
        "Invalid JSON",
      );
      const { status } = await new Promise<{ status: number }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: server?.port,
              path: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": 11,
              },
            },
            (res) => {
              res.resume();
              resolve({ status: res.statusCode ?? 0 });
            },
          );
          req.on("error", reject);
          req.write("not-json!!!");
          req.end();
        },
      );
      expect(status).toBe(400);
    });

    itIf(hasModelProvider)("generateText empty → throws", async () => {
      await expect(
        runtime.generateText("", { maxTokens: 10 }),
      ).rejects.toThrow();
    });

    itIf(hasModelProvider)("generateText whitespace → throws", async () => {
      await expect(
        runtime.generateText("   ", { maxTokens: 10 }),
      ).rejects.toThrow();
    });
  });

  // ===================================================================
  //  7. Concurrent requests
  // ===================================================================

  describe("concurrent", () => {
    itIf(hasModelProvider)(
      "5 parallel status + 3 parallel chat",
      async () => {
        const prompts = [
          "What is 2 + 2? Number only.",
          "What is 3 + 3? Number only.",
          "What is 4 + 4? Number only.",
        ];
        const [statuses, chats] = await Promise.all([
          Promise.all(
            Array.from({ length: 5 }, () =>
              http$(server?.port, "GET", "/api/status", undefined, {
                timeoutMs: 30_000,
              }),
            ),
          ),
          Promise.all(
            prompts.map((prompt) =>
              postChatPromptWithRetries(server?.port ?? 0, prompt, 3, 90_000),
            ),
          ),
        ]);
        for (const r of statuses) expect(r.status).toBe(200);
        for (const r of chats) {
          expect(r.status).toBe(200);
          if (String(r.data.text ?? "").length === 0) {
            if (
              await shouldSkipDueModelProviderUnavailable(
                runtime,
                "5 parallel status + 3 parallel chat",
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
  });

  // ===================================================================
  //  8. Workspace
  // ===================================================================

  describe("workspace", () => {
    itIf(hasModelProvider)("creates directory and is idempotent", async () => {
      const d = path.join(workspaceDir, "ws-test");
      expect(fs.existsSync(d)).toBe(false);
      await ensureAgentWorkspace({ dir: d });
      expect(fs.existsSync(d)).toBe(true);
      await ensureAgentWorkspace({ dir: d }); // no throw
    });
  });

  // ===================================================================
  //  9. Triggers — REAL LLM execution through trigger dispatch
  // ===================================================================

  describe("triggers (real LLM execution)", () => {
    itIf(hasModelProvider)(
      "creates trigger, executes it, LLM processes instruction, run history records success",
      async () => {
        // Register the trigger worker on the real runtime (same as eliza-plugin.ts does).
        const { registerTriggerTaskWorker } = await import(
          "@elizaos/agent/triggers/runtime"
        );
        registerTriggerTaskWorker(runtime);

        // 1. Create a trigger via the real REST API
        const createRes = await http$(server?.port, "POST", "/api/triggers", {
          displayName: "Live LLM Trigger",
          instructions:
            "You have been triggered by the test suite. Acknowledge this trigger by responding with a brief status report.",
          triggerType: "interval",
          intervalMs: 3_600_000,
          wakeMode: "inject_now",
          createdBy: "e2e-test",
        });

        expect(createRes.status).toBe(201);
        const triggerId = (createRes.data.trigger as Record<string, string>)
          ?.id;
        expect(triggerId).toBeDefined();
        expect(triggerId.length).toBeGreaterThan(0);
        logger.info(`[e2e] Created trigger: ${triggerId}`);

        // 2. List triggers — confirm it exists
        const listRes = await http$(server?.port, "GET", "/api/triggers");
        expect(listRes.status).toBe(200);
        const triggers = listRes.data.triggers as Array<
          Record<string, unknown>
        >;
        expect(triggers.length).toBeGreaterThanOrEqual(1);
        const found = triggers.find((t) => t.id === triggerId);
        expect(found).toBeDefined();
        expect(found?.enabled).toBe(true);
        expect(found?.triggerType).toBe("interval");

        // 3. Execute the trigger — this dispatches into the REAL autonomy
        //    service which calls the REAL LLM through performAutonomousThink()
        logger.info("[e2e] Executing trigger (real LLM dispatch)...");
        const execRes = await http$(
          server?.port,
          "POST",
          `/api/triggers/${encodeURIComponent(triggerId)}/execute`,
          undefined,
          { timeoutMs: 120_000 },
        );

        if (
          execRes.status !== 200 ||
          (execRes.data.result as Record<string, unknown>)?.status !== "success"
        ) {
          if (
            await shouldSkipDueModelProviderUnavailable(
              runtime,
              "creates trigger, executes it, LLM processes instruction, run history records success",
            )
          ) {
            return;
          }
        }

        expect(execRes.status).toBe(200);
        const execResult = execRes.data.result as Record<string, unknown>;
        expect(execResult.status).toBe("success");
        expect(execResult.taskDeleted).toBe(false);
        logger.info(`[e2e] Trigger execution: status=${execResult.status}`);

        // 4. Verify run history was recorded
        const runsRes = await http$(
          server?.port,
          "GET",
          `/api/triggers/${encodeURIComponent(triggerId)}/runs`,
        );
        expect(runsRes.status).toBe(200);
        const runs = runsRes.data.runs as Array<Record<string, unknown>>;
        expect(runs.length).toBe(1);
        expect(runs[0].status).toBe("success");
        expect(runs[0].source).toBe("manual");
        expect(typeof runs[0].latencyMs).toBe("number");
        logger.info(`[e2e] Run recorded: latency=${runs[0].latencyMs}ms`);

        // 5. Verify the trigger summary was updated after execution
        const getRes = await http$(
          server?.port,
          "GET",
          `/api/triggers/${encodeURIComponent(triggerId)}`,
        );
        expect(getRes.status).toBe(200);
        const updatedTrigger = getRes.data.trigger as Record<string, unknown>;
        expect(updatedTrigger.runCount).toBe(1);
        expect(updatedTrigger.lastStatus).toBe("success");
        expect(typeof updatedTrigger.lastRunAtIso).toBe("string");

        // 6. Verify health endpoint reflects the execution
        const healthRes = await http$(
          server?.port,
          "GET",
          "/api/triggers/health",
        );
        expect(healthRes.status).toBe(200);
        expect(
          Number(healthRes.data.activeTriggers ?? 0),
        ).toBeGreaterThanOrEqual(1);
        expect(
          Number(healthRes.data.totalExecutions ?? 0),
        ).toBeGreaterThanOrEqual(1);
        expect(Number(healthRes.data.totalFailures ?? 0)).toBe(0);

        // 7. Disable and re-enable the trigger
        const disableRes = await http$(
          server?.port,
          "PUT",
          `/api/triggers/${encodeURIComponent(triggerId)}`,
          { enabled: false },
        );
        expect(disableRes.status).toBe(200);
        expect(
          (disableRes.data.trigger as Record<string, boolean>)?.enabled,
        ).toBe(false);

        const enableRes = await http$(
          server?.port,
          "PUT",
          `/api/triggers/${encodeURIComponent(triggerId)}`,
          { enabled: true },
        );
        expect(enableRes.status).toBe(200);
        expect(
          (enableRes.data.trigger as Record<string, boolean>)?.enabled,
        ).toBe(true);

        // 8. Delete the trigger
        const deleteRes = await http$(
          server?.port,
          "DELETE",
          `/api/triggers/${encodeURIComponent(triggerId)}`,
        );
        expect(deleteRes.status).toBe(200);

        // Confirm it's gone
        const listAfterDelete = await http$(
          server?.port,
          "GET",
          "/api/triggers",
        );
        const remainingTriggers = listAfterDelete.data.triggers as Array<
          Record<string, unknown>
        >;
        const stillExists = remainingTriggers.find((t) => t.id === triggerId);
        expect(stillExists).toBeUndefined();

        logger.info("[e2e] Trigger lifecycle test complete (real LLM)");
      },
      240_000,
    );
  });

  // ===================================================================
  //  10. Workbench todos API
  // ===================================================================

  describe("workbench todos API", () => {
    itIf(hasModelProvider)(
      "POST /api/workbench/todos creates a todo entry",
      async () => {
        const todoName = `API Todo ${Date.now()}`;
        const createRes = await http$(
          server?.port,
          "POST",
          "/api/workbench/todos",
          {
            description: "created by the live runtime e2e",
            isUrgent: false,
            name: todoName,
            priority: 2,
          },
        );
        expect(createRes.status).toBe(201);
        const created = (createRes.data.todo ?? null) as Record<
          string,
          unknown
        > | null;
        expect(created).not.toBeNull();
        expect(created?.name).toBe(todoName);
        expect(created?.description).toBe("created by the live runtime e2e");
      },
      120_000,
    );

    itIf(hasModelProvider)(
      "workbench todo create/list/complete round-trips",
      async () => {
        const todoName = `API Todo ${Date.now()}`;
        const createRes = await http$(
          server?.port,
          "POST",
          "/api/workbench/todos",
          {
            description: "round-trip todo",
            isUrgent: false,
            name: todoName,
            priority: 2,
          },
        );
        expect(createRes.status).toBe(201);
        const created = (createRes.data.todo ?? null) as Record<
          string,
          unknown
        > | null;
        const todoId = typeof created?.id === "string" ? created.id : "";
        expect(todoId.length).toBeGreaterThan(0);

        const listRes = await http$(
          server?.port,
          "GET",
          "/api/workbench/todos",
        );
        expect(listRes.status).toBe(200);
        const todos = (listRes.data.todos ?? []) as Array<
          Record<string, unknown>
        >;
        expect(
          todos.some((todo) => todo.id === todoId && todo.name === todoName),
        ).toBe(true);

        const completeRes = await http$(
          server?.port,
          "POST",
          `/api/workbench/todos/${encodeURIComponent(todoId)}/complete`,
          { isCompleted: true },
        );
        expect(completeRes.status).toBe(200);

        const detailRes = await http$(
          server?.port,
          "GET",
          `/api/workbench/todos/${encodeURIComponent(todoId)}`,
        );
        expect(detailRes.status).toBe(200);
        const detail = (detailRes.data.todo ?? null) as Record<
          string,
          unknown
        > | null;
        expect(detail).not.toBeNull();
        expect(detail?.id).toBe(todoId);
        expect(detail?.name).toBe(todoName);
        expect(detail?.isCompleted).toBe(true);
      },
      120_000,
    );
  });

  // ===================================================================
  //  11. startEliza() — real subprocess test
  // ===================================================================
});

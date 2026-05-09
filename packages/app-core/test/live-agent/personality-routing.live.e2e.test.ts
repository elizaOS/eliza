/**
 * E2E tests for personality-update routing through the real message pipeline.
 *
 * NO MOCKS. Real PGlite database, real model provider, real handleMessage()
 * execution for the routing case, plus real MODIFY_CHARACTER action execution
 * for the per-user preference storage case.
 *
 * Requires:
 *   - ELIZA_LIVE_TEST=1
 *   - at least one real model provider API key
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureLocalEmbeddingPlugin,
  extractPlugin,
  type TestPluginModule,
} from "@elizaos/agent";
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
import { afterAll, beforeAll, expect, it } from "vitest";
import { USER_PREFS_TABLE } from "../../../core/src/features/advanced-capabilities/personality/types.ts";
import { describeIf } from "../helpers/conditional-tests.ts";
import { selectLiveProvider } from "../helpers/live-provider.ts";
import { withTimeout } from "../helpers/test-utils";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });
dotenv.config({ path: path.resolve(packageRoot, "..", "..", ".env") });

const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const selectedLiveProvider = liveModelTestsEnabled
  ? selectLiveProvider()
  : null;
const hasModelProvider = liveModelTestsEnabled && selectedLiveProvider !== null;

async function loadPlugin(name: string): Promise<Plugin | null> {
  try {
    return extractPlugin(
      (await import(name)) as TestPluginModule,
    ) as Plugin | null;
  } catch (error) {
    logger.warn(
      `[e2e:personality] Failed to load plugin ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function handleMessageAndCollectText(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): Promise<string> {
  let responseText = "";

  const result = await withTimeout(
    Promise.resolve(
      runtime.messageService?.handleMessage(
        runtime,
        message,
        async (content: { text?: string }) => {
          if (content.text) {
            responseText += content.text;
          }
          return [];
        },
      ),
    ),
    90_000,
    "handleMessage",
  );

  if (!responseText && result?.responseContent?.text) {
    responseText = result.responseContent.text;
  }

  return responseText;
}

describeIf(hasModelProvider)("Personality Routing E2E", () => {
  let runtime: AgentRuntime;

  const pgliteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-personality-e2e-pglite-"),
  );
  const worldId = stringToUuid("personality-routing-world");

  beforeAll(async () => {
    process.env.LOG_LEVEL = "error";
    process.env.PGLITE_DATA_DIR = pgliteDir;

    if (!selectedLiveProvider) {
      throw new Error("No live model provider configured.");
    }
    for (const [key, value] of Object.entries(selectedLiveProvider.env)) {
      process.env[key] = value;
    }
    const secrets: Record<string, string> = {
      ...selectedLiveProvider.env,
    };

    const character = createCharacter({
      name: "PersonalityTestAgent",
      bio: "A test agent used to verify personality routing behavior.",
      secrets,
    });

    const plugins: Plugin[] = [];
    const sqlPlugin = await loadPlugin("@elizaos/plugin-sql");
    const localEmbeddingPlugin = await loadPlugin(
      "@elizaos/plugin-local-embedding",
    );
    const modelPlugin = await loadPlugin(selectedLiveProvider.pluginPackage);
    if (modelPlugin) {
      plugins.push(modelPlugin);
    }

    runtime = new AgentRuntime({
      character,
      plugins,
      advancedCapabilities: true,
      logLevel: "error",
    });

    if (sqlPlugin) {
      await runtime.registerPlugin(sqlPlugin);
      if (runtime.adapter && !(await runtime.adapter.isReady())) {
        await runtime.adapter.init();
      }
    }
    if (localEmbeddingPlugin) {
      configureLocalEmbeddingPlugin(localEmbeddingPlugin);
      await runtime.registerPlugin(localEmbeddingPlugin);
    }

    await runtime.initialize();

    await runtime.ensureWorldExists({
      id: worldId,
      name: "Personality Routing World",
      agentId: runtime.agentId,
    } as Parameters<typeof runtime.ensureWorldExists>[0]);
  }, 120_000);

  afterAll(async () => {
    if (runtime) {
      await withTimeout(runtime.stop(), 60_000, "runtime.stop()");
    }

    fs.rmSync(pgliteDir, { recursive: true, force: true });
  }, 90_000);

  it("group-chat personality-update phrasing bypasses ignore-biased shouldRespond gating", async () => {
    const userId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "StyleTester",
      name: "StyleTester",
      source: "discord",
      channelId: roomId,
      type: ChannelType.GROUP,
    });
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: "Update its personality to be warmer and less verbose.",
        source: "discord",
        channelType: ChannelType.GROUP,
      },
    });

    const room = await runtime.getRoom(roomId);
    expect(room).toBeDefined();

    const decision = runtime.messageService?.shouldRespond(
      runtime,
      message,
      room,
    );
    expect(decision?.shouldRespond).toBe(true);
    expect(decision?.skipEvaluation).toBe(true);
    expect(decision?.reason).toContain("self-modification");

    const responseText = await handleMessageAndCollectText(runtime, message);

    expect(responseText.length).toBeGreaterThan(0);
  }, 120_000);

  it("MODIFY_CHARACTER stores per-user preferences for response-style requests", async () => {
    const userId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "PreferenceTester",
      name: "PreferenceTester",
      source: "discord",
      channelId: roomId,
      type: ChannelType.GROUP,
    });
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: "Change your response style with me to be concise and direct.",
        source: "discord",
        channelType: ChannelType.GROUP,
      },
    });

    const modifyCharacterAction = runtime.actions.find(
      (action) => action.name === "MODIFY_CHARACTER",
    );
    expect(modifyCharacterAction).toBeDefined();

    const isValid = await modifyCharacterAction?.validate?.(runtime, message);
    expect(isValid).toBe(true);

    let responseText = "";
    const result = await modifyCharacterAction?.handler?.(
      runtime,
      message,
      undefined,
      undefined,
      async (content: { text?: string }) => {
        if (content.text) {
          responseText += content.text;
        }
        return [];
      },
    );

    if (!responseText && typeof result?.text === "string") {
      responseText = result.text;
    }

    expect(responseText.length).toBeGreaterThan(0);

    const preferences = await runtime.getMemories({
      entityId: userId,
      roomId: runtime.agentId,
      tableName: USER_PREFS_TABLE,
      count: 5,
    });

    expect(preferences.length).toBeGreaterThan(0);
    expect(
      preferences.some((preference) => {
        const text = preference.content.text?.toLowerCase() || "";
        return text.includes("concise") || text.includes("direct");
      }),
    ).toBe(true);
  }, 120_000);
});

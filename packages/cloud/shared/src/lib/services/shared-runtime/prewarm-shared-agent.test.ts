/**
 * Verifies provision-time prewarm uses the production character projection and
 * warms the exact model/provider pricing pair consumed by cache-only admission.
 * External cache, character, and Durable Object boundaries are deterministic mocks.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { UserCharacter } from "../../../db/repositories/characters";
import * as realLoggerNs from "../../utils/logger";

const realLogger = { ...realLoggerNs };

const calls: string[] = [];
const calculateCost = mock(
  async (model: string, provider: string, inputTokens: number, outputTokens: number) => {
    calls.push(`pricing:${provider}:${model}`);
    return { inputCost: inputTokens, outputCost: outputTokens, totalCost: 2 };
  },
);
const getById = mock(async (_id: string): Promise<UserCharacter | undefined> => undefined);
const warmInferenceAdmissionSnapshot = mock(async () => {
  calls.push("admission");
});
const coordinateSharedHistory = mock(async () => [] as unknown[]);
const loggerWarn = mock(() => {});

mock.module("../../pricing", () => ({
  calculateCost,
  getProviderFromModel: (model: string) => model.split("/", 1)[0] || "openai",
  normalizeModelName: (model: string) => model.split("/").at(-1) ?? model,
}));
mock.module("../characters/characters", () => ({ charactersService: { getById } }));
mock.module("../inference-admission-snapshot", () => ({ warmInferenceAdmissionSnapshot }));
mock.module("./conversation-coordinator", () => ({
  coordinateSharedHistory,
}));
mock.module("../../utils/logger", () => ({
  logger: { debug: mock(), error: mock(), info: mock(), warn: loggerWarn },
}));
mock.module("./run-shared-agent-turn", () => ({
  resolveSharedAgentTurnModel: (preferred?: string) => preferred?.trim() || null,
}));

const { prewarmSharedAgentTurnCaches } = await import("./prewarm-shared-agent");

afterAll(() => {
  mock.module("../../utils/logger", () => realLogger);
});

function agent(config: Record<string, unknown>, characterId: string | null = null): AgentSandbox {
  return {
    id: "agent-1",
    organization_id: "org-1",
    user_id: "user-1",
    agent_name: "Agent",
    agent_config: config,
    character_id: characterId,
  } as AgentSandbox;
}

beforeEach(() => {
  calls.length = 0;
  calculateCost.mockClear();
  getById.mockClear();
  getById.mockImplementation(async () => undefined);
  warmInferenceAdmissionSnapshot.mockClear();
  coordinateSharedHistory.mockClear();
  coordinateSharedHistory.mockImplementation(async () => []);
  loggerWarn.mockClear();
});

describe("prewarmSharedAgentTurnCaches model pricing", () => {
  test("warms the nested agent_config.character.model pricing pair", async () => {
    await prewarmSharedAgentTurnCaches(
      agent({
        model: "openai/gpt-top-level",
        character: { model: "anthropic/claude-nested" },
      }),
    );

    expect(calculateCost).toHaveBeenCalledWith("claude-nested", "anthropic", 1, 1, "bitrouter");
  });

  test("hydrates a linked character before warming its settings.model pricing pair", async () => {
    getById.mockImplementation(async () => {
      calls.push("character");
      return {
        id: "character-1",
        organization_id: "org-1",
        name: "Linked",
        settings: { model: "cerebras/gpt-oss-120b" },
      } as UserCharacter;
    });

    await prewarmSharedAgentTurnCaches(
      agent(
        {
          model: "openai/gpt-top-level",
          character: { model: "anthropic/claude-nested" },
        },
        "character-1",
      ),
    );

    expect(getById).toHaveBeenCalledWith("character-1");
    expect(calculateCost).toHaveBeenCalledWith("gpt-oss-120b", "cerebras", 1, 1, "bitrouter");
    expect(calls.indexOf("character")).toBeLessThan(calls.indexOf("pricing:cerebras:gpt-oss-120b"));
  });

  test("logs a conversation hydration rejection observed by allSettled", async () => {
    const error = new Error("conversation cache is warming");
    coordinateSharedHistory.mockRejectedValue(error);

    await expect(
      prewarmSharedAgentTurnCaches(agent({}), { namespace: {} as never }),
    ).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith(
      "[shared-runtime prewarm] leg failed; first turn falls back to warming 503s",
      expect.objectContaining({
        agentId: "agent-1",
        organizationId: "org-1",
        leg: "conversation-object",
        error: error.message,
      }),
    );
  });
});

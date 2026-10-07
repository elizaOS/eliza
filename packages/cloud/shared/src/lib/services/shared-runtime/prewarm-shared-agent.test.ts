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
const warmInferenceAdmissionGate = mock(async () => {
  calls.push("admission-gate");
});
const warmInferenceRateLimitGate = mock(async () => {
  calls.push("rate-limit-gate");
});
const coordinateSharedHistory = mock(async () => [] as unknown[]);
const coordinateSharedConversationPrewarm = mock(async (): Promise<void> => undefined);
const seedSharedAgentScopeCache = mock(async () => {
  calls.push("authorization-scope");
});
const loggerWarn = mock(() => {});

mock.module("../../pricing", () => ({
  calculateCost,
  getProviderFromModel: (model: string) => model.split("/", 1)[0] || "openai",
  normalizeModelName: (model: string) => model.split("/").at(-1) ?? model,
}));
mock.module("../characters", () => ({ charactersService: { getById } }));
mock.module("../inference-admission-snapshot", () => ({ warmInferenceAdmissionSnapshot }));
mock.module("../inference-admission-gate", () => ({
  warmInferenceAdmissionGate,
  warmInferenceRateLimitGate,
}));
mock.module("./conversation-coordinator", () => ({
  coordinateSharedConversationPrewarm,
  coordinateSharedHistory,
}));
mock.module("./resolve-shared-agent", () => ({
  seedSharedAgentScopeCache,
}));
mock.module("../../utils/logger", () => ({
  logger: { debug: mock(), error: mock(), info: mock(), warn: loggerWarn },
}));
mock.module("./run-shared-agent-turn", () => ({
  resolveSharedAgentTurnModel: (preferred?: string) => preferred?.trim() || null,
}));

const { prewarmPersonalSharedAgentTurnCaches, prewarmSharedAgentTurnCaches } = await import(
  "./prewarm-shared-agent"
);

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
  warmInferenceAdmissionGate.mockClear();
  warmInferenceAdmissionGate.mockImplementation(async () => {
    calls.push("admission-gate");
  });
  warmInferenceRateLimitGate.mockClear();
  warmInferenceRateLimitGate.mockImplementation(async () => {
    calls.push("rate-limit-gate");
  });
  coordinateSharedHistory.mockClear();
  coordinateSharedHistory.mockImplementation(async () => []);
  coordinateSharedConversationPrewarm.mockClear();
  coordinateSharedConversationPrewarm.mockImplementation(async () => undefined);
  seedSharedAgentScopeCache.mockClear();
  seedSharedAgentScopeCache.mockImplementation(async () => {
    calls.push("authorization-scope");
  });
  loggerWarn.mockClear();
});

describe("prewarmSharedAgentTurnCaches model pricing", () => {
  test("warms billed ledger and rate-limit authorities beside the policy snapshot", async () => {
    await prewarmSharedAgentTurnCaches(agent({}));

    expect(warmInferenceAdmissionGate).toHaveBeenCalledWith("org-1");
    expect(warmInferenceRateLimitGate).toHaveBeenCalledWith("org-1");
    expect(warmInferenceAdmissionSnapshot).toHaveBeenCalledWith("org-1");
  });

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

  test("requestContext runs the authorization-scope leg with the creating credential + steward id", async () => {
    const requestContext = { req: { header: () => undefined } };

    await prewarmSharedAgentTurnCaches(agent({}), {
      requestContext: requestContext as never,
      stewardUserId: "steward-user-1",
    });

    expect(seedSharedAgentScopeCache).toHaveBeenCalledTimes(1);
    const [ctx, seededAgent, stewardUserId] = seedSharedAgentScopeCache.mock
      .calls[0] as unknown as [unknown, { id: string }, string | undefined];
    expect(ctx).toBe(requestContext);
    expect(seededAgent.id).toBe("agent-1");
    expect(stewardUserId).toBe("steward-user-1");
  });

  test("without a requestContext the authorization-scope leg is skipped", async () => {
    await prewarmSharedAgentTurnCaches(agent({}));
    expect(seedSharedAgentScopeCache).not.toHaveBeenCalled();
  });

  test("logs an authorization-scope seeding rejection observed by allSettled", async () => {
    const error = new Error("cache backend unavailable");
    seedSharedAgentScopeCache.mockRejectedValue(error);

    await expect(
      prewarmSharedAgentTurnCaches(agent({}), {
        requestContext: { req: { header: () => undefined } } as never,
      }),
    ).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith(
      "[shared-runtime prewarm] leg failed; first turn falls back to warming 503s",
      expect.objectContaining({
        agentId: "agent-1",
        leg: "authorization-scope",
        error: error.message,
      }),
    );
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

describe("prewarmPersonalSharedAgentTurnCaches", () => {
  test("warms a personal room and rate-limit state without balance hydration", async () => {
    const namespace = { getByName: mock() } as never;
    const personalAgent = {
      id: "personal:user-1:org-1",
      organization_id: "org-1",
    };

    await prewarmPersonalSharedAgentTurnCaches(personalAgent, namespace);

    expect(warmInferenceRateLimitGate).toHaveBeenCalledWith("org-1");
    expect(warmInferenceAdmissionGate).not.toHaveBeenCalled();
    expect(coordinateSharedConversationPrewarm).toHaveBeenCalledWith(
      personalAgent.id,
      personalAgent.id,
      { namespace, startEmpty: true },
    );
  });

  test("keeps a failed personal prewarm observable and lets the typed retry path remain", async () => {
    const error = new Error("admission gate unavailable");
    warmInferenceRateLimitGate.mockRejectedValue(error);

    await expect(
      prewarmPersonalSharedAgentTurnCaches(
        { id: "personal:user-1:org-1", organization_id: "org-1" },
        {} as never,
      ),
    ).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith(
      "[shared-runtime prewarm] leg failed; first turn falls back to warming 503s",
      expect.objectContaining({
        agentId: "personal:user-1:org-1",
        organizationId: "org-1",
        leg: "rate-limit-gate",
        error: error.message,
      }),
    );
  });
});

describe("established Personal Shared cold prewarm", () => {
  test("preserves existing history and never hydrates a balance ledger", async () => {
    const namespace = {} as never;
    const a = { id: "personal:existing-preserved", organization_id: "org-preserved" };
    await prewarmPersonalSharedAgentTurnCaches(a, namespace, { warmConversation: false });
    expect(coordinateSharedConversationPrewarm).toHaveBeenCalledWith(a.id, a.id, {
      namespace,
      startEmpty: false,
    });
    expect(warmInferenceAdmissionGate).not.toHaveBeenCalled();
    expect(warmInferenceAdmissionSnapshot).not.toHaveBeenCalled();
    expect(calculateCost).not.toHaveBeenCalled();
  });

  test("starts rate and existing-room warmups before either has finished", async () => {
    let releaseRate!: () => void;
    let releaseRoom!: () => void;
    const rate = new Promise<void>((resolve) => {
      releaseRate = resolve;
    });
    const room = new Promise<void>((resolve) => {
      releaseRoom = resolve;
    });
    warmInferenceRateLimitGate.mockImplementation(() => rate);
    coordinateSharedConversationPrewarm.mockImplementation(() => room);
    const pending = prewarmPersonalSharedAgentTurnCaches(
      { id: "personal:parallel-existing", organization_id: "org-parallel" },
      {} as never,
      { warmConversation: false },
    );
    expect(warmInferenceRateLimitGate).toHaveBeenCalledTimes(1);
    expect(coordinateSharedConversationPrewarm).toHaveBeenCalledTimes(1);
    releaseRate();
    releaseRoom();
    await pending;
  });

  test("reuses successful warmup briefly and retries after its 30-second budget", async () => {
    const originalNow = Date.now;
    let now = 100_000;
    Date.now = () => now;
    try {
      const a = { id: "personal:ttl-existing", organization_id: "org-ttl" };
      await prewarmPersonalSharedAgentTurnCaches(a, {} as never, { warmConversation: false });
      await prewarmPersonalSharedAgentTurnCaches(a, {} as never, { warmConversation: false });
      expect(coordinateSharedConversationPrewarm).toHaveBeenCalledTimes(1);
      now += 30_001;
      await prewarmPersonalSharedAgentTurnCaches(a, {} as never, { warmConversation: false });
      expect(coordinateSharedConversationPrewarm).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a failed room warmup is observable and is not cached as success", async () => {
    const a = { id: "personal:failed-existing", organization_id: "org-failed" };
    coordinateSharedConversationPrewarm.mockRejectedValueOnce(new Error("room unavailable"));
    await prewarmPersonalSharedAgentTurnCaches(a, {} as never, { warmConversation: false });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[shared-runtime prewarm] leg failed; first turn falls back to warming 503s",
      expect.objectContaining({ leg: "existing-conversation-runtime", error: "room unavailable" }),
    );
    await prewarmPersonalSharedAgentTurnCaches(a, {} as never, { warmConversation: false });
    await prewarmPersonalSharedAgentTurnCaches(a, {} as never, { warmConversation: false });
    expect(coordinateSharedConversationPrewarm).toHaveBeenCalledTimes(2);
  });

  test("memoization is per actor and room rather than organization", async () => {
    const a = { id: "personal:rooms-existing", organization_id: "org-rooms" };
    await prewarmPersonalSharedAgentTurnCaches(a, {} as never, {
      warmConversation: false,
      conversationId: "room-one",
    });
    await prewarmPersonalSharedAgentTurnCaches(a, {} as never, {
      warmConversation: false,
      conversationId: "room-two",
    });
    expect(coordinateSharedConversationPrewarm).toHaveBeenCalledTimes(2);
  });
});

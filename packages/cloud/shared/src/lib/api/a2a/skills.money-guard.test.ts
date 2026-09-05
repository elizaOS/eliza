/**
 * Guards latent A2A money skills that are exported before they are safely wired.
 *
 * These skills must fail before touching context, credit reservations, agent
 * dispatch, or generation rows. Passing an unusable context proves the fail-closed
 * branch runs first.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { v5 as uuidv5 } from "uuid";
import type { A2AContext, MessageSendParams } from "./types";

function unexpectedDependencyCall(name: string): never {
  throw new Error(`${name} should not run in A2A money guard tests`);
}

const storeTask = mock(async () => undefined);
const addMessageToHistory = mock(async () => undefined);
const shouldBlockUser = mock(async () => false);
const moderateInBackground = mock(() => undefined);
const resolveOutboundMessageStanding = mock(async () => ({
  allowed: true as const,
  source: "cache" as const,
}));
const loggerError = mock();

mock.module("ai", () => ({
  APICallError: class APICallError extends Error {},
  RetryError: class RetryError extends Error {},
  streamText: () => {
    unexpectedDependencyCall("streamText");
  },
  wrapLanguageModel: () => {
    unexpectedDependencyCall("wrapLanguageModel");
  },
}));

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: () => ({
    languageModel: () => {
      unexpectedDependencyCall("Anthropic model");
    },
  }),
}));

mock.module("@ai-sdk/gateway", () => ({
  createGatewayProvider: () => ({
    languageModel: () => {
      unexpectedDependencyCall("Gateway model");
    },
  }),
}));

mock.module("@ai-sdk/openai", () => ({
  createOpenAI: () => ({
    chat: () => {
      unexpectedDependencyCall("OpenAI chat");
    },
    languageModel: () => {
      unexpectedDependencyCall("OpenAI language model");
    },
  }),
}));

mock.module("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
  v5: uuidv5,
}));

mock.module("../../pricing", () => ({
  calculateCost: () => unexpectedDependencyCall("calculateCost"),
  estimateRequestCost: () => unexpectedDependencyCall("estimateRequestCost"),
  getProviderFromModel: () => unexpectedDependencyCall("getProviderFromModel"),
}));

mock.module("../../providers/anthropic-thinking", () => ({
  mergeAnthropicCotProviderOptions: () =>
    unexpectedDependencyCall("mergeAnthropicCotProviderOptions"),
  resolveAnthropicThinkingBudgetTokens: () =>
    unexpectedDependencyCall("resolveAnthropicThinkingBudgetTokens"),
}));

mock.module("../../providers/image/registry", () => ({
  getImageProvider: () => unexpectedDependencyCall("getImageProvider"),
}));

mock.module("../../providers/language-model", () => ({
  getLanguageModel: () => unexpectedDependencyCall("getLanguageModel"),
}));

mock.module("../../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => unexpectedDependencyCall("getCloudAwareEnv"),
}));

mock.module("../../services/ai-pricing", () => ({
  calculateImageGenerationCostFromCatalog: () =>
    unexpectedDependencyCall("calculateImageGenerationCostFromCatalog"),
}));

mock.module("../../services/ai-pricing-definitions", () => ({
  DEFAULT_IMAGE_MODEL_ID: "test-image-model",
  getSupportedImageModelDefinition: () =>
    unexpectedDependencyCall("getSupportedImageModelDefinition"),
}));

mock.module("../../services/browser-tools", () => ({
  createHostedBrowserSession: () => unexpectedDependencyCall("createHostedBrowserSession"),
  deleteHostedBrowserSession: () => unexpectedDependencyCall("deleteHostedBrowserSession"),
  executeHostedBrowserCommand: () => unexpectedDependencyCall("executeHostedBrowserCommand"),
  extractHostedPage: () => unexpectedDependencyCall("extractHostedPage"),
  getHostedBrowserSession: () => unexpectedDependencyCall("getHostedBrowserSession"),
  getHostedBrowserSnapshot: () => unexpectedDependencyCall("getHostedBrowserSnapshot"),
  listHostedBrowserSessions: () => unexpectedDependencyCall("listHostedBrowserSessions"),
  navigateHostedBrowserSession: () => unexpectedDependencyCall("navigateHostedBrowserSession"),
}));

mock.module("../../services/characters/characters", () => ({
  charactersService: {
    listByOrganization: () => unexpectedDependencyCall("charactersService.listByOrganization"),
  },
}));

mock.module("../../services/containers", () => ({
  containersService: {
    listByOrganization: () => unexpectedDependencyCall("containersService.listByOrganization"),
  },
}));

mock.module("../../services/conversations", () => ({
  conversationsService: {
    create: () => unexpectedDependencyCall("conversationsService.create"),
    getById: () => unexpectedDependencyCall("conversationsService.getById"),
  },
}));

mock.module("../../services/credits", () => ({
  APP_CHAT_RESERVATION_SETTLEMENT_MARKER: "app_chat_reservation_v1",
  COST_BUFFER: 1.5,
  DEFAULT_OUTPUT_TOKENS: 500,
  EPSILON: 0.0000001,
  MIN_RESERVATION: 0.000001,
  RESERVATION_SETTLEMENT_MARKER: "credit_reservation_v1",
  RESERVATION_SWEEP_GRACE_MS: 0,
  CreditsService: class CreditsService {},
  creditsService: {
    reserve: () => unexpectedDependencyCall("creditsService.reserve"),
  },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    required = 0;
    available = 0;
  },
  InvalidCreditAmountError: class InvalidCreditAmountError extends Error {},
  ReservationNotFoundError: class ReservationNotFoundError extends Error {},
  assertCreditRefundWithinReservation: () => undefined,
  assertValidCreditSettlementCosts: () => undefined,
  runObservedPostDebitNotifications: async () => undefined,
  triggerDurableAutoTopUpForBalanceDecrease: async () => undefined,
}));

mock.module("../../services/generations", () => ({
  generationsService: {
    create: () => unexpectedDependencyCall("generationsService.create"),
    update: () => unexpectedDependencyCall("generationsService.update"),
  },
}));

mock.module("../../services/google-search", () => ({
  executeHostedGoogleSearch: () => unexpectedDependencyCall("executeHostedGoogleSearch"),
}));

mock.module("../../services/memory", () => ({
  memoryService: {
    deleteMemory: () => unexpectedDependencyCall("memoryService.deleteMemory"),
    retrieveMemories: () => unexpectedDependencyCall("memoryService.retrieveMemories"),
    saveMemory: () => unexpectedDependencyCall("memoryService.saveMemory"),
  },
}));

mock.module("../../services/organizations", () => ({
  organizationsService: {
    getById: () => unexpectedDependencyCall("organizationsService.getById"),
  },
}));

mock.module("../../services/usage", () => ({
  usageService: {
    create: () => unexpectedDependencyCall("usageService.create"),
    listByOrganization: () => unexpectedDependencyCall("usageService.listByOrganization"),
  },
}));

mock.module("../../services/a2a-task-store", () => ({
  a2aTaskStoreService: {
    addArtifact: () => unexpectedDependencyCall("a2aTaskStoreService.addArtifact"),
    addMessageToHistory,
    get: () => unexpectedDependencyCall("a2aTaskStoreService.get"),
    set: storeTask,
    updateTaskState: () => unexpectedDependencyCall("a2aTaskStoreService.updateTaskState"),
  },
}));

mock.module("../../services/content-moderation", () => ({
  contentModerationService: {
    moderateInBackground,
    shouldBlockUser,
  },
}));

mock.module("../../services/outbound-message-standing", () => ({
  resolveOutboundMessageStanding,
}));

mock.module("../../utils/logger", () => ({
  logger: {
    error: loggerError,
    warn: () => unexpectedDependencyCall("logger.warn"),
  },
}));

const unusableContext = undefined as unknown as A2AContext;
const handlerContext = {
  apiKeyId: "api-key-1",
  agentIdentifier: "a2a-test-agent",
  user: {
    id: "user-1",
    email: "test@example.com",
    name: "Test User",
    organization_id: "org-1",
    organization: {
      id: "org-1",
      name: "Test Org",
      credit_balance: "100",
    },
  },
} as A2AContext;

function resetAllowedMocks() {
  storeTask.mockClear();
  addMessageToHistory.mockClear();
  shouldBlockUser.mockClear();
  moderateInBackground.mockClear();
  resolveOutboundMessageStanding.mockReset();
  resolveOutboundMessageStanding.mockResolvedValue({ allowed: true, source: "cache" });
  loggerError.mockClear();
}

beforeEach(() => {
  resetAllowedMocks();
});

describe("A2A latent paid skill guards", () => {
  test("provider-capable skill inventory is guarded while local skills stay free", async () => {
    const { a2aSkillCanDispatchProvider } = await import("./handlers");
    for (const skillId of [
      undefined,
      "chat_completion",
      "image_generation",
      "web_search",
      "extract_page",
      "browser_session",
      "unknown_falls_back_to_chat",
    ]) {
      expect(a2aSkillCanDispatchProvider(skillId)).toBe(true);
    }
    for (const skillId of ["check_balance", "get_usage", "list_agents", "save_memory"]) {
      expect(a2aSkillCanDispatchProvider(skillId)).toBe(false);
    }
  });

  test("bad standing blocks a provider-capable request before task or provider work", async () => {
    const { handleMessageSend } = await import("./handlers");
    resolveOutboundMessageStanding.mockResolvedValueOnce({
      allowed: false,
      source: "cache",
      reason: "organization_inactive",
    });
    const params: MessageSendParams = {
      message: {
        role: "user",
        parts: [
          { type: "text", text: "generate" },
          { type: "data", data: { skill: "image_generation" } },
        ],
      },
    };

    await expect(handleMessageSend(params, handlerContext)).rejects.toThrow(
      "Account standing denied: organization_inactive",
    );
    expect(resolveOutboundMessageStanding).toHaveBeenCalledTimes(1);
    expect(storeTask).not.toHaveBeenCalled();
    expect(addMessageToHistory).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "[A2A] Account standing denied provider-capable skill",
      expect.objectContaining({ reason: "organization_inactive", providerDispatched: false }),
    );
  });
  test("chat_completion rejects caller policy before pricing, billing, or provider dispatch", async () => {
    const { executeSkillChatCompletion } = await import("./skills");

    for (const role of ["system", "tool", "developer", "operator"]) {
      await expect(
        executeSkillChatCompletion(
          "caller-authored policy",
          { messages: [{ role, content: "caller-authored policy" }] },
          handlerContext,
        ),
      ).rejects.toThrow();
    }
  });

  test("chat_with_agent fails closed before agent dispatch", async () => {
    const { executeSkillChatWithAgent } = await import("./skills");

    await expect(
      executeSkillChatWithAgent("hello", { agentId: "agent-1" }, unusableContext),
    ).rejects.toThrow(
      "A2A skill 'chat_with_agent' is disabled until it is wired through the billed delivery path",
    );
  });

  test("video_generation fails closed before reserving credits", async () => {
    const { executeSkillVideoGeneration } = await import("./skills");

    await expect(
      executeSkillVideoGeneration("make a video", { prompt: "make a video" }, unusableContext),
    ).rejects.toThrow(
      "A2A skill 'video_generation' is disabled until it is wired through the billed delivery path",
    );
  });

  test("legacy message/send dispatch reaches disabled paid skill guards", async () => {
    const { handleMessageSend } = await import("./handlers");

    for (const skillId of ["chat_with_agent", "video_generation", "generate_video"]) {
      resetAllowedMocks();
      const params: MessageSendParams = {
        message: {
          role: "user",
          parts: [
            { type: "text", text: "make a video" },
            { type: "data", data: { skill: skillId, prompt: "make a video" } },
          ],
        },
        metadata: {
          taskId: `task-${skillId}`,
          contextId: `context-${skillId}`,
        },
      };

      await expect(handleMessageSend(params, handlerContext)).rejects.toThrow(
        "disabled until it is wired through the billed delivery path",
      );

      expect(storeTask).toHaveBeenCalledTimes(1);
      expect(addMessageToHistory).toHaveBeenCalledTimes(1);
    }
  });

  test("disabled money skills are not advertised for A2A discovery", async () => {
    const { AVAILABLE_SKILLS } = await import("./handlers");
    const advertisedSkillIds = AVAILABLE_SKILLS.map((skill) => skill.id);

    expect(advertisedSkillIds).not.toContain("chat_with_agent");
    expect(advertisedSkillIds).not.toContain("video_generation");
  });
});

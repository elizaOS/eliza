/**
 * Guards latent A2A money skills that are exported before they are safely wired.
 *
 * These skills must fail before touching context, credit reservations, agent
 * dispatch, or generation rows. Passing an unusable context proves the fail-closed
 * branch runs first.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { A2AContext, MessageSendParams } from "./types";

function unexpectedDependencyCall(name: string): never {
  throw new Error(`${name} should not run in A2A money guard tests`);
}

const storeTask = mock(async () => undefined);
const addMessageToHistory = mock(async () => undefined);
const shouldBlockUser = mock(async () => false);
const moderateInBackground = mock(() => undefined);

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
  creditsService: {
    reserve: () => unexpectedDependencyCall("creditsService.reserve"),
  },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    required = 0;
    available = 0;
  },
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

mock.module("../../utils/logger", () => ({
  logger: {
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
}

beforeEach(() => {
  resetAllowedMocks();
});

describe("A2A latent paid skill guards", () => {
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

import crypto from "node:crypto";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  type EvaluatorService,
  type Memory,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import { selectLiveProvider } from "../../../../test/helpers/live-provider";
import { experiencePatternEvaluator } from "../../../core/src/features/advanced-capabilities/experience/evaluators/experience-items.ts";
import { ExperienceService } from "../../../core/src/features/advanced-capabilities/experience/service.ts";
import {
  ExperienceType,
  OutcomeType,
} from "../../../core/src/features/advanced-capabilities/experience/types.ts";
import { ConversationHarness } from "../helpers/conversation-harness.js";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const selectedLiveProvider = liveModelTestsEnabled
  ? selectLiveProvider()
  : null;
const canRunLiveTests = liveModelTestsEnabled && selectedLiveProvider !== null;

const experienceCapabilityPlugin: Plugin = {
  name: "experience-live-e2e-advanced-capability",
  description:
    "Registers the built-in experience capability for live e2e tests.",
  services: [ExperienceService],
  evaluators: [experiencePatternEvaluator],
};

function createAgentMessage(
  runtime: AgentRuntime,
  roomId: UUID,
  text: string,
  content?: Record<string, unknown>,
): Memory {
  return createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId,
    roomId,
    content: {
      text,
      source: "experience-live-e2e",
      channelType: ChannelType.DM,
      ...content,
    },
  });
}

function createUserMessage(
  roomId: UUID,
  entityId: UUID,
  text: string,
  content?: Record<string, unknown>,
): Memory {
  return createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId,
    roomId,
    content: {
      text,
      source: "experience-live-e2e",
      channelType: ChannelType.DM,
      ...content,
    },
  });
}

async function seedMessages(
  runtime: AgentRuntime,
  messages: Memory[],
): Promise<void> {
  for (const message of messages) {
    await runtime.createMemory(message, "messages");
  }
}

async function flushExperienceLoad(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

describe("Experience extraction live LLM E2E", () => {
  let runtime: AgentRuntime;
  let cleanup: (() => Promise<void>) | undefined;
  let experienceService: ExperienceService;
  let evaluatorService: EvaluatorService;

  beforeAll(async () => {
    if (!canRunLiveTests) return;

    process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";

    const result = await createRealTestRuntime({
      withLLM: true,
      preferredProvider: selectedLiveProvider?.name,
      characterName: "ExperienceLiveAgent",
      advancedCapabilities: true,
      plugins: [experienceCapabilityPlugin],
    });

    runtime = result.runtime;
    cleanup = result.cleanup;
    const service = runtime.getService(
      "EXPERIENCE",
    ) as ExperienceService | null;
    if (!service) {
      throw new Error("Experience service is not registered");
    }
    experienceService = service;
    evaluatorService = runtime.getService("evaluator") as EvaluatorService;
    runtime.setSetting("AUTO_RECORD_THRESHOLD", "0.4");
    await flushExperienceLoad();
  }, 180_000);

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  }, 120_000);

  itIf(canRunLiveTests)(
    "forms, suppresses duplicates, and skips simple reply-only experience candidates",
    async () => {
      const harness = new ConversationHarness(runtime, {
        userName: "ExperienceLiveUser",
      });
      await harness.setup();

      try {
        const before = await experienceService.listExperiences({ limit: 100 });
        const beforeIds = new Set(before.map((experience) => experience.id));
        const trigger = createAgentMessage(
          runtime,
          harness.roomId,
          [
            "Action completed after a correction: restarting the Vite dev server picked up the changed environment variable.",
            "I was wrong to assume editing .env would update the already-running process.",
            "Novel transferable lesson to remember: restart the dev server after changing environment variables so stale config is cleared.",
          ].join(" "),
          { actions: ["RUN_COMMAND"] },
        );

        await seedMessages(runtime, [
          createUserMessage(
            harness.roomId,
            harness.userId,
            "The app still shows the old API base URL after I edited the env file.",
          ),
          createAgentMessage(
            runtime,
            harness.roomId,
            "I checked the running process and confirmed it was still using the old environment.",
          ),
          createAgentMessage(
            runtime,
            harness.roomId,
            "I restarted the Vite dev server, then reran the check and the new API base URL appeared. This corrected the stale config failure.",
          ),
          trigger,
        ]);

        await runtime.setCache(
          `experience-extraction:${harness.roomId}:message-count`,
          "24",
        );
        const shouldRun = await experiencePatternEvaluator.shouldRun({
          runtime,
          message: trigger,
          options: { didRespond: true },
        });
        expect(shouldRun).toBe(true);

        const result = await evaluatorService.run(trigger, undefined, {
          didRespond: true,
          responses: [trigger],
        });
        expect(result.processedEvaluators).toContain("experiencePatterns");

        const after = await experienceService.listExperiences({ limit: 100 });
        const recorded = after.filter(
          (experience) => !beforeIds.has(experience.id),
        );
        expect(recorded.length).toBeGreaterThanOrEqual(1);
        expect(recorded.length).toBeLessThanOrEqual(3);

        const restartExperience = recorded.find((experience) =>
          containsAny(experience.learning, [
            "restart",
            "environment",
            "env",
            "dev server",
            "vite",
          ]),
        );
        expect(restartExperience).toBeTruthy();
        expect(restartExperience?.action).toBe("pattern_recognition");
        expect(restartExperience?.tags).toContain("extracted");
        expect(restartExperience?.confidence).toBeGreaterThanOrEqual(0.6);
        expect(restartExperience?.extractionMethod).toBe(
          "experience_evaluator",
        );
        expect(
          restartExperience?.sourceMessageIds?.length,
        ).toBeGreaterThanOrEqual(3);
        expect(restartExperience?.sourceRoomId).toBe(harness.roomId);
        expect(restartExperience?.sourceTriggerMessageId).toBe(trigger.id);

        const seededDuplicate = await experienceService.recordExperience({
          type: ExperienceType.LEARNING,
          outcome: OutcomeType.NEUTRAL,
          context: "Local development after editing environment variables.",
          action: "manual seed",
          result:
            "Restart the Vite dev server after changing environment variables.",
          learning:
            "Restart the Vite dev server after changing environment variables so the process loads new config.",
          domain: "coding",
          tags: ["seeded", "duplicate-control"],
          confidence: 0.9,
          importance: 0.8,
        });
        const duplicateBefore = await experienceService.listExperiences({
          limit: 100,
        });
        const duplicateIds = new Set(
          duplicateBefore.map((experience) => experience.id),
        );
        const duplicateTrigger = createAgentMessage(
          runtime,
          harness.roomId,
          [
            "Action completed: after another env edit, restarting the Vite dev server made the new config visible.",
            "This is the same lesson as the existing seeded experience.",
          ].join(" "),
          { actions: ["RUN_COMMAND"] },
        );

        await seedMessages(runtime, [
          createUserMessage(
            harness.roomId,
            harness.userId,
            "The dev server still has stale environment variables again.",
          ),
          createAgentMessage(
            runtime,
            harness.roomId,
            "I restarted Vite and confirmed the new config loaded.",
          ),
          duplicateTrigger,
        ]);

        await runtime.setCache(
          `experience-extraction:${harness.roomId}:message-count`,
          "24",
        );
        expect(
          await experiencePatternEvaluator.shouldRun({
            runtime,
            message: duplicateTrigger,
            options: { didRespond: true },
          }),
        ).toBe(true);
        await evaluatorService.run(duplicateTrigger, undefined, {
          didRespond: true,
          responses: [duplicateTrigger],
        });

        const duplicateAfter = await experienceService.listExperiences({
          limit: 100,
        });
        const duplicateDelta = duplicateAfter.filter(
          (experience) => !duplicateIds.has(experience.id),
        );
        expect(
          duplicateDelta,
          `Expected no duplicate for seeded experience ${seededDuplicate.id}; recorded: ${duplicateDelta
            .map((experience) => experience.learning)
            .join(" | ")}`,
        ).toHaveLength(0);

        const simpleTrigger = createAgentMessage(
          runtime,
          harness.roomId,
          "Sure, I can help with that.",
          {
            actions: ["REPLY"],
            conversationMode: "simple",
          },
        );
        await runtime.setCache(
          `experience-extraction:${harness.roomId}:message-count`,
          "24",
        );
        await seedMessages(runtime, [
          createUserMessage(harness.roomId, harness.userId, "Thanks."),
          createAgentMessage(runtime, harness.roomId, "No problem."),
          simpleTrigger,
        ]);

        expect(
          await experiencePatternEvaluator.shouldRun({
            runtime,
            message: simpleTrigger,
            options: { didRespond: true },
          }),
        ).toBe(true);
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );
});

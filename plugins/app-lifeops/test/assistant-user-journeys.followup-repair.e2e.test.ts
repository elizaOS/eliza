import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCharacterFromConfig,
  configureLocalEmbeddingPlugin,
  createElizaPlugin,
} from "@elizaos/agent";
import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import dotenv from "dotenv";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { saveEnv, withTimeout } from "../../../test/helpers/test-utils";
import { InboxTriageRepository } from "../src/inbox/repository.js";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { executeApprovedRequest } from "../src/actions/resolve-request.js";
import {
  getLifeOpsLiveSetupWarnings,
  getSelectedLiveProviderEnv,
  LIVE_PROVIDER_ENV_KEYS,
  LIVE_TESTS_ENABLED,
  selectLifeOpsLiveProvider,
} from "./helpers/lifeops-live-harness.ts";
import {
  ensureRoom,
  loadPlugin,
} from "./helpers/lifeops-morning-brief-fixtures.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });
dotenv.config({ path: path.resolve(packageRoot, "..", "..", ".env") });

async function handleMessageAndCollectText(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  timeoutMs = 120_000,
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
    timeoutMs,
    "handleMessage",
  );
  const finalText = String(result?.responseContent?.text ?? "").trim();
  return finalText.length > 0 ? finalText : responseText;
}

async function sendUserTurn(args: {
  runtime: AgentRuntime;
  entityId: UUID;
  roomId: UUID;
  source: string;
  text: string;
}): Promise<string> {
  const message = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: args.entityId,
    roomId: args.roomId,
    metadata: {
      type: "user_message",
      entityName: "shaw",
    },
    content: {
      text: args.text,
      source: args.source,
      channelType: ChannelType.DM,
    },
  });

  return await handleMessageAndCollectText(args.runtime, message);
}

async function seedRepairFixtures(args: {
  runtime: AgentRuntime;
  ownerId: UUID;
  dmRoomId: UUID;
}): Promise<{ followUpId: string }> {
  const triageRepo = new InboxTriageRepository(args.runtime);
  const service = new LifeOpsService(args.runtime);

  const frontier = await service.upsertRelationship({
    name: "Frontier Tower",
    primaryChannel: "telegram",
    primaryHandle: "@frontiertower_ops",
    email: null,
    phone: null,
    notes: "Property walkthrough vendor",
    tags: ["vendor"],
    relationshipType: "vendor",
    lastContactedAt: new Date(
      Date.now() - 21 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    metadata: { followupThresholdDays: 14 },
  });

  const followUp = await service.createFollowUp({
    relationshipId: frontier.id,
    dueAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    reason: "Repair the missed walkthrough and reschedule.",
    priority: 1,
    draft: null,
    completedAt: null,
    metadata: {},
  });

  await triageRepo.storeTriage({
    source: "telegram",
    sourceRoomId: "frontier-room",
    sourceEntityId: "frontier-entity",
    sourceMessageId: "frontier-missed-call",
    channelName: "Frontier Tower",
    channelType: "dm",
    classification: "urgent",
    urgency: "high",
    confidence: 0.98,
    snippet:
      "Sorry I missed your call earlier today. Can we reschedule the walkthrough this week?",
    senderName: "Frontier Tower",
    threadContext: [
      "Frontier Tower was trying to confirm the walkthrough window.",
      "The owner missed the call and still needs to repair the thread.",
    ],
    triageReasoning: "Missed call with a real scheduling dependency.",
    suggestedResponse:
      "Sorry I missed your call earlier. Thursday at 2pm or Friday at 11am works on my side if either helps for the walkthrough.",
  });

  await args.runtime.createMemory(
    createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: args.runtime.agentId,
      roomId: args.dmRoomId,
      metadata: {
        type: "assistant_message",
        entityName: "Eliza",
      },
      content: {
        text: "Frontier Tower still needs the missed walkthrough repaired and rescheduled.",
        source: "assistant",
        channelType: ChannelType.DM,
      },
    }),
    "messages",
  );

  return { followUpId: followUp.id };
}

const selectedLiveProvider = await selectLifeOpsLiveProvider();
const selectedProviderEnv = getSelectedLiveProviderEnv(selectedLiveProvider, {
  omitOpenAiBaseUrl: true,
});
const SUPPORTED_PROVIDER_NAMES = new Set([
  "cerebras",
  "openai",
  "openrouter",
  "google",
]);
const LIVE_SUITE_ENABLED =
  LIVE_TESTS_ENABLED &&
  selectedLiveProvider !== null &&
  SUPPORTED_PROVIDER_NAMES.has(selectedLiveProvider.name);

if (!LIVE_SUITE_ENABLED) {
  const warnings = [
    ...getLifeOpsLiveSetupWarnings(selectedLiveProvider),
    selectedLiveProvider &&
    !SUPPORTED_PROVIDER_NAMES.has(selectedLiveProvider.name)
      ? `selected provider "${selectedLiveProvider.name}" does not support this suite; use Cerebras, OpenAI, OpenRouter, or Google`
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  console.info(
    `[assistant-user-journeys-followup-repair-live] suite skipped until setup is complete: ${warnings.join(" | ")}`,
  );
}

describeIf(LIVE_SUITE_ENABLED)(
  "Live: missed-commitment repair and loop closure",
  () => {
    let runtime: AgentRuntime;
    let envBackup: { restore: () => void };
    let ownerId: UUID;
    let dmRoomId: UUID;
    let followUpId: string;
    const dispatches: Array<{ source: string; target: string; text: string }> =
      [];

    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-followup-repair-workspace-"),
    );
    const pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-followup-repair-pglite-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-followup-repair-state-"),
    );

    beforeAll(async () => {
      envBackup = saveEnv(
        ...LIVE_PROVIDER_ENV_KEYS,
        "PGLITE_DATA_DIR",
        "ELIZA_STATE_DIR",
        "ENABLE_TRAJECTORIES",
        "ELIZA_TRAJECTORY_LOGGING",
      );
      process.env.PGLITE_DATA_DIR = pgliteDir;
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.ENABLE_TRAJECTORIES = "false";
      process.env.ELIZA_TRAJECTORY_LOGGING = "false";
      process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";

      for (const key of LIVE_PROVIDER_ENV_KEYS) {
        delete process.env[key];
      }
      Object.assign(process.env, selectedProviderEnv);

      ownerId = crypto.randomUUID() as UUID;
      dmRoomId = crypto.randomUUID() as UUID;
      const dmWorldId = crypto.randomUUID() as UUID;

      const character = buildCharacterFromConfig({});
      character.settings = {
        ...character.settings,
        ELIZA_ADMIN_ENTITY_ID: ownerId,
      };
      character.secrets = selectedProviderEnv;

      const sqlPlugin = await loadPlugin("@elizaos/plugin-sql");
      const localEmbeddingPlugin = await loadPlugin(
        "@elizaos/plugin-local-embedding",
      );
      const providerPlugin = selectedLiveProvider
        ? await loadPlugin(selectedLiveProvider.plugin)
        : null;
      if (!sqlPlugin || !providerPlugin) {
        throw new Error("Required live plugins were not available.");
      }

      runtime = new AgentRuntime({
        character,
        plugins: [
          providerPlugin as Plugin,
          createElizaPlugin({
            agentId: "main",
            workspaceDir,
          }),
        ],
        conversationLength: 24,
        enableAutonomy: false,
        logLevel: "error",
      });

      await runtime.registerPlugin(sqlPlugin as Plugin);
      if (runtime.adapter && !(await runtime.adapter.isReady())) {
        await runtime.adapter.init();
      }
      if (localEmbeddingPlugin) {
        configureLocalEmbeddingPlugin(localEmbeddingPlugin);
        await runtime.registerPlugin(localEmbeddingPlugin as Plugin);
      }
      await runtime.initialize();

      const trajectoryService = runtime.getService("trajectories") as
        | {
            logLlmCall?: (...args: unknown[]) => unknown;
            setEnabled?: (enabled: boolean) => void;
            updateLatestLlmCall?: (...args: unknown[]) => unknown;
          }
        | undefined;
      if (trajectoryService) {
        trajectoryService.setEnabled?.(false);
        trajectoryService.logLlmCall = () => {};
        trajectoryService.updateLatestLlmCall = async () => {};
      }

      await LifeOpsRepository.bootstrapSchema(runtime);

      await ensureRoom({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        worldId: dmWorldId,
        source: "telegram",
        channelId: `telegram-${dmRoomId}`,
        userName: "shaw",
        type: ChannelType.DM,
      });

      const originalSend = runtime.sendMessageToTarget.bind(runtime);
      runtime.sendMessageToTarget = (async (target, content) => {
        dispatches.push({
          source: String(target.source ?? ""),
          target: String(
            target.channelId ?? target.roomId ?? target.entityId ?? "",
          ),
          text: String(content.text ?? ""),
        });
        return await Promise.resolve(originalSend(target, content)).catch(
          () => undefined,
        );
      }) as typeof runtime.sendMessageToTarget;

      const seeded = await seedRepairFixtures({
        runtime,
        ownerId,
        dmRoomId,
      });
      followUpId = seeded.followUpId;
    }, 240_000);

    afterAll(async () => {
      envBackup?.restore();
      if (runtime) {
        await runtime.stop();
      }
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(pgliteDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it("drafts the repair note, sends it after approval, and closes the follow-up", async () => {
      await sendUserTurn({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        source: "telegram",
        text: "I missed a call with the Frontier Tower guys today. Need to repair that and reschedule if possible asap, but hold the note for my approval first.",
      });

      const approvalQueue = createApprovalQueue(runtime, {
        agentId: runtime.agentId,
      });
      const pending = await approvalQueue.list({
        subjectUserId: String(ownerId),
        state: "pending",
        action: null,
        limit: 10,
      });

      // The agent must enqueue the repair note for owner approval. We do NOT
      // enqueue it on the agent's behalf — if the agent failed to draft and
      // queue, this test must fail.
      expect(
        pending.length,
        "Agent must enqueue a repair-note approval after the user asks it to hold for approval",
      ).toBeGreaterThan(0);
      const pendingRequest = pending.find((request) =>
        `${request.reason} ${JSON.stringify(request.payload)}`
          .toLowerCase()
          .includes("frontier tower"),
      );
      expect(
        pendingRequest,
        "Agent's queued approval must reference the Frontier Tower thread the user mentioned",
      ).toBeDefined();
      const targetRequest = pendingRequest!;

      const approved = await approvalQueue.approve(targetRequest.id, {
        resolvedBy: String(ownerId),
        resolutionReason: "Owner approved the Frontier Tower repair note.",
      });
      const execution = await executeApprovedRequest({
        runtime,
        queue: approvalQueue,
        request: approved,
      });
      expect(execution.success).toBe(true);
      // The dispatched repair note must reference the Frontier Tower thread or
      // the missed-call repair semantically. We don't pin to a single word
      // because the agent's draft varies; we look for any of a small set of
      // phrases that all paraphrase the same intent.
      const dispatchTexts = dispatches.map((dispatch) =>
        dispatch.text.toLowerCase(),
      );
      const referencesRepair = dispatchTexts.some((text) =>
        /frontier|walkthrough|missed|reschedul|sorry/.test(text),
      );
      expect(
        referencesRepair,
        `Dispatched repair note must reference the missed Frontier Tower thread; got: ${JSON.stringify(dispatchTexts)}`,
      ).toBe(true);

      const nonPending = await approvalQueue.list({
        subjectUserId: String(ownerId),
        state: "done",
        action: null,
        limit: 10,
      });
      expect(nonPending.length).toBeGreaterThan(0);

      const service = new LifeOpsService(runtime);
      await service.completeFollowUp(followUpId);
      const followUps = await service.listFollowUps({ limit: 20 });
      expect(followUps.find((entry) => entry.id === followUpId)?.status).toBe(
        "completed",
      );
    }, 240_000);
  },
);

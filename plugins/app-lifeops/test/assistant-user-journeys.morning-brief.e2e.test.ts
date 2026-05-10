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
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  getLifeOpsLiveSetupWarnings,
  getSelectedLiveProviderEnv,
  LIVE_PROVIDER_ENV_KEYS,
  LIVE_TESTS_ENABLED,
  selectLifeOpsLiveProvider,
} from "./helpers/lifeops-live-harness.ts";
import {
  ensureRoom,
  GOOGLE_CLIENT_ID,
  loadPlugin,
  type MorningBriefSeedContext,
  normalizeText,
  seedMorningBriefFixtures,
} from "./helpers/lifeops-morning-brief-fixtures.ts";
import { judgeTextWithLlm } from "./helpers/lifeops-live-judge.ts";

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
  timeoutMs?: number;
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

  return await handleMessageAndCollectText(
    args.runtime,
    message,
    args.timeoutMs,
  );
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
    `[assistant-user-journeys-morning-brief-live] suite skipped until setup is complete: ${warnings.join(" | ")}`,
  );
}

describeIf(LIVE_SUITE_ENABLED)(
  "Live: strict executive-assistant morning brief",
  () => {
    let runtime: AgentRuntime;
    let envBackup: { restore: () => void };
    let ownerId: UUID;
    let dmRoomId: UUID;
    let seeded: MorningBriefSeedContext;

    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-morning-brief-workspace-"),
    );
    const pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-morning-brief-pglite-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-morning-brief-state-"),
    );

    beforeAll(async () => {
      envBackup = saveEnv(
        ...LIVE_PROVIDER_ENV_KEYS,
        "PGLITE_DATA_DIR",
        "ELIZA_STATE_DIR",
        "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
        "ENABLE_TRAJECTORIES",
        "ELIZA_TRAJECTORY_LOGGING",
      );
      process.env.PGLITE_DATA_DIR = pgliteDir;
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID = GOOGLE_CLIENT_ID;
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

      seeded = await seedMorningBriefFixtures({
        runtime,
        ownerId,
        dmRoomId,
        stateDir,
      });
    }, 240_000);

    afterAll(async () => {
      if (runtime) {
        await withTimeout(runtime.stop(), 15_000, "runtime.stop()");
      }
      envBackup?.restore();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(pgliteDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }, 30_000);

    it("builds a strict morning brief with actions, schedule, unread channels, pending drafts, overdue followups, and document blockers", async () => {
      const service = new LifeOpsService(runtime);
      const triageRepo = new InboxTriageRepository(runtime);
      const approvalQueue = createApprovalQueue(runtime, {
        agentId: runtime.agentId,
      });

      const pendingBefore = await approvalQueue.list({
        subjectUserId: String(ownerId),
        state: "pending",
        action: null,
        limit: 10,
      });
      expect(
        pendingBefore.some(
          (request) => request.id === seeded.pendingDraftRequestId,
        ),
      ).toBe(true);

      const followupsBefore = await service.getDailyFollowUpQueue({
        limit: 10,
      });
      expect(
        followupsBefore.some(
          (followup) => followup.reason === seeded.followupReason,
        ),
      ).toBe(true);

      const triageBefore = await triageRepo.getRecentForDigest(
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(triageBefore.length).toBeGreaterThanOrEqual(4);

      const response = await sendUserTurn({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        source: "telegram",
        text: [
          "Build my executive-assistant morning brief.",
          "Use these headings exactly and in this order: Actions First, Today's Schedule, Unread By Channel, Pending Drafts, Overdue Follow-Ups, Documents And Forms.",
          "Use my connected email and calendar plus the pending work and recent cross-channel context you already have.",
          "Name the concrete items under each section.",
          "Do not ask follow-up questions and do not give me only a generic heading.",
        ].join(" "),
      });

      // The agent must produce a brief that actually surfaces the seeded
      // material — the seeded approval queue draft AND the seeded follow-up
      // reason — instead of just acknowledging the request. This replaces the
      // "did the agent crash?" probe with a content-shape rubric judged by
      // Cerebras, plus a structural check that the reply isn't trivially short.
      expect(response).not.toMatch(/something (?:went wrong|flaked)|try again/i);
      expect(
        response.length,
        `Morning brief reply too short to contain the requested sections; got: ${response.slice(0, 200)}`,
      ).toBeGreaterThan(120);

      const judgement = await judgeTextWithLlm({
        label: "morning-brief.surfaces-drafts-and-followups",
        rubric: [
          "The reply must read as an executive-assistant morning brief, NOT as a clarifying question.",
          "It must:",
          "(1) reference at least one pending draft / approval (the seeded draft is about an investor diligence packet);",
          "(2) reference at least one overdue follow-up the agent has on file;",
          "(3) include some kind of section structure or labeled grouping (Actions, Schedule, Drafts, Follow-Ups, Documents) — exact heading text is not required, but the reply must visibly group the brief into multiple categories.",
          "A reply that says 'I cannot do that' or 'sure, let me know what to do' fails. A reply that names concrete items in groups passes.",
        ].join(" "),
        text: response,
        minimumScore: 0.65,
      });
      expect(
        judgement.passed,
        `Morning brief judge failed: ${JSON.stringify(judgement)}\nReply: ${response}`,
      ).toBe(true);

      // The seeded pending draft request must still be in the queue (the
      // agent should not have silently approved or expired it).
      const pendingAfter = await approvalQueue.list({
        subjectUserId: String(ownerId),
        state: "pending",
        action: null,
        limit: 10,
      });
      expect(
        pendingAfter.some(
          (request) => request.id === seeded.pendingDraftRequestId,
        ),
      ).toBe(true);

      // The seeded follow-up must remain on the daily queue (the agent should
      // not have closed it without the user marking it done).
      const followupsAfter = await service.getDailyFollowUpQueue({
        limit: 10,
      });
      expect(
        followupsAfter.some(
          (followup) => followup.reason === seeded.followupReason,
        ),
      ).toBe(true);
    }, 180_000);
  },
);

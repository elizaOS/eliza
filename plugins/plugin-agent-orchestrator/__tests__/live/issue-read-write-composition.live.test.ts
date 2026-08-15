/**
 * Exercises a GitHub issue read-then-comment request through the real
 * Cerebras-backed, PGLite-backed message loop and the production TASKS action
 * settlement wrapper. Provider I/O is deterministic and local; only planning
 * uses the live model.
 */

import {
  ChannelType,
  type Content,
  createMessageMemory,
  type HandlerCallback,
  type Memory,
  promoteSubactionsToActions,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "@elizaos/core/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fakeWorkspaceService = {
  setAuthPromptCallback: vi.fn(),
  listIssues: vi.fn(async () => [
    {
      number: 42,
      title: "Fix the thing",
      state: "open",
      labels: ["bug"],
      url: "https://github.com/owner/repo/issues/42",
    },
  ]),
  getIssue: vi.fn(async () => ({
    number: 42,
    title: "Fix the thing",
    state: "open",
    labels: ["bug"],
    body: "Something is broken.",
    url: "https://github.com/owner/repo/issues/42",
  })),
  addComment: vi.fn(async () => ({
    id: 1,
    url: "https://github.com/owner/repo/issues/42#issuecomment-1",
    body: "Investigating now.",
  })),
};

vi.mock("../../src/services/workspace-service.js", () => ({
  getCodingWorkspaceService: vi.fn(() => fakeWorkspaceService),
  CodingWorkspaceService: class {},
}));

vi.mock("../../src/services/task-policy.js", () => ({
  requireTaskAgentAccess: vi.fn(async () => ({
    allowed: true,
    connector: null,
    requiredRole: "USER",
    actualRole: "USER",
  })),
}));

const { tasksAction } = await import("../../src/actions/tasks.js");

const manageIssuesAction = promoteSubactionsToActions(
  { ...tasksAction, validate: async () => true },
  {
    overrides: {
      manage_issues: {
        description:
          "Manage GitHub issues. For a request to comment on an issue that must first be located, call issueAction=list with eliza_turn_scope=more_work_pending, read the returned issue number, then call issueAction=comment before replying.",
        descriptionCompressed:
          "list|get|create|update|comment|close|reopen GitHub issues; compose lookup then mutation",
      },
    },
  },
).find((action) => action.name === "TASKS_MANAGE_ISSUES");

if (!manageIssuesAction) {
  throw new Error("TASKS_MANAGE_ISSUES promotion was not generated");
}

const liveDescribe =
  process.env.ELIZA_RUN_LIVE_TESTS === "1" &&
  process.env.CEREBRAS_API_KEY?.trim()
    ? describe
    : describe.skip;

interface LiveTrajectoryDetail {
  metrics?: { finalStatus?: string };
  steps?: Array<{
    llmCalls?: Array<{ provider?: string; response?: string }>;
  }>;
}

interface LiveTrajectoryService {
  flushWriteQueue?: (trajectoryId: string) => Promise<void>;
  getTrajectoryDetail?: (
    trajectoryId: string,
  ) => Promise<LiveTrajectoryDetail | null>;
}

liveDescribe(
  "issue read-then-write composition — live Cerebras runtime",
  () => {
    let harness: RealTestRuntimeResult;

    beforeAll(async () => {
      harness = await createRealTestRuntime({
        characterName: "IssueCompositionProofAgent",
        withLLM: true,
        preferredProvider: "openai",
        plugins: [
          {
            name: "issue-composition-live-probe",
            description:
              "Production TASKS issue settlement with deterministic provider I/O.",
            actions: [manageIssuesAction],
          },
        ],
      });
      if (harness.providerConfig?.baseUrl !== "https://api.cerebras.ai/v1") {
        throw new Error(
          "Live issue-composition proof requires the Cerebras provider",
        );
      }
    }, 180_000);

    afterAll(async () => {
      await harness?.cleanup();
    });

    it("lists to resolve the issue, then comments, with no intermediate delivery", async () => {
      const roomId = stringToUuid("issue-composition-room") as UUID;
      const userId = stringToUuid("issue-composition-user") as UUID;
      const worldId = stringToUuid("issue-composition-world") as UUID;
      await harness.runtime.ensureConnection({
        entityId: userId,
        roomId,
        worldId,
        userName: "Issue composition user",
        source: "live-trajectory",
        channelId: roomId,
        type: ChannelType.DM,
      });
      const world = await harness.runtime.getWorld(worldId);
      if (!world)
        throw new Error("live issue-composition world was not initialized");
      await harness.runtime.updateWorld({
        ...world,
        metadata: {
          ...(world.metadata ?? {}),
          roles: {
            ...((world.metadata?.roles as Record<string, string> | undefined) ??
              {}),
            [userId]: "USER",
          },
          roleSources: {
            ...((world.metadata?.roleSources as
              | Record<string, string>
              | undefined) ?? {}),
            [userId]: "manual",
          },
        },
      });
      const message: Memory = createMessageMemory({
        id: stringToUuid("issue-composition-message") as UUID,
        entityId: userId,
        roomId,
        content: {
          text: "In owner/repo, find the open issue titled Fix the thing, then add the comment 'Investigating now.' Do not stop after listing it.",
          source: "live-trajectory",
          channelType: ChannelType.DM,
        },
      });
      const delivered: Content[] = [];
      const callback: HandlerCallback = async (content) => {
        delivered.push(content);
        return [];
      };
      const service = harness.runtime.messageService;
      if (!service) throw new Error("message service was not initialized");
      await service.handleMessage(harness.runtime, message, callback, {});

      expect(fakeWorkspaceService.listIssues).toHaveBeenCalledTimes(1);
      expect(fakeWorkspaceService.addComment).toHaveBeenCalledWith(
        "owner/repo",
        42,
        "Investigating now.",
      );
      expect(
        delivered.filter((content) => content.text?.startsWith("Issues in ")),
      ).toEqual([]);
      expect(
        delivered.filter((content) =>
          content.text?.startsWith("Added comment"),
        ),
      ).toHaveLength(1);
      const trajectoryId = (
        message.metadata as { trajectoryId?: unknown } | null
      )?.trajectoryId;
      if (typeof trajectoryId !== "string" || !trajectoryId.trim()) {
        throw new Error(
          "live issue-composition turn did not create a trajectory",
        );
      }
      const trajectoryService = harness.runtime.getService(
        "trajectories",
      ) as LiveTrajectoryService | null;
      if (typeof trajectoryService?.getTrajectoryDetail !== "function") {
        throw new Error("live issue-composition turn has no trajectory reader");
      }
      let trajectory: LiveTrajectoryDetail | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await trajectoryService.flushWriteQueue?.(trajectoryId);
        trajectory = await trajectoryService.getTrajectoryDetail(trajectoryId);
        if (trajectory?.metrics?.finalStatus === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(trajectory?.metrics?.finalStatus).toBe("completed");
      expect(
        trajectory?.steps
          ?.flatMap((step) => step.llmCalls ?? [])
          .some(
            (call) =>
              typeof call.provider === "string" &&
              typeof call.response === "string" &&
              call.response.trim().length > 0,
          ),
      ).toBe(true);
    }, 240_000);
  },
);

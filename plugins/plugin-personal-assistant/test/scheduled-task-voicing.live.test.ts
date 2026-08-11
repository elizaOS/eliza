/**
 * Credentialed Cerebras proof for owner-facing ScheduledTask bodies, titles,
 * context use, document privacy, and per-rung escalation re-voicing.
 */

import { appendFileSync } from "node:fs";
import {
  type IAgentRuntime,
  logger,
  ModelType,
  runWithTrajectoryContext,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import {
  renderScheduledDispatchMessage,
  renderScheduledDispatchTitle,
  type ScheduledTaskDispatchRecord,
} from "@elizaos/plugin-scheduling";
import { expect, it } from "vitest";
import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";
import { dailyRhythmPack } from "../src/default-packs/daily-rhythm.js";
import {
  buildCheckinSummaryPrompt,
  getCheckinSummaryTrajectoryPurpose,
} from "../src/lifeops/checkin/checkin-service.js";

interface CapturedLlmCall {
  stepId: string;
  purpose?: string;
  userPrompt?: string;
  response?: string;
  promptTokens?: number;
  completionTokens?: number;
}

function attachTrajectoryCapture(runtime: IAgentRuntime): CapturedLlmCall[] {
  const calls: CapturedLlmCall[] = [];
  const trajectoryLogger = {
    isEnabled: () => true,
    logLlmCall: (params: CapturedLlmCall) => {
      calls.push(params);
      const artifactPath = process.env.ELIZA_LIVE_TEST_LLM_CALLS_JSONL?.trim();
      if (artifactPath) {
        appendFileSync(
          artifactPath,
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            callId: `${params.stepId}:${calls.length}`,
            ...params,
          })}\n`,
          "utf8",
        );
      }
    },
  };
  const originalMany = runtime.getServicesByType.bind(runtime);
  runtime.getServicesByType = ((type: string) =>
    type === "trajectories"
      ? [trajectoryLogger]
      : originalMany(type)) as typeof runtime.getServicesByType;
  const originalOne = runtime.getService.bind(runtime);
  runtime.getService = ((type: string) =>
    type === "trajectories"
      ? trajectoryLogger
      : originalOne(type)) as typeof runtime.getService;
  return calls;
}

function record(
  overrides: Partial<ScheduledTaskDispatchRecord>,
): ScheduledTaskDispatchRecord {
  return {
    taskId: "live-scheduled-task",
    kind: "reminder",
    firedAtIso: "2026-08-09T15:00:00.000Z",
    channelKey: "in_app",
    intensity: "normal",
    promptInstructions: "Send a concise, warm update to the owner.",
    contextRequest: undefined,
    ownerVisible: true,
    ...overrides,
  };
}

async function renderBody(
  runtime: IAgentRuntime,
  name: string,
  input: ScheduledTaskDispatchRecord,
): Promise<string> {
  const body = await runWithTrajectoryContext(
    { trajectoryStepId: `scheduled-live-${name}` },
    () => renderScheduledDispatchMessage(runtime, input),
  );
  expect(body.trim().length).toBeGreaterThan(0);
  expect(body).not.toContain(input.promptInstructions);
  logger.info("[ScheduledTaskVoicingLive] body", { name, body });
  return body;
}

await describeLive(
  "ScheduledTask owner-facing voicing (Cerebras live)",
  { provider: "cerebras", requiredEnv: ["CEREBRAS_API_KEY"] },
  ({ harness }) => {
    it("live-proves every required surface and trajectory purpose", async () => {
      const { runtime } = harness();
      const calls = attachTrajectoryCapture(runtime);
      const gm = dailyRhythmPack.records.find(
        (candidate) => candidate.metadata?.recordKey === "gm",
      );
      const gn = dailyRhythmPack.records.find(
        (candidate) => candidate.metadata?.recordKey === "gn",
      );
      const checkin = dailyRhythmPack.records.find(
        (candidate) => candidate.metadata?.recordKey === "checkin",
      );
      const followup = checkin?.pipeline?.onSkip?.[0];
      if (!gm || !gn || !followup || typeof followup === "string") {
        throw new Error("daily-rhythm live fixtures are incomplete");
      }

      const ownerContext = {
        ownerFacts: {
          preferredName: "Sam",
          timezone: "America/Los_Angeles",
        },
        recentConversation: [
          "Owner: I have a packed day, so keep nudges short.",
          "Assistant: Got it — brief and low pressure.",
        ],
      };
      const gmBody = await renderBody(
        runtime,
        "gm",
        record({
          taskId: "live-gm",
          promptInstructions: gm.promptInstructions,
          output: gm.output,
          resolvedContext: ownerContext,
          intensity: "soft",
        }),
      );
      const gnBody = await renderBody(
        runtime,
        "gn",
        record({
          taskId: "live-gn",
          promptInstructions: gn.promptInstructions,
          output: gn.output,
          resolvedContext: ownerContext,
          intensity: "soft",
        }),
      );
      expect(gmBody).not.toBe(gnBody);

      await renderBody(
        runtime,
        "checkin-followup",
        record({
          taskId: "live-checkin-followup",
          kind: "followup",
          promptInstructions: followup.promptInstructions,
          contextRequest: followup.contextRequest,
          output: followup.output,
          resolvedContext: {
            ...ownerContext,
            recentTaskStates: {
              summary:
                "checkin: 0 done / 1 skipped / 0 expired / 0 dismissed (over 1 fires)",
              streaks: [],
              notable: [],
            },
          },
          intensity: "soft",
        }),
      );

      const morningPrompt = buildCheckinSummaryPrompt({
        reportId: "live-morning-report",
        kind: "morning",
        generatedAt: "2026-08-09T15:00:00.000Z",
        escalationLevel: 0,
        overdueTodos: [],
        todaysMeetings: [],
        yesterdaysWins: [],
        habitSummaries: [],
        habitEscalationLevel: 0,
        briefingSections: [
          {
            key: "calendar",
            title: "Calendar",
            summary: "Team sync at 10:00",
            itemCount: 1,
          },
        ],
        collectorErrors: {},
        sleepRecap: null,
      });
      const morningBrief = await runWithTrajectoryContext(
        { trajectoryStepId: "scheduled-live-morning-brief" },
        () =>
          runWithTrajectoryPurpose(
            getCheckinSummaryTrajectoryPurpose("morning"),
            () =>
              runtime.useModel(ModelType.TEXT_SMALL, { prompt: morningPrompt }),
          ),
      );
      expect(typeof morningBrief).toBe("string");
      expect(String(morningBrief).trim().length).toBeGreaterThan(0);
      logger.info("[ScheduledTaskVoicingLive] body", {
        name: "morning-brief",
        body: morningBrief,
      });

      const approvalRecord = record({
        taskId: "live-approval",
        kind: "approval",
        intensity: "urgent",
        promptInstructions:
          "Ask the owner to approve the $240 vendor renewal before 4 PM. Say they can approve or reject it.",
        output: {
          destination: "in_app_card",
          fallback: {
            title: "Approval needed",
            body: "The $240 vendor renewal needs your approval before 4 PM.",
          },
        },
        resolvedContext: ownerContext,
      });
      const approvalBody = await renderBody(
        runtime,
        "approval",
        approvalRecord,
      );
      const approvalTitle = await runWithTrajectoryContext(
        { trajectoryStepId: "scheduled-live-approval-title" },
        () =>
          renderScheduledDispatchTitle(runtime, approvalRecord, approvalBody),
      );
      expect(approvalTitle).not.toBe("Approval needed");
      logger.info("[ScheduledTaskVoicingLive] title", {
        name: "approval",
        title: approvalTitle,
      });

      const documentInternalId = "DocumentRequest-doc-internal-7";
      const documentBody = await renderBody(
        runtime,
        "document-deadline",
        record({
          taskId: "live-document-deadline",
          promptInstructions:
            'Tell the owner that the deadline for "NDA renewal" has arrived and ask them to check its status. Never expose internal record identifiers.',
          subject: { kind: "document", id: documentInternalId },
          output: {
            destination: "in_app_card",
            fallback: {
              title: "Document deadline",
              body: 'The deadline for "NDA renewal" is here. Please check its status.',
            },
          },
          resolvedContext: ownerContext,
        }),
      );
      expect(documentBody).not.toContain(documentInternalId);

      const escalationBase = record({
        taskId: "live-escalation",
        promptInstructions:
          "Let the owner know their pharmacy closes in one hour and their prescription still needs pickup.",
        resolvedContext: ownerContext,
      });
      const softBody = await renderBody(runtime, "escalation-soft", {
        ...escalationBase,
        channelKey: "in_app",
        intensity: "soft",
      });
      const urgentBody = await renderBody(runtime, "escalation-urgent", {
        ...escalationBase,
        channelKey: "telegram",
        intensity: "urgent",
      });
      expect(softBody).not.toBe(urgentBody);

      const purposes = calls.map((call) => call.purpose);
      expect(purposes).toContain("scheduled_task_dispatch");
      expect(purposes).toContain("checkin_followup");
      expect(purposes).toContain("morning_brief");
      expect(purposes).toContain("approval_notice");
      expect(purposes).toContain("scheduled_task_title");
      const escalationCalls = calls.filter((call) =>
        call.stepId.startsWith("scheduled-live-escalation-"),
      );
      expect(escalationCalls).toHaveLength(2);
      expect(escalationCalls[0]?.userPrompt).not.toBe(
        escalationCalls[1]?.userPrompt,
      );
      expect(calls.every((call) => (call.promptTokens ?? 0) > 0)).toBe(true);
      expect(calls.every((call) => (call.completionTokens ?? 0) > 0)).toBe(
        true,
      );
      logger.info("[ScheduledTaskVoicingLive] trajectory summary", {
        calls: calls.map((call) => ({
          stepId: call.stepId,
          purpose: call.purpose,
          promptTokens: call.promptTokens,
          completionTokens: call.completionTokens,
          response: call.response,
        })),
      });
    }, 180_000);
  },
);

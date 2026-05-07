import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent/types/trajectory";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportTrajectoryTaskDatasets,
  extractTrajectoryExamplesByTask,
} from "./trajectory-task-datasets.js";

const baseTrajectory = (response: string): Trajectory => ({
  trajectoryId: "traj-1",
  agentId: "agent-1",
  startTime: 1,
  steps: [
    {
      stepId: "step-1",
      timestamp: 1,
      llmCalls: [
        {
          callId: "call-1",
          purpose: "should_respond",
          systemPrompt: "Return messageHandler JSON.",
          userPrompt: "final message",
          response,
        },
      ],
    },
  ],
});

describe("trajectory task datasets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps native messageHandler JSON rows", () => {
    const examples = extractTrajectoryExamplesByTask(
      [
        baseTrajectory(
          JSON.stringify({
            messageHandler: {
              action: "RESPOND",
              simple: true,
              contexts: [],
              thought: "Direct mention.",
              reply: "Sure.",
            },
          }),
        ),
      ],
      ["should_respond"],
    );

    expect(examples.should_respond).toHaveLength(1);
    const example = examples.should_respond[0];
    if (!example) {
      throw new Error("Expected one should_respond example");
    }
    const assistantMessage = example.messages[2];
    if (!assistantMessage) {
      throw new Error("Expected assistant output message");
    }
    expect(JSON.parse(assistantMessage.content)).toEqual({
      messageHandler: {
        action: "RESPOND",
        simple: true,
        contexts: [],
        thought: "Direct mention.",
        reply: "Sure.",
      },
    });
    expect(example.metadata).toMatchObject({
      task_type: "should_respond",
      source_dataset: "harness/should_respond",
      trajectory_id: "traj-1",
      call_id: "call-1",
      agent_id: "agent-1",
    });
  });

  it("skips legacy should_respond rows with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outputDir = await mkdtemp(
      join(tmpdir(), "trajectory-task-datasets-"),
    );
    try {
      const exported = await exportTrajectoryTaskDatasets(
        [
          baseTrajectory(
            [
              "name: Agent",
              "reasoning: Direct mention.",
              "action: RESPOND",
              "primaryContext: general",
            ].join("\n"),
          ),
        ],
        outputDir,
        ["should_respond"],
      );
      const summary = JSON.parse(
        await readFile(exported.paths.summaryPath, "utf8"),
      ) as { skippedLegacyRows: number; warnings: string[] };

      expect(exported.counts.should_respond).toBe(0);
      expect(summary.skippedLegacyRows).toBe(1);
      expect(summary.warnings[0]).toContain(
        "skipped legacy should_respond row",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped legacy should_respond row"),
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("accepts JSONL trajectory export text as input", () => {
    const exportText = `${JSON.stringify(
      baseTrajectory(
        JSON.stringify({
          messageHandler: {
            action: "RESPOND",
            simple: true,
            contexts: [],
            thought: "Direct mention.",
            reply: "Sure.",
          },
        }),
      ),
    )}\n`;
    const examples = extractTrajectoryExamplesByTask(exportText, [
      "should_respond",
    ]);
    expect(examples.should_respond).toHaveLength(1);
  });

  it("accepts multi-line harness JSONL export text as input", () => {
    const response = JSON.stringify({
      messageHandler: {
        action: "RESPOND",
        simple: true,
        contexts: [],
        thought: "Direct mention.",
        reply: "Sure.",
      },
    });
    const exportText = [
      {
        format: "trajectory_harness_v1",
        trajectoryId: "traj-1",
        agentId: "agent-1",
        source: "chat",
        status: "completed",
        startTime: 1,
        stepId: "step-1",
        stepIndex: 0,
        stepTimestamp: 1,
        callId: "call-1",
        callIndex: 0,
        purpose: "should_respond",
        systemPrompt: "Return messageHandler JSON.",
        userPrompt: "final message",
        response,
        tags: ["llm", "purpose:should_respond"],
        promptTokens: 10,
        completionTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 0,
        tokenUsageEstimated: false,
        trajectoryTotals: {
          stepCount: 1,
          llmCallCount: 1,
          providerAccessCount: 0,
          promptTokens: 10,
          completionTokens: 5,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 0,
        },
        cacheStats: {
          totalInputTokens: 10,
          promptTokens: 10,
          completionTokens: 5,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 0,
          cachedCallCount: 1,
          cacheReadCallCount: 1,
          cacheWriteCallCount: 0,
          tokenUsageEstimatedCallCount: 0,
        },
      },
      {
        format: "trajectory_harness_v1",
        trajectoryId: "traj-1",
        agentId: "agent-1",
        source: "chat",
        status: "completed",
        startTime: 1,
        stepId: "step-1",
        stepIndex: 0,
        stepTimestamp: 1,
        callId: "call-2",
        callIndex: 1,
        purpose: "response",
        systemPrompt: "Reply directly.",
        userPrompt: "hello",
        response: "hello",
        tags: ["llm", "purpose:response"],
        promptTokens: 3,
        completionTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        tokenUsageEstimated: false,
        trajectoryTotals: {
          stepCount: 1,
          llmCallCount: 2,
          providerAccessCount: 0,
          promptTokens: 13,
          completionTokens: 6,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 0,
        },
        cacheStats: {
          totalInputTokens: 13,
          promptTokens: 13,
          completionTokens: 6,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 0,
          cachedCallCount: 1,
          cacheReadCallCount: 1,
          cacheWriteCallCount: 0,
          tokenUsageEstimatedCallCount: 0,
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");

    const examples = extractTrajectoryExamplesByTask(exportText, [
      "should_respond",
    ]);
    expect(examples.should_respond).toHaveLength(1);
  });
});

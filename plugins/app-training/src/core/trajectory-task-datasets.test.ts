import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import { ELIZA_NATIVE_TRAJECTORY_FORMAT } from "@elizaos/core";
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
    expect(example.format).toBe(ELIZA_NATIVE_TRAJECTORY_FORMAT);
    expect(example.request).toMatchObject({
      system: "Return messageHandler JSON.",
      prompt: "final message",
    });
    expect(JSON.parse(example.response.text)).toEqual({
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
      source_dataset: "eliza_native/should_respond",
      trajectory_id: "traj-1",
      call_id: "call-1",
      agent_id: "agent-1",
    });
  });

  it("skips non-native should_respond rows with a warning", async () => {
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
      ) as { skippedNonNativeRows: number; warnings: string[] };

      expect(exported.counts.should_respond).toBe(0);
      expect(summary.skippedNonNativeRows).toBe(1);
      expect(summary.warnings[0]).toContain(
        "skipped non-native should_respond row",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped non-native should_respond row"),
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects non-native JSONL trajectory export text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    expect(examples.should_respond).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("expected eliza_native_v1"),
    );
  });

  it("accepts multi-line native JSONL export text as input", () => {
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
        format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
        schemaVersion: 1,
        boundary: "vercel_ai_sdk.generateText",
        trajectoryId: "traj-1",
        agentId: "agent-1",
        source: "chat",
        status: "completed",
        stepId: "step-1",
        stepIndex: 0,
        timestamp: 1,
        callId: "call-1",
        callIndex: 0,
        purpose: "should_respond",
        request: {
          prompt: "final message",
          messages: [
            { role: "system", content: "Return messageHandler JSON." },
            { role: "user", content: "final message" },
          ],
        },
        response: {
          text: response,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 0,
          },
        },
        metadata: {
          task_type: "should_respond",
          source_dataset: "runtime_trajectory_boundary",
          trajectory_id: "traj-1",
          step_id: "step-1",
          call_id: "call-1",
          agent_id: "agent-1",
        },
        tags: ["llm", "purpose:should_respond"],
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
        format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
        schemaVersion: 1,
        boundary: "vercel_ai_sdk.generateText",
        trajectoryId: "traj-1",
        agentId: "agent-1",
        source: "chat",
        status: "completed",
        stepId: "step-1",
        stepIndex: 0,
        timestamp: 2,
        callId: "call-2",
        callIndex: 1,
        purpose: "response",
        request: {
          prompt: "hello",
          messages: [
            { role: "system", content: "Reply directly." },
            { role: "user", content: "hello" },
          ],
        },
        response: {
          text: "hello",
          usage: {
            promptTokens: 3,
            completionTokens: 1,
            totalTokens: 4,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
        metadata: {
          task_type: "response",
          source_dataset: "runtime_trajectory_boundary",
          trajectory_id: "traj-1",
          step_id: "step-1",
          call_id: "call-2",
          agent_id: "agent-1",
        },
        tags: ["llm", "purpose:response"],
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

/**
 * Covers per-task `eliza_native_v1` extraction and JSONL writing from recorded
 * trajectories on a temp filesystem (deterministic).
 */

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
              contexts: ["simple"],
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
        contexts: ["simple"],
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
            contexts: ["simple"],
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
        contexts: ["simple"],
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

  // #8797: the contextual view evaluator (`view_context`) is a first-class
  // training task so the nightly trigger produces an optimized artifact through
  // the normal path. Calls are bucketed on the structural `{viewId}` response
  // shape (the evaluator's output), independent of how the merged evaluator call
  // is tagged.
  const viewContextTrajectory = (response: string): Trajectory => ({
    trajectoryId: "traj-vc",
    agentId: "agent-1",
    startTime: 1,
    steps: [
      {
        stepId: "step-1",
        timestamp: 1,
        llmCalls: [
          {
            callId: "call-vc",
            // Neutral purpose: classification must come from the response shape,
            // not a tag, since the post-turn EvaluatorService merges the call.
            purpose: "evaluator",
            systemPrompt: "Infer the situational view.",
            userPrompt: "my landlord is ghosting me about the lease",
            response,
          },
        ],
      },
    ],
  });

  it("buckets a {viewId} evaluator response into the view_context task", () => {
    const examples = extractTrajectoryExamplesByTask(
      [
        viewContextTrajectory(
          JSON.stringify({ viewId: "task-coordinator", reason: "legal task" }),
        ),
      ],
      ["view_context"],
    );
    expect(examples.view_context).toHaveLength(1);
    const example = examples.view_context[0];
    if (!example) throw new Error("Expected one view_context example");
    expect(JSON.parse(example.response.text)).toEqual({
      viewId: "task-coordinator",
      reason: "legal task",
    });
    expect(example.metadata).toMatchObject({
      task_type: "view_context",
      source_dataset: "eliza_native/view_context",
    });
  });

  it("does not bucket a plain reply as view_context", () => {
    const examples = extractTrajectoryExamplesByTask(
      [
        viewContextTrajectory(
          "Sorry to hear that — want me to draft a notice?",
        ),
      ],
      ["view_context"],
    );
    expect(examples.view_context).toHaveLength(0);
  });

  it("exports a view_context dataset file + count", async () => {
    const outputDir = await mkdtemp(
      join(tmpdir(), "trajectory-task-datasets-vc-"),
    );
    try {
      const exported = await exportTrajectoryTaskDatasets(
        [
          viewContextTrajectory(
            JSON.stringify({ viewId: "calendar", reason: "scheduling" }),
          ),
        ],
        outputDir,
        ["view_context"],
      );
      expect(exported.counts.view_context).toBe(1);
      expect(exported.paths.viewContextPath).toContain(
        "view_context_trajectories.jsonl",
      );
      const written = await readFile(exported.paths.viewContextPath, "utf-8");
      expect(written.trim().length).toBeGreaterThan(0);
      expect(exported.summary.taskMetrics.view_context.exampleCount).toBe(1);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

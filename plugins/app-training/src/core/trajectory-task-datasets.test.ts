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
});

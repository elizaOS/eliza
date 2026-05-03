import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMultiAgent } from "../actions/coding-task-handlers.js";

describe("handleMultiAgent launch failures", () => {
  let previousCodingDirectory: string | undefined;

  beforeEach(() => {
    previousCodingDirectory = process.env.PARALLAX_CODING_DIRECTORY;
    process.env.PARALLAX_CODING_DIRECTORY = path.join(
      os.tmpdir(),
      `eliza-launch-failure-${process.pid}`,
    );
  });

  afterEach(() => {
    if (previousCodingDirectory === undefined) {
      delete process.env.PARALLAX_CODING_DIRECTORY;
    } else {
      process.env.PARALLAX_CODING_DIRECTORY = previousCodingDirectory;
    }
    vi.restoreAllMocks();
  });

  it("uses TEXT_SMALL to turn raw launcher errors into a character-voiced user message", async () => {
    const callbacks: Array<{ text?: string }> = [];
    const prompts: string[] = [];
    const ptyService = {
      defaultApprovalPreset: "auto",
      checkAvailableAgents: vi.fn(async () => [
        { adapter: "Claude Code", installed: false },
      ]),
      resolveAgentType: vi.fn(async () => "claude"),
      spawnSession: vi.fn(),
    };
    const runtime = {
      agentId: "agent-1",
      character: {
        name: "Eliza",
        bio: ["Eliza is terse, warm, and direct."],
      },
      actions: [],
      getSetting: vi.fn(() => null),
      getService: vi.fn((serviceType: string) =>
        serviceType === "PTY_SERVICE" ? ptyService : null,
      ),
      getMemories: vi.fn(async () => [
        {
          entityId: "user-1",
          content: { text: "review that latest agent failure" },
        },
      ]),
      useModel: vi.fn(
        async (_modelType: string, params: { prompt: string }) => {
          prompts.push(params.prompt);
          return "Eliza here. I could not start the review agent because Claude Code is not installed yet.";
        },
      ),
    };

    const result = await handleMultiAgent(
      {
        // biome-ignore lint/suspicious/noExplicitAny: focused runtime mock
        runtime: runtime as any,
        // biome-ignore lint/suspicious/noExplicitAny: focused PTY service mock
        ptyService: ptyService as any,
        wsService: undefined,
        // biome-ignore lint/suspicious/noExplicitAny: credential shape is unused on preflight failure
        credentials: {} as any,
        customCredentials: undefined,
        callback: async (content) => {
          callbacks.push({ text: content.text });
        },
        message: {
          id: "msg-1",
          roomId: "room-1",
          worldId: "world-1",
          entityId: "user-1",
          content: { text: "run an idagents review" },
        } as never,
        state: {
          values: {
            recentMessages: "user: run an idagents review",
            actionResults: "1. START_CODING_TASK - failed",
          },
          data: {},
        } as never,
        repo: undefined,
        defaultAgentType: "claude",
        rawAgentType: "claude",
        agentTypeExplicit: true,
        agentSelectionStrategy: "fixed",
        memoryContent: undefined,
        approvalPreset: undefined,
        explicitLabel: "idagents-review",
      },
      "review it",
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toBe(
      "Eliza here. I could not start the review agent because Claude Code is not installed yet.",
    );
    expect(callbacks).toEqual([{ text: result?.text }]);
    expect(ptyService.spawnSession).not.toHaveBeenCalled();
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain("You are Eliza");
    expect(prompts[0]).toContain("Eliza is terse, warm, and direct.");
    expect(prompts[0]).toContain("user: run an idagents review");
    expect(prompts[0]).toContain("START_CODING_TASK - failed");
    expect(prompts[0]).toContain(
      "idagents-review-1 (claude): Claude Code CLI is not installed",
    );
    expect(result?.text).not.toContain("Failed to launch");
  });
});

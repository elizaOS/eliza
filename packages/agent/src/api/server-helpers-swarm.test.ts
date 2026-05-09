import { describe, expect, it, vi } from "vitest";
import {
  handleSwarmSynthesis,
  routeAutonomyTextToUser,
} from "./server-helpers-swarm.ts";

const runtime = {
  getService() {
    return null;
  },
} as never;

describe("handleSwarmSynthesis", () => {
  it("uses the coordinator summary for Codex tasks instead of unrelated Claude jsonl from the same workdir", async () => {
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "app",
            agentType: "codex",
            originalTask: "build a small app",
            status: "completed",
            completionSummary: "https://example.com/apps/breath-ring/",
            workdir: "/workspace/shared-apps",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual(["https://example.com/apps/breath-ring/"]);
  });

  it("uses validator-accepted task evidence when available", async () => {
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "repo-check",
            agentType: "codex",
            originalTask: "inspect the repo status",
            status: "completed",
            completionSummary: "I am checking the branch and PR status.",
            validationSummary:
              "Open PR: https://github.com/example/project/pull/123",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual([
      "Open PR: https://github.com/example/project/pull/123",
    ]);
  });

  it("preserves concrete URLs from task evidence when validator summaries abbreviate them", async () => {
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "docs",
            agentType: "codex",
            originalTask: "make a small docs update and report the link",
            status: "completed",
            completionSummary:
              "Opened review: https://example.com/org/project/pull/123\nValidation passed.",
            validationSummary:
              "A small docs update is open as review #123 and validation passed.",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual([
      [
        "A small docs update is open as review #123 and validation passed.",
        "https://example.com/org/project/pull/123",
      ].join("\n"),
    ]);
  });

  it("routes async connector synthesis as a reply to the originating external message when available", async () => {
    const sent: Array<{ target: unknown; content: Record<string, unknown> }> =
      [];
    const runtimeWithConnector = {
      getService() {
        return null;
      },
      getRoom: async () => ({
        id: "room-1",
        source: "discord",
        channelId: "channel-1",
        serverId: "guild-1",
      }),
      sendMessageToTarget: async (target: unknown, content: unknown) => {
        sent.push({ target, content: content as Record<string, unknown> });
      },
    } as never;

    await handleSwarmSynthesis(
      { runtime: runtimeWithConnector },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "app",
            agentType: "codex",
            originalTask: "build a small app",
            status: "completed",
            completionSummary: "done",
            roomId: "room-1",
            replyToExternalMessageId: "external-message-1",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async () => undefined,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toMatchObject({
      text: "done",
      source: "swarm_synthesis",
      inReplyTo: "external-message-1",
    });
  });
});

describe("routeAutonomyTextToUser", () => {
  it("does not persist swarm synthesis before the connector stores the platform reply", async () => {
    const createMemory = vi.fn();
    const broadcastWs = vi.fn();
    const state = {
      runtime: {
        agentId: "00000000-0000-0000-0000-000000000001",
        createMemory,
      },
      activeConversationId: "conv-1",
      conversations: new Map([
        [
          "conv-1",
          {
            id: "conv-1",
            roomId: "00000000-0000-0000-0000-000000000002",
            updatedAt: "2026-05-07T00:00:00.000Z",
          },
        ],
      ]),
      broadcastWs,
    } as never;

    await routeAutonomyTextToUser(state, "done", "swarm_synthesis");

    expect(createMemory).not.toHaveBeenCalled();
    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "proactive-message",
        message: expect.objectContaining({
          text: "done",
          source: "swarm_synthesis",
        }),
      }),
    );
  });
});

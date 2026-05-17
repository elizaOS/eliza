import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("uses the child completion as the visible answer when validation passes", async () => {
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "status",
            agentType: "codex",
            originalTask: "inspect the project status",
            status: "completed",
            completionSummary:
              "Branch: feature/status-check\nWorktree: clean\nNo files changed.",
            validationSummary:
              "The response is complete and supported by the transcript.",
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
      "Branch: feature/status-check\nWorktree: clean\nNo files changed.",
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
              "A small docs update is open as review #123 and validation passed.",
            validationSummary:
              "Evidence: https://example.com/org/project/pull/123",
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

  it("splits synthesis by originating external reply target", async () => {
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
            label: "first",
            agentType: "codex",
            originalTask: "first image",
            status: "completed",
            completionSummary: "first done",
            roomId: "room-1",
            replyToExternalMessageId: "external-message-1",
          },
          {
            sessionId: "pty-2",
            label: "second",
            agentType: "codex",
            originalTask: "second image",
            status: "completed",
            completionSummary: "second done",
            roomId: "room-1",
            replyToExternalMessageId: "external-message-2",
          },
        ],
        total: 2,
        completed: 2,
        stopped: 0,
        errored: 0,
      },
      async () => undefined,
    );

    expect(sent).toHaveLength(2);
    expect(sent.map((entry) => entry.content)).toEqual([
      expect.objectContaining({
        text: "first done",
        inReplyTo: "external-message-1",
      }),
      expect.objectContaining({
        text: "second done",
        inReplyTo: "external-message-2",
      }),
    ]);
  });

  it("attaches referenced task-workdir artifacts to connector synthesis", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "swarm-artifact-"));
    const imagePath = path.join(workdir, "result.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
            label: "image",
            agentType: "codex",
            originalTask: "generate an image",
            status: "completed",
            completionSummary: `Created image at \`${imagePath}\`.`,
            workdir,
            roomId: "room-1",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async () => undefined,
    );

    expect(sent[0].content).toMatchObject({
      text: "Created image at result.png.",
      attachments: [
        expect.objectContaining({
          url: imagePath,
          title: "result.png",
          contentType: "image",
        }),
      ],
    });
  });

  it("replaces path-only artifact summaries with attachment text", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "swarm-artifact-"));
    const imagePath = path.join(workdir, "result.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
      sendMessageToTarget: async (_target: unknown, content: unknown) => {
        sent.push({
          target: null,
          content: content as Record<string, unknown>,
        });
      },
    } as never;

    await handleSwarmSynthesis(
      { runtime: runtimeWithConnector },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "image",
            agentType: "codex",
            originalTask: "generate an image",
            status: "completed",
            completionSummary: imagePath,
            workdir,
            roomId: "room-1",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async () => undefined,
    );

    expect(sent[0].content).toMatchObject({
      text: "Attached result.png.",
      attachments: [
        expect.objectContaining({
          url: imagePath,
          title: "result.png",
        }),
      ],
    });
  });

  it("removes relative markdown links for artifacts that are already attached", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "swarm-artifact-"));
    const imagePath = path.join(workdir, "assets", "result.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
      sendMessageToTarget: async (_target: unknown, content: unknown) => {
        sent.push({
          target: null,
          content: content as Record<string, unknown>,
        });
      },
    } as never;

    await handleSwarmSynthesis(
      { runtime: runtimeWithConnector },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "image",
            agentType: "codex",
            originalTask: "generate an image",
            status: "completed",
            completionSummary: `Generated image: [assets/result.png](result.png)\nSaved at ${imagePath}.`,
            workdir,
            roomId: "room-1",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async () => undefined,
    );

    expect(sent[0].content).toMatchObject({
      text: "Generated image: result.png\nSaved at result.png.",
      attachments: [
        expect.objectContaining({
          url: imagePath,
          title: "result.png",
        }),
      ],
    });
  });

  it("does not upload referenced input files as deliverables", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "swarm-artifact-"));
    const outputPath = path.join(workdir, "assets", "result.png");
    const referencePath = path.join(workdir, "refs", "reference.png");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await mkdir(path.dirname(referencePath), { recursive: true });
    await writeFile(outputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(referencePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
      sendMessageToTarget: async (_target: unknown, content: unknown) => {
        sent.push({
          target: null,
          content: content as Record<string, unknown>,
        });
      },
    } as never;

    await handleSwarmSynthesis(
      { runtime: runtimeWithConnector },
      {
        tasks: [
          {
            sessionId: "pty-1",
            label: "image",
            agentType: "codex",
            originalTask: "generate an image",
            status: "completed",
            completionSummary: [
              `Created image at \`${outputPath}\`.`,
              `Reference was read from \`${referencePath}\`.`,
            ].join("\n"),
            workdir,
            roomId: "room-1",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      async () => undefined,
    );

    expect(sent[0].content.attachments).toEqual([
      expect.objectContaining({
        url: outputPath,
        title: "result.png",
      }),
    ]);
    expect(sent[0].content.text).toContain("Reference was read from");
    expect(sent[0].content.text).toContain("reference.png");
    expect(sent[0].content.text).not.toContain(referencePath);
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

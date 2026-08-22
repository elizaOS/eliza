/**
 * Unit tests for the swarm synthesis + autonomy relay helpers behind the agent
 * HTTP surface. handleSwarmSynthesis: turning completed sub-agent task results
 * into user-visible text (coordinator summary over raw jsonl, tool-output
 * envelope stripping with evidence URLs preserved, connector replies split by
 * originating external message, workdir artifacts attached/renamed, input files
 * not re-uploaded). routeAutonomyTextToUser: persist-vs-ephemeral delivery.
 * Deterministic: in-memory runtime/state stubs with real temp-dir files for the
 * artifact cases.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSwarmSynthesis,
  routeAutonomyTextToUser,
} from "./server-helpers-swarm.ts";

const runtime = {
  getService() {
    return null;
  },
} as never;

function confirmedSendOutcome(id = "provider-message-1") {
  return {
    kind: "delivered" as const,
    receipt: {
      providerMessageIds: [id] as [string],
      acceptedAt: 1_780_000_000_000,
      persistence: { status: "persisted" as const, memoryIds: [] },
    },
    memories: [],
  };
}

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

  // A stopped Claude session's newest jsonl ends mid-turn: its last assistant
  // text is inner monologue, not a result. Seed the REAL reader path
  // (~/.claude/projects/<sanitized-workdir>/) with such a transcript and prove
  // the non-completed status gate keeps it out of the routed text. Seeded dirs
  // live in the developer's real ~/.claude/projects, so track and remove them.
  const seededProjectDirs: string[] = [];
  afterEach(async () => {
    while (seededProjectDirs.length > 0) {
      const dir = seededProjectDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
  async function seedClaudeTranscript(narration: string): Promise<string> {
    const workdir = await mkdtemp(path.join(tmpdir(), "swarm-stop-"));
    const projectDir = path.join(
      homedir(),
      ".claude",
      "projects",
      workdir.replace(/[/.]/g, "-"),
    );
    seededProjectDirs.push(projectDir);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "session.jsonl"),
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: narration }],
        },
      })}\n`,
      "utf8",
    );
    return workdir;
  }

  it("relays only the verification verdict for a stopped Claude task, never the transcript tail", async () => {
    const narration =
      "Now let me read the launch check itself to see exactly how it resolves the app.";
    const workdir = await seedClaudeTranscript(narration);
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-stopped",
            label: "app",
            agentType: "claude",
            originalTask: "make an app showcasing eliza",
            status: "stopped",
            completionSummary: "raw lastOutput that must not relay either",
            validationSummary: "verification failed: launch check did not pass",
            workdir,
          },
        ],
        total: 1,
        completed: 0,
        stopped: 1,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual(["verification failed: launch check did not pass"]);
  });

  it("falls back to a lifecycle line for a stopped Claude task with no verdict (model failure keeps the deterministic shape)", async () => {
    const workdir = await seedClaudeTranscript(
      "Let me grep the registry cache next.",
    );
    const routed: string[] = [];

    // The stop line is model-phrased via the local phraseLifecycleLine mirror;
    // a rejecting model must degrade to the deterministic fallback literal.
    const failingModelRuntime = {
      getService() {
        return null;
      },
      character: { name: "TestBot" },
      useModel: async () => {
        throw new Error("model down");
      },
    } as never;

    await handleSwarmSynthesis(
      { runtime: failingModelRuntime },
      {
        tasks: [
          {
            sessionId: "pty-stopped-2",
            label: "app",
            agentType: "claude",
            originalTask: "make an app showcasing eliza",
            status: "stopped",
            completionSummary: "",
            workdir,
          },
        ],
        total: 1,
        completed: 0,
        stopped: 1,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual(["app — stopped before completion."]);
  });

  it("relays the model-phrased stop line when the model output carries the task name and no machinery vocabulary", async () => {
    const workdir = await seedClaudeTranscript("irrelevant narration");
    const routed: string[] = [];
    const phrased =
      "Heads up — app stopped partway through, so there's nothing finished to show yet.";
    const phrasingRuntime = {
      getService() {
        return null;
      },
      character: { name: "TestBot" },
      useModel: async () => phrased,
    } as never;

    await handleSwarmSynthesis(
      { runtime: phrasingRuntime },
      {
        tasks: [
          {
            sessionId: "pty-stopped-3",
            label: "app",
            agentType: "claude",
            originalTask: "make an app showcasing eliza",
            status: "stopped",
            completionSummary: "",
            workdir,
          },
        ],
        total: 1,
        completed: 0,
        stopped: 1,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual([phrased]);
  });

  it("rejects phrased stop lines that drop the task name, keeping the deterministic fallback", async () => {
    const workdir = await seedClaudeTranscript("irrelevant narration");
    const routed: string[] = [];
    const runtimeDroppingAsk = {
      getService() {
        return null;
      },
      character: { name: "TestBot" },
      // No "app" in the output → mustInclude violation → fallback.
      useModel: async () => "The task stopped partway through.",
    } as never;

    await handleSwarmSynthesis(
      { runtime: runtimeDroppingAsk },
      {
        tasks: [
          {
            sessionId: "pty-stopped-4",
            label: "app",
            agentType: "claude",
            originalTask: "make an app showcasing eliza",
            status: "stopped",
            completionSummary: "",
            workdir,
          },
        ],
        total: 1,
        completed: 0,
        stopped: 1,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual(["app — stopped before completion."]);
  });

  it("never relays a kickoff-prompt originalTask raw (live incident shape)", async () => {
    const workdir = await seedClaudeTranscript("irrelevant narration");
    const kickoff =
      '--- Swarm Coordination ---\nNamed coding sub-agent in a task swarm. Keep working until the task is finished or genuinely blocked.\n\nBuild sweeptune.\nWhen done print: APP_CREATE_DONE {"appName":"sweeptune","files":["src/App.tsx"]}';
    const routed: string[] = [];
    // Model stubbed to fail: the kickoff-prompt guard must still yield the
    // deterministic lifecycle fallback, never the raw prompt text.
    const kickoffRuntime = {
      getService() {
        return null;
      },
      character: { name: "TestBot" },
      useModel: async () => {
        throw new Error("model down");
      },
    } as never;

    await handleSwarmSynthesis(
      { runtime: kickoffRuntime },
      {
        tasks: [
          {
            sessionId: "pty-kickoff",
            label: "",
            agentType: "elizaos",
            originalTask: kickoff,
            status: "stopped",
            completionSummary: "",
            workdir,
          },
        ],
        total: 1,
        completed: 0,
        stopped: 1,
        errored: 0,
      },
      async (text) => {
        routed.push(text);
      },
    );

    expect(routed).toEqual(["coding task — stopped before completion."]);
    expect(routed[0]).not.toContain("Swarm Coordination");
    expect(routed[0]).not.toContain("APP_CREATE_DONE");
  });

  it("strips captured tool-output envelopes from the completionSummary, preserving evidence URLs (#11578)", async () => {
    const routed: string[] = [];

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-leak",
            label: "app",
            agentType: "codex",
            originalTask: "build a small app",
            status: "completed",
            // finalText carrying the orchestrator's own envelope block; this is
            // the round-3 raw-transcript leak in issue elizaOS/eliza#11578.
            completionSummary:
              "Deployed the app.\n" +
              "[tool output: bash]\n$ npm run build\n… raw build log …\n[/tool output]\n" +
              "Live at https://example.com/apps/leaky/",
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

    expect(routed).toHaveLength(1);
    const text = routed[0];
    expect(text).toContain("Deployed the app.");
    expect(text).toContain("https://example.com/apps/leaky/");
    expect(text).not.toContain("[tool output:");
    expect(text).not.toContain("[/tool output]");
    expect(text).not.toContain("npm run build");
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
    const dashboardFallback = vi.fn(async () => undefined);
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
        return confirmedSendOutcome();
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
      dashboardFallback,
    );

    expect(sent).toHaveLength(1);
    expect(dashboardFallback).not.toHaveBeenCalled();
    expect(sent[0].content).toMatchObject({
      text: "done",
      source: "swarm_synthesis",
      inReplyTo: "external-message-1",
    });
  });

  it("uses one client_chat transport for dashboard-origin synthesis", async () => {
    const sendMessageToTarget = vi.fn(async () => confirmedSendOutcome());
    const dashboardFallback = vi.fn(async () => undefined);
    const runtimeWithDashboardRelay = {
      getService() {
        return null;
      },
      getRoom: async () => ({
        id: "room-1",
        source: "client_chat",
        channelId: "room-1",
      }),
      sendMessageToTarget,
    } as never;

    await handleSwarmSynthesis(
      { runtime: runtimeWithDashboardRelay },
      {
        tasks: [
          {
            sessionId: "pty-dashboard",
            label: "dashboard task",
            agentType: "codex",
            originalTask: "inspect the repository",
            status: "completed",
            completionSummary: "done",
            roomId: "room-1",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      dashboardFallback,
    );

    expect(sendMessageToTarget).toHaveBeenCalledTimes(1);
    expect(sendMessageToTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "client_chat",
        roomId: "room-1",
      }),
      expect.objectContaining({
        text: "done",
        source: "swarm_synthesis",
      }),
    );
    expect(dashboardFallback).not.toHaveBeenCalled();
  });

  it("falls back to the dashboard only when the origin route is unavailable", async () => {
    const dashboardFallback = vi.fn(async () => undefined);

    await handleSwarmSynthesis(
      { runtime },
      {
        tasks: [
          {
            sessionId: "pty-no-origin",
            label: "dashboard task",
            agentType: "codex",
            originalTask: "inspect the repository",
            status: "completed",
            completionSummary: "done",
          },
        ],
        total: 1,
        completed: 1,
        stopped: 0,
        errored: 0,
      },
      dashboardFallback,
    );

    expect(dashboardFallback).toHaveBeenCalledTimes(1);
    expect(dashboardFallback).toHaveBeenCalledWith("done", "swarm_synthesis");
  });

  it("surfaces origin failures without invoking a second transport", async () => {
    const dashboardFallback = vi.fn(async () => undefined);
    const runtimeWithFailedConnector = {
      getService() {
        return null;
      },
      getRoom: async () => ({
        id: "room-1",
        source: "discord",
        channelId: "channel-1",
      }),
      sendMessageToTarget: async () => {
        throw new Error("connector unavailable");
      },
    } as never;

    await expect(
      handleSwarmSynthesis(
        { runtime: runtimeWithFailedConnector },
        {
          tasks: [
            {
              sessionId: "pty-failed-origin",
              label: "connector task",
              agentType: "codex",
              originalTask: "inspect the repository",
              status: "completed",
              completionSummary: "done",
              roomId: "room-1",
            },
          ],
          total: 1,
          completed: 1,
          stopped: 0,
          errored: 0,
        },
        dashboardFallback,
      ),
    ).rejects.toThrow("connector unavailable");

    expect(dashboardFallback).not.toHaveBeenCalled();
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
        return confirmedSendOutcome();
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
        return confirmedSendOutcome();
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
        return confirmedSendOutcome();
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
        return confirmedSendOutcome();
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
        return confirmedSendOutcome();
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

  it("persists reminder nudges because their notification deep-links to chat", async () => {
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

    await routeAutonomyTextToUser(state, "Take your meds", "reminder");

    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          text: "Take your meds",
          source: "reminder",
        }),
      }),
      "messages",
    );
    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "proactive-message",
        message: expect.objectContaining({
          text: "Take your meds",
          source: "reminder",
        }),
      }),
    );
  });

  it("still suppresses activity/feed-only autonomy sources that have chat-visible siblings", async () => {
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

    for (const source of [
      "workflow",
      "proactive-gm",
      "proactive-gn",
      "proactive-nudge",
    ]) {
      await routeAutonomyTextToUser(state, `hidden ${source}`, source);
    }

    expect(createMemory).not.toHaveBeenCalled();
    expect(broadcastWs).not.toHaveBeenCalled();
  });

  it("preserves repeated identical durable messages as distinct deliveries", async () => {
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

    await routeAutonomyTextToUser(state, "the same reply", "autonomy");
    await routeAutonomyTextToUser(state, "the same reply", "autonomy");

    expect(createMemory).toHaveBeenCalledTimes(2);
    expect(broadcastWs).toHaveBeenCalledTimes(2);
  });

  it("delivers an ephemeral message and a later durable message independently", async () => {
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

    await routeAutonomyTextToUser(state, "shared status", "swarm_synthesis");
    expect(createMemory).not.toHaveBeenCalled();
    expect(broadcastWs).toHaveBeenCalledTimes(1);

    await routeAutonomyTextToUser(state, "shared status", "autonomy");
    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(broadcastWs).toHaveBeenCalledTimes(2);
  });
});

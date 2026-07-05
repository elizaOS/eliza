import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleParentContextRoutes } from "../api/parent-context-routes.js";
import type { RouteContext } from "../api/route-utils.js";
import { PARENT_AGENT_BROKER_SLUG } from "../services/parent-agent-manifest.js";
import type { SessionInfo } from "../services/types.js";

function makeResponse() {
  const res = {
    statusCode: 0,
    headers: undefined as Record<string, string> | undefined,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
  };
  return res as unknown as ServerResponse & typeof res;
}

function makeRequest(pathname: string): IncomingMessage {
  return {
    method: "GET",
    url: pathname,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function makeSession(metadata: Record<string, unknown>): SessionInfo {
  const now = new Date();
  return {
    id: "session-1",
    name: "Ada",
    agentType: "codex",
    workdir: "/tmp/work",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata,
  };
}

function makeContext(session: SessionInfo, services: Record<string, unknown>) {
  const runtime = {
    character: { name: "Eliza", bio: "Assistant" },
    getRoom: vi.fn(async () => ({
      id: "room-1",
      channelId: "chat",
      source: "web",
      type: "dm",
      worldId: "world-1",
    })),
    getService: vi.fn((name: string) => services[name]),
  } as unknown as IAgentRuntime;
  return {
    runtime,
    acpService: {
      getSession: vi.fn(async (id: string) =>
        id === session.id ? session : null,
      ),
    } as unknown as RouteContext["acpService"],
    workspaceService: null,
  } satisfies RouteContext;
}

async function runRoute(ctx: RouteContext, pathname: string) {
  const res = makeResponse();
  const handled = await handleParentContextRoutes(
    makeRequest(pathname),
    res,
    pathname,
    ctx,
  );
  return { handled, status: res.statusCode, body: JSON.parse(res.body) };
}

describe("parent-context bridge routes", () => {
  it("exposes originating task goal, acceptance criteria, and decisions", async () => {
    const session = makeSession({
      taskId: "task-1",
      roomId: "room-1",
      capabilityProfile: "economics",
    });
    const ctx = makeContext(session, {
      ORCHESTRATOR_TASK_SERVICE: {
        getTask: vi.fn(async () => ({
          task: {
            id: "task-1",
            goal: "Ship the app",
            acceptanceCriteria: ["tests pass"],
          },
          decisions: [
            {
              id: "decision-1",
              taskId: "task-1",
              sessionId: "session-1",
              event: "tool_running",
              decisionType: "route",
              actionSelected: "spawn_agent",
              promptText: "full prompt",
              promptExcerpt: "full",
              response: "ok",
              reasoning: "needed a worker",
              timestamp: 1,
              createdAt: "2026-07-05T00:00:00.000Z",
            },
          ],
        })),
      },
    });

    const result = await runRoute(
      ctx,
      "/api/coding-agents/session-1/parent-context",
    );

    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body.task).toMatchObject({
      id: "task-1",
      goal: "Ship the app",
      acceptanceCriteria: ["tests pass"],
      capabilityProfile: "economics",
    });
    expect(result.body.task.decisions).toEqual([
      expect.objectContaining({
        id: "decision-1",
        actionSelected: "spawn_agent",
        reasoning: "needed a worker",
      }),
    ]);
  });

  it("serves requestable skills and full virtual skill bodies", async () => {
    const session = makeSession({});
    const ctx = makeContext(session, {
      AGENT_SKILLS_SERVICE: {
        getLoadedSkills: vi.fn(() => [
          {
            slug: "repo-review",
            name: "Repo Review",
            description: "Review repository code.",
          },
        ]),
        getSkillInstructions: vi.fn((slug: string) =>
          slug === "repo-review"
            ? {
                slug,
                body: "# Repo Review\n\nRead the code.",
                estimatedTokens: 9,
              }
            : null,
        ),
      },
    });

    const list = await runRoute(ctx, "/api/coding-agents/session-1/skills");
    expect(list.status).toBe(200);
    expect(list.body.slugs).toContain("repo-review");
    expect(list.body.slugs).toContain(PARENT_AGENT_BROKER_SLUG);

    const body = await runRoute(
      ctx,
      `/api/coding-agents/session-1/skills/${PARENT_AGENT_BROKER_SLUG}`,
    );
    expect(body.status).toBe(200);
    expect(body.body.source).toBe("virtual");
    expect(body.body.body).toContain("USE_SKILL parent-agent");
  });
});

/**
 * ACTIVE_SUB_AGENTS lists the sessions the current conversation can act on.
 * A session started from another room, and its live output, must not reach a
 * turn in this room: the provider composes for any sender the agent answers.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import type { SessionInfo } from "../services/types.js";
import { activeSubAgentsProvider } from "./active-sub-agents.js";

const ROOM_R = "00000000-0000-0000-0000-00000000roomr" as UUID;
const ROOM_S = "00000000-0000-0000-0000-00000000rooms" as UUID;

function session(id: string, roomId: string): SessionInfo {
  return {
    id,
    name: id,
    agentType: "claude",
    status: "running",
    workdir: `/work/${id}`,
    metadata: { roomId, userId: "owner" },
  } as unknown as SessionInfo;
}

/** Mirrors the real task service: list rows carry no room; the origin is a lookup. */
const tasks = [
  {
    id: "task-r",
    title: "Refactor the router",
    status: "running",
    activeSessionCount: 1,
    room: ROOM_R,
  },
  {
    id: "task-s",
    title: "Rotate the secrets",
    status: "validating",
    activeSessionCount: 0,
    room: ROOM_S,
  },
];
const taskService = {
  listTasks: async () => tasks.map(({ room: _room, ...row }) => row),
  getTaskOriginTarget: async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    return task ? { roomId: task.room, source: "discord" } : null;
  },
};

function runtime(sessions: SessionInfo[]): IAgentRuntime {
  const acp = {
    listSessions: () => sessions,
    getSessionOutput: async (id: string) => `OUTPUT_OF_${id}`,
  };
  return {
    agentId: "00000000-0000-0000-0000-0000000agent" as UUID,
    getService: (type: string) =>
      type === AcpService.serviceType
        ? acp
        : type === OrchestratorTaskService.serviceType
          ? taskService
          : null,
    getSetting: () => undefined,
    reportError: () => undefined,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  } as unknown as IAgentRuntime;
}

describe("ACTIVE_SUB_AGENTS room scope", () => {
  it("shows only the current room's sessions and their output", async () => {
    const rt = runtime([session("sess-r", ROOM_R), session("sess-s", ROOM_S)]);
    const result = await activeSubAgentsProvider.get(
      rt,
      { roomId: ROOM_R, entityId: "someone" as UUID, content: {} } as Memory,
      {} as never,
    );
    expect(result.text).toContain("sessionId=sess-r");
    expect(result.text).toContain("OUTPUT_OF_sess-r");
    expect(result.text).not.toContain("sess-s");
    expect(result.text).not.toContain("OUTPUT_OF_sess-s");
    const listed = (
      result.data as { sessions: Array<{ sessionId: string }> }
    ).sessions.map((s) => s.sessionId);
    expect(listed).toEqual(["sess-r"]);
    expect(result.text).toContain("## In-flight tasks");
    expect(result.text).toContain('"Refactor the router"');
    expect(result.text).not.toContain("Rotate the secrets");
  });

  it("is not composed for guests", () => {
    expect(activeSubAgentsProvider.roleGate?.minRole).toBe("USER");
  });
});

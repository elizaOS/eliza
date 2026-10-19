/**
 * A sub-agent spawned with a worktree room has two swarm rooms (task and
 * worktree). Its completion must reach the user once: one planner turn (in
 * the task room) answers the origin channel, and the worktree room only
 * stores the post. Real SubAgentRouter.handleEvent with a stand-in runtime.
 */
import { expect, it } from "vitest";
import { SubAgentRouter } from "../services/sub-agent-router.ts";

const ORIGIN = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const WORKTREE = "33333333-3333-4333-8333-333333333333";

it("answers the user once for a completion posted to two swarm rooms", async () => {
  const session = {
    id: "s1",
    agentType: "codex",
    workdir: "/nonexistent-workdir",
    status: "ready",
    name: "s1",
    metadata: {
      label: "fix login",
      source: "discord",
      messageId: "44444444-4444-4444-8444-444444444444",
      originRoomId: ORIGIN,
      roomId: TASK,
      taskRoomId: TASK,
      worktreeRoomId: WORKTREE,
      swarmRooms: [
        { roomId: TASK, roles: ["task"] },
        { roomId: WORKTREE, roles: ["worktree"] },
      ],
      initialTask: "fix login",
    },
  };
  const acp = {
    onSessionEvent: () => () => {},
    getSession: async () => session,
    listSessions: async () => [session],
    getChangedPaths: () => [],
    updateSessionMetadata: async () => {},
    stopSession: async () => {},
  };
  const userSends: string[] = [];
  const plannerRooms: string[] = [];
  const storedRooms: string[] = [];
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "T" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    getService: (type: string) =>
      type === "ACP_SUBPROCESS_SERVICE" ? acp : null,
    reportError: () => {},
    createEntity: async () => true,
    addParticipant: async () => true,
    getEntitiesForRoom: async () => [],
    deleteParticipants: async () => true,
    createMemory: async (memory: { id: string; roomId: string }) => {
      storedRooms.push(memory.roomId);
      return memory.id;
    },
    sendMessageToTarget: async (
      target: { roomId: string },
      content: { text: string },
    ) => {
      userSends.push(`${target.roomId}: ${content.text}`);
      return [{ id: "m", content }];
    },
    messageService: {
      handleMessage: async (
        _runtime: unknown,
        memory: { roomId: string },
        callback?: (content: { text: string }) => Promise<unknown>,
      ) => {
        plannerRooms.push(memory.roomId);
        await callback?.({ text: "Login is fixed; tests pass." });
      },
    },
  };
  const router = new SubAgentRouter(runtime as never);
  (router as unknown as { acp: typeof acp }).acp = acp;

  await (
    router as unknown as {
      handleEvent(
        sessionId: string,
        event: string,
        data: unknown,
        session: unknown,
        turnId: string,
      ): Promise<void>;
    }
  ).handleEvent(
    "s1",
    "task_complete",
    { response: "Login is fixed; tests pass." },
    session,
    "turn-1",
  );

  expect(plannerRooms).toEqual([TASK]);
  expect(userSends).toEqual([`${ORIGIN}: Login is fixed; tests pass.`]);
  expect(storedRooms).toEqual([WORKTREE]);
});

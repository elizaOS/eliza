/**
 * The owner-send approval task must be created in the room the owner asked
 * in, because CHOOSE_OPTION only sees tasks of the current room. A draft
 * without a room fell back to the agent's own room, where no confirmation
 * could reach it.
 */
import type { IAgentRuntime, Memory, Task } from "@elizaos/core";
import { choiceAction } from "@elizaos/plugin-assistant";
import { expect, it, vi } from "vitest";
import { createOwnerSendPolicy } from "./owner-send-policy.ts";

const AGENT = "00000000-0000-4000-8000-000000000001";
const ROOM = "00000000-0000-4000-8000-000000000203";
const OWNER = "00000000-0000-4000-8000-000000000202";

function runtimeWithTasks() {
  const tasks: Task[] = [];
  const workers = new Map<string, unknown>();
  const runtime = {
    agentId: AGENT,
    createTask: async (task: Task) => {
      const id = `task-${tasks.length + 1}`;
      tasks.push({ ...task, id } as Task);
      return id;
    },
    getTasks: async (query: { roomId?: string; tags?: string[] }) =>
      tasks.filter(
        (task) =>
          (!query.roomId || task.roomId === query.roomId) &&
          (query.tags ?? []).every((tag) => task.tags?.includes(tag)),
      ),
    registerTaskWorker: (worker: { name: string }) => {
      workers.set(worker.name, worker);
    },
    getTaskWorker: (name: string) => workers.get(name),
    getService: () => null,
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
  return { runtime, tasks };
}

async function enqueueAndCheck(metadata: Record<string, unknown> | undefined) {
  const { runtime, tasks } = runtimeWithTasks();
  await createOwnerSendPolicy().enqueueApproval(
    runtime,
    {
      source: "gmail",
      to: [{ identifier: "alice@example.com" }],
      subject: "Notes",
      body: "The notes.",
      ...(metadata ? { metadata } : {}),
    },
    async () => ({ externalId: "never" }),
  );
  const ownerTurn = {
    roomId: ROOM,
    entityId: OWNER,
    content: { text: "confirm" },
  } as Memory;
  return {
    taskRoom: tasks[0]?.roomId,
    ownerCanChoose: await choiceAction.validate?.(runtime, ownerTurn, {
      values: {},
      data: { room: { id: ROOM, messageServerId: "server-1" } },
      text: "",
    }),
  };
}

it("creates the hold in the requesting room, where the owner can confirm it", async () => {
  expect(await enqueueAndCheck({ roomId: ROOM, entityId: OWNER })).toEqual({
    taskRoom: ROOM,
    ownerCanChoose: true,
  });
});

it("falls back to the agent's own room when the draft carries none", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(await enqueueAndCheck(undefined)).toEqual({
    taskRoom: AGENT,
    ownerCanChoose: false,
  });
});

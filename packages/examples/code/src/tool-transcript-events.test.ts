// @vitest-environment node

import { beforeEach, describe, expect, test } from "bun:test";
import {
  type ActionEventPayload,
  type AgentRuntime,
  EventType,
  stringToUuid,
} from "@elizaos/core";
import { App } from "./App.js";
import { useStore } from "./lib/store.js";

type RuntimeHandler = (payload: ActionEventPayload) => Promise<void>;

function makeRuntime(): {
  runtime: AgentRuntime;
  emit: (event: EventType, payload: ActionEventPayload) => Promise<void>;
} {
  const handlers = new Map<string, RuntimeHandler[]>();
  const runtime = Object.assign(Object.create(null) as AgentRuntime, {
    agentId: "test",
    character: { name: "Eliza" },
    getService: () => null,
    registerEvent: (event: string, handler: RuntimeHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  return {
    runtime,
    emit: async (event, payload) => {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload);
      }
    },
  };
}

function actionPayload(args: {
  action: string;
  roomId: ActionEventPayload["roomId"];
  data?: Record<string, unknown>;
}): ActionEventPayload {
  return Object.assign(Object.create(null) as ActionEventPayload, {
    roomId: args.roomId,
    world: stringToUuid("tool-transcript-world"),
    content: {
      actions: [args.action],
      actionResult: {
        success: true,
        ...(args.data ? { data: args.data } : {}),
      },
    },
  });
}

describe("App tool transcript events (#11330)", () => {
  beforeEach(() => {
    useStore.setState({ rooms: [] });
  });

  test("updates a started tool line with the completed shell command", async () => {
    const { runtime, emit } = makeRuntime();
    const state = useStore.getState();
    const room = state.createRoom("Tool transcript");
    const app = new App(runtime);

    // biome-ignore lint/complexity/useLiteralKeys: private test hook
    app["initializeManagers"]();

    await emit(
      EventType.ACTION_STARTED,
      actionPayload({ action: "SHELL", roomId: room.elizaRoomId }),
    );

    let messages = useStore.getState().getCurrentRoom().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("tool");
    expect(messages[0]?.content).toBe("tool shell");

    await emit(
      EventType.ACTION_COMPLETED,
      actionPayload({
        action: "SHELL",
        roomId: room.elizaRoomId,
        data: { command: "bun test", exit_code: 0 },
      }),
    );

    messages = useStore.getState().getCurrentRoom().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("tool");
    expect(messages[0]?.content).toBe("run bun test exited 0");
  });
});

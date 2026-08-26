/** Verifies the interactive TUI send boundary applies the shared Pi coding policy. */

import { expect, it } from "bun:test";
import type { SendMessageParams } from "./agent-client.js";
import { sendInteractiveCodingTurn } from "./interactive-coding-turn.js";

it("sends interactive turns with the Pi profile", async () => {
  let sentOptions: SendMessageParams | undefined;
  const client = {
    sendMessage: async (options: SendMessageParams) => {
      sentOptions = options;
      return "done";
    },
  };

  await sendInteractiveCodingTurn(client, {
    room: {
      id: "room",
      name: "Room",
      messages: [],
      createdAt: new Date(),
      taskIds: [],
      elizaRoomId: "00000000-0000-0000-0000-000000000001",
    },
    text: "inspect the repository",
    identity: {
      projectId: "00000000-0000-0000-0000-000000000002",
      userId: "00000000-0000-0000-0000-000000000003",
      worldId: "00000000-0000-0000-0000-000000000004",
      messageServerId: "00000000-0000-0000-0000-000000000005",
    },
  });

  expect(sentOptions).toMatchObject({
    codingMode: true,
    codingActionProfile: { kind: "pi" },
  });
});

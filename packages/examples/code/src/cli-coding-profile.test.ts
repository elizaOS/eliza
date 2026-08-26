/** Verifies the one-shot CLI selects the Pi action profile at the agent-client boundary. */

import { expect, it } from "bun:test";
import { sendCliCodingTurn } from "./cli.js";
import type { SendMessageParams } from "./lib/agent-client.js";

it("sends coding turns with the Pi profile", async () => {
  let sentOptions: SendMessageParams | undefined;
  const client = {
    sendMessage: async (options: SendMessageParams) => {
      sentOptions = options;
      return "done";
    },
  };

  await expect(
    sendCliCodingTurn(client, {
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
    }),
  ).resolves.toBe("done");
  expect(sentOptions).toMatchObject({
    codingMode: true,
    codingActionProfile: { kind: "pi" },
  });
});

/** Exercises host message preparation, exact durable storage and request-scoped shell routing through the real assistant ingress and SQLite runtime. No model or transport is substituted. */
import {
  bindIncomingMessagePersistence,
  ChannelType,
  incomingMessagePersistenceSnapshot,
  inheritIncomingMessagePersistence,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing";
import { expect, it } from "vitest";
import { DefaultMessageService } from "../../../plugins/plugin-assistant/src/services/message.ts";
import { persistExactConversationMemory } from "../src/api/chat-routes.ts";
import { withViewInteractionClient } from "../src/api/conversation-routes.ts";
import { buildUserMessages } from "../src/api/server-helpers.ts";

it("preserves request routing while reusing the host's exact persisted original", async () => {
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "Host ingress",
      bio: ["test"],
      settings: { BASIC_CAPABILITIES_DEFLLMOFF: true },
    },
    logLevel: "fatal",
  });
  try {
    const { userMessage, messageToStore } = await buildUserMessages({
      images: undefined,
      prompt: "19 plus 23",
      userId: stringToUuid("host-owner"),
      agentId: runtime.agentId,
      roomId: stringToUuid("host-room"),
      channelType: ChannelType.DM,
      metadata: { uiView: "chat" },
    });
    const routed = withViewInteractionClient(userMessage, {
      headers: { "x-eliza-client-id": "ui-ingress-test" },
    });
    expect(routed.content.metadata).toMatchObject({
      viewClientId: "ui-ingress-test",
    });
    await persistExactConversationMemory(runtime, messageToStore);
    bindIncomingMessagePersistence(routed, messageToStore);
    const augmented: Memory = {
      ...routed,
      content: {
        ...routed.content,
        text: "Prompt-only trusted language augmentation",
      },
    };
    inheritIncomingMessagePersistence(routed, augmented);
    const result = await new DefaultMessageService().handleMessage(
      runtime,
      augmented,
    );
    expect(result.didRespond).toBe(false);
    if (!messageToStore.id) throw new Error("Expected host message ID");
    expect((await runtime.getMemoryById(messageToStore.id))?.content).toEqual(
      messageToStore.content,
    );
    expect(augmented.content.metadata).toMatchObject({
      viewClientId: "ui-ingress-test",
    });
    expect(
      incomingMessagePersistenceSnapshot(structuredClone(augmented)),
    ).toBeUndefined();
    const escaped = { ...augmented, roomId: stringToUuid("other-room") };
    expect(() => inheritIncomingMessagePersistence(routed, escaped)).toThrow();
  } finally {
    await runtime.adapter.close();
  }
});

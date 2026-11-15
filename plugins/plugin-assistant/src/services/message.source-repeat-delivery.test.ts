/**
 * A reply the user did not catch is repeated as a quote of that reply. Real
 * PGLite-backed AgentRuntime and message service; only the Stage-1 model is a
 * deterministic fixture (no live model, no network). Preserved
 * tj-38bae5f7eaa3b2: "What?" after "Launch, 12:00-1:00 pm." was restated with
 * the wrong hour; a single source part is delivered byte-identical instead.
 */
import {
  ChannelType,
  type Content,
  createMessageMemory,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createTestRuntimeWithModelProvider } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { createAssistantPlugin } from "../index.ts";

it("delivers a 'What?' repeat quoted as one source part byte-identical", async () => {
  const answer = "Launch, 12:00-1:00 pm.";
  let replySchema: { type?: string; description?: string } | undefined;
  const harness = await createTestRuntimeWithModelProvider({
    plugins: [createAssistantPlugin()],
    fixtures: [
      {
        name: "stage1-repeat",
        match: { modelType: ModelType.RESPONSE_HANDLER },
        response: (call) => {
          replySchema = call.params.tools?.find(
            (tool) => tool.name === "HANDLE_RESPONSE",
          )?.parameters?.properties?.replyText as typeof replySchema;
          return {
            text: "",
            toolCalls: [
              {
                id: "handle-response-1",
                name: "HANDLE_RESPONSE",
                arguments: {
                  shouldRespond: "RESPOND",
                  thought: "",
                  contexts: ["simple"],
                  intents: [],
                  candidateActionNames: [],
                  contextRequests: [],
                  replyText: [{ kind: "source", value: answer }],
                  facts: [],
                  relationships: [],
                  addressedTo: [],
                },
              },
            ],
            finishReason: "tool_calls",
          };
        },
        times: 1,
      },
    ],
  });
  try {
    const { runtime } = harness;
    const roomId = stringToUuid("source-repeat-room") as UUID;
    const userId = stringToUuid("source-repeat-user") as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId: stringToUuid("source-repeat-world") as UUID,
      userName: "Tester",
      source: "test-connector",
      channelId: roomId,
      type: ChannelType.DM,
    });
    const at = Date.now();
    for (const [entityId, text, createdAt] of [
      [userId, "What's on my calendar today?", at - 2000],
      [runtime.agentId, answer, at - 1000],
    ] as const)
      await runtime.createMemory(
        {
          ...createMessageMemory({
            entityId,
            roomId,
            content: {
              text,
              source: "test-connector",
              channelType: ChannelType.DM,
            },
          }),
          createdAt,
        } as Memory,
        "messages",
      );
    const delivered: Content[] = [];
    const result = await runtime.messageService?.handleMessage(
      runtime,
      createMessageMemory({
        id: stringToUuid("source-repeat-what") as UUID,
        entityId: userId,
        roomId,
        content: {
          text: "What?",
          source: "test-connector",
          channelType: ChannelType.DM,
        },
      }),
      async (content) => {
        delivered.push(content);
        return [];
      },
      {},
    );
    expect(replySchema?.type).toBe("array");
    expect(replySchema?.description).toContain("did not catch your last reply");
    expect(delivered.map((content) => content.text)).toEqual([answer]);
    expect(
      result?.responseContent?.sourceReplyReferences?.sources,
    ).toHaveLength(1);
  } finally {
    await harness.cleanup();
  }
});

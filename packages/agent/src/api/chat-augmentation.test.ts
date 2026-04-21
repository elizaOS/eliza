import {
  type AgentRuntime,
  createMessageMemory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { maybeAugmentChatMessageWithKnowledge } from "./chat-augmentation.js";
import { getKnowledgeService } from "./knowledge-service-loader.js";

vi.mock("./knowledge-service-loader.js", () => ({
  getKnowledgeService: vi.fn(),
}));

const mockedGetKnowledgeService = vi.mocked(getKnowledgeService);

describe("maybeAugmentChatMessageWithKnowledge", () => {
  beforeEach(() => {
    mockedGetKnowledgeService.mockReset();
  });

  it("returns the original message when knowledge retrieval fails", async () => {
    const warn = vi.fn();
    mockedGetKnowledgeService.mockResolvedValue({
      service: {
        getKnowledge: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "[router] No provider registered for TEXT_EMBEDDING. Configure a cloud provider, enable local inference, or pair a device.",
            ),
          ),
      },
    } as Awaited<ReturnType<typeof getKnowledgeService>>);

    const runtime = {
      agentId: "agent-1" as UUID,
      logger: { warn },
    } as unknown as AgentRuntime;

    const message = createMessageMemory({
      id: "message-1" as UUID,
      roomId: "room-1" as UUID,
      entityId: "user-1" as UUID,
      content: {
        text: "what is the codeword?",
      },
    });

    await expect(
      maybeAugmentChatMessageWithKnowledge(runtime, message),
    ).resolves.toEqual(message);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "api:chat-augmentation",
        agentId: "agent-1",
        roomId: "room-1",
      }),
      "Knowledge augmentation skipped after retrieval failure",
    );
  });
});

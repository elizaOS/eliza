/** Verifies inbox priority scorer failure handling at the model boundary. */
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsInboxMessage } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPriorityScoringCacheForTests,
  scoreInboxMessages,
} from "./priority-scoring.ts";

function message(id: string): LifeOpsInboxMessage {
  return {
    id,
    channel: "discord",
    sender: {
      id: `sender-${id}`,
      displayName: "Ada",
      email: null,
      avatarUrl: null,
    },
    subject: null,
    snippet: "Can you review this tomorrow at 3pm?",
    receivedAt: "2026-01-01T12:00:00.000Z",
    unread: true,
    deepLink: null,
    sourceRef: { channel: "discord", externalId: id },
  };
}

describe("scoreInboxMessages", () => {
  beforeEach(() => {
    __resetPriorityScoringCacheForTests();
  });

  it("reports model failures and leaves priorities unscored", async () => {
    const error = new Error("model unavailable");
    const reportError = vi.fn();
    const runtime = {
      useModel: vi.fn(async () => {
        throw error;
      }),
      reportError,
    } as unknown as IAgentRuntime;

    const result = await scoreInboxMessages(
      runtime,
      [message("one"), message("two")],
      { model: "test-model", concurrency: 1 },
    );

    expect(result).toEqual([null, null]);
    expect(reportError).toHaveBeenCalledWith(
      "lifeops.priority-scoring",
      error,
      expect.objectContaining({
        count: 2,
        modelId: "test-model",
      }),
    );
  });
});

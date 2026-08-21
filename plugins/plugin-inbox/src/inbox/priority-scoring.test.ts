/** Verifies inbox priority scorer failure handling at the model boundary. */
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsInboxMessage } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INBOX_PRIORITY_FLAGS_UNBOUNDED,
  MAX_INBOX_PRIORITY_FLAGS_OUTPUT,
} from "./priority-flags.ts";
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

  it("fails closed at the reachable scorer boundary on delimiter output amplification", async () => {
    const reportError = vi.fn();
    const flags = Array.from(
      { length: MAX_INBOX_PRIORITY_FLAGS_OUTPUT + 1 },
      () => "urgent",
    ).join("|");
    const runtime = {
      useModel: vi.fn(async () =>
        JSON.stringify({
          scores: [{ score: 80, category: "important", flags }],
        }),
      ),
      reportError,
    } as unknown as IAgentRuntime;

    const result = await scoreInboxMessages(runtime, [message("amplified")], {
      model: "test-model",
      concurrency: 1,
    });

    expect(result).toEqual([null]);
    expect(reportError).toHaveBeenCalledWith(
      "lifeops.priority-scoring",
      expect.objectContaining({ code: INBOX_PRIORITY_FLAGS_UNBOUNDED }),
      expect.objectContaining({ count: 1, modelId: "test-model" }),
    );
  });
});

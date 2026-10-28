import type { LifeOpsInboxMessage } from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import {
  __resetPriorityScoringCacheForTests,
  scoreInboxMessages,
} from "./priority-scoring";

it("keeps priority scores from json5-labelled model fences", async () => {
  const message: LifeOpsInboxMessage = {
    id: "gmail:message",
    channel: "gmail",
    sender: {
      id: "sender",
      displayName: "Sender",
      email: null,
      avatarUrl: null,
    },
    subject: "Meeting",
    snippet: "Can we meet tomorrow?",
    receivedAt: "2026-10-13T00:00:00Z",
    unread: true,
    deepLink: null,
    sourceRef: { channel: "gmail", externalId: "message" },
  };
  const score = { score: 82, category: "important", flags: ["question"] };
  let response = "";
  const errors: unknown[] = [];
  const runtime = {
    useModel: async () => response,
    reportError: (_source: string, error: unknown) => errors.push(error),
  } as unknown as IAgentRuntime;
  for (const payload of [{ scores: [score] }, [score]]) {
    for (const label of ["json5", "JSON5", "json", ""]) {
      __resetPriorityScoringCacheForTests();
      response = `\`\`\`${label}\n${JSON.stringify(payload)}\n\`\`\``;
      expect(await scoreInboxMessages(runtime, [message])).toEqual([score]);
    }
  }
  expect(errors).toEqual([]);
  __resetPriorityScoringCacheForTests();
});

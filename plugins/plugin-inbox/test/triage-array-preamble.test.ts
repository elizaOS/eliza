/**
 * The inbox triage classifier accepts a legacy JSON array answer as well as
 * the `{"results": [...]}` object the prompt asks for. A reasoning model may
 * open its answer with a private-reasoning block. The object answer goes
 * through core `parseJsonModelRecord`, which drops any shared reasoning tag
 * in any case, so the array answer must be read the same way. These tests run
 * `classifyMessages` on a real AgentRuntime whose TEXT_SMALL handler returns
 * the recorded answer.
 */

import {
  type AgentRuntime,
  ModelType,
  type ModelTypeName,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import {
  classifyMessages,
  InboxTriageClassificationError,
} from "../src/inbox/triage-classifier.ts";
import type { InboundMessage } from "../src/inbox/types.ts";

const MESSAGES: InboundMessage[] = [
  {
    id: "msg-1",
    source: "discord",
    senderName: "Sam Rivera",
    channelName: "general",
    channelType: "dm",
    text: "Can you confirm the 3pm sync still works for you?",
    snippet: "Can you confirm the 3pm sync still works for you?",
    timestamp: Date.parse("2026-11-15T15:00:00.000Z"),
  },
  {
    id: "msg-2",
    source: "gmail",
    senderName: "Billing",
    channelName: "Primary",
    channelType: "dm",
    text: "Your October invoice is ready.",
    snippet: "Your October invoice is ready.",
    timestamp: Date.parse("2026-11-15T15:05:00.000Z"),
  },
];

const ARRAY_ANSWER = JSON.stringify([
  {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.8,
    reasoning: "Direct question about the sync.",
    suggestedResponse: "Yes, 3pm still works.",
  },
  {
    classification: "info",
    urgency: "low",
    confidence: 0.9,
    reasoning: "Automated invoice notice.",
    suggestedResponse: null,
  },
]);

describe("inbox triage legacy array after a reasoning block", () => {
  let testResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let answer = "";
  let calls = 0;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "inbox-triage-array-preamble",
      plugins: [],
    });
    runtime = testResult.runtime;
    runtime.registerModel(
      ModelType.TEXT_SMALL as ModelTypeName,
      async () => {
        calls += 1;
        return answer;
      },
      "inbox-triage-array-preamble-test",
      100,
    );
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  async function classify(reply: string) {
    answer = reply;
    const before = calls;
    try {
      return await classifyMessages(runtime, MESSAGES, {});
    } finally {
      // One model call per batch: a parse failure is not retried.
      expect(calls - before).toBe(1);
    }
  }

  it.each([
    ["<thinking>", "</thinking>"],
    ["<THINK>", "</THINK>"],
    ["<reasoning>", "</reasoning>"],
    ["<think>", "</think>"],
  ])("reads the array after a %s block", async (open, close) => {
    const results = await classify(
      `${open}One question, one invoice.${close}\n${ARRAY_ANSWER}`,
    );
    expect(results.map((result) => result.classification)).toEqual([
      "needs_reply",
      "info",
    ]);
    expect(results[0]?.suggestedResponse).toBe("Yes, 3pm still works.");
  });

  it("reads a fenced array after a <thinking> block", async () => {
    const results = await classify(
      `<thinking>One question.</thinking>\n\`\`\`json\n${ARRAY_ANSWER}\n\`\`\``,
    );
    expect(results.map((result) => result.urgency)).toEqual(["medium", "low"]);
  });

  it("still refuses an unclosed block and prose before the array", async () => {
    await expect(
      classify(`<thinking>One question.\n${ARRAY_ANSWER}`),
    ).rejects.toBeInstanceOf(InboxTriageClassificationError);
    await expect(
      classify(
        `<thinking>One question.</thinking>\nHere you go: ${ARRAY_ANSWER}`,
      ),
    ).rejects.toBeInstanceOf(InboxTriageClassificationError);
  });
});

/**
 * Replays the answers of quint/InboxTriageArrayPreamble.qnt through
 * classifyMessages on a real AgentRuntime. The runtime's TEXT_SMALL handler
 * returns the answer and counts the calls; the test records whether the batch
 * got results or an InboxTriageClassificationError.
 */

import { readFileSync } from "node:fs";
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

/** One answer of the model (see the model's header for the encodings). */
interface ModelAnswer {
  tag: number;
  upper: boolean;
  closed: boolean;
  shape: number;
  wrapper: number;
}

/** An answer and what the model says classifyMessages does with it. */
interface ModelCase {
  answer: ModelAnswer;
  classified: boolean;
  failed: boolean;
  calls: number;
}

const TAG_NAMES = ["", "think", "thinking", "reasoning"];
const GROUPS = [
  { name: "no reasoning block", tag: 0 },
  { name: "a think block", tag: 1 },
  { name: "a thinking block", tag: 2 },
  { name: "a reasoning block", tag: 3 },
];
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
const RESULTS = [
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
];

/** Used when the conformance script does not pass generated cases. */
const DEFAULT_CASES: ModelCase[] = GROUPS.flatMap(({ tag }) =>
  [0, 1].map((shape) => ({
    answer: { tag, upper: tag !== 0, closed: true, shape, wrapper: 0 },
    classified: true,
    failed: false,
    calls: 1,
  })),
);

const casesFile = process.env.ELIZA_INBOX_TRIAGE_ARRAY_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

/** The text the model returns for an answer of the model. */
function replyOf(answer: ModelAnswer): string {
  const json = JSON.stringify(
    answer.shape === 0 ? RESULTS : { results: RESULTS },
  );
  const body =
    answer.wrapper === 1
      ? `\`\`\`json\n${json}\n\`\`\``
      : answer.wrapper === 2
        ? `Here are the classifications: ${json}`
        : json;
  if (answer.tag === 0) return body;
  const name = TAG_NAMES[answer.tag] ?? "";
  const tag = answer.upper ? name.toUpperCase() : name;
  const close = answer.closed ? `</${tag}>` : "";
  return `<${tag}>One question and one invoice notice.${close}\n${body}`;
}

describe("inbox triage array preamble model", () => {
  let testResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let reply = "";
  let calls = 0;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "inbox-triage-array-model",
      plugins: [],
    });
    runtime = testResult.runtime;
    runtime.registerModel(
      ModelType.TEXT_SMALL as ModelTypeName,
      async () => {
        calls += 1;
        return reply;
      },
      "inbox-triage-array-model-test",
      100,
    );
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  async function replay(
    answer: ModelAnswer,
  ): Promise<Omit<ModelCase, "answer">> {
    reply = replyOf(answer);
    const before = calls;
    let classified = false;
    let failed = false;
    try {
      const results = await classifyMessages(runtime, MESSAGES, {});
      expect(results.map((result) => result.classification)).toEqual([
        "needs_reply",
        "info",
      ]);
      classified = true;
    } catch (error) {
      expect(error).toBeInstanceOf(InboxTriageClassificationError);
      failed = true;
    }
    return { classified, failed, calls: calls - before };
  }

  it.each(GROUPS.map((group) => group.name))(
    "replays answers after %s",
    async (name) => {
      const tag = GROUPS.find((group) => group.name === name)?.tag;
      const group = cases.filter((item) => item.answer.tag === tag);
      expect(group.length).toBeGreaterThan(0);
      for (const item of group) {
        const observed = await replay(item.answer);
        expect(observed, replyOf(item.answer)).toEqual({
          classified: item.classified,
          failed: item.failed,
          calls: item.calls,
        });
      }
    },
    60_000,
  );
});

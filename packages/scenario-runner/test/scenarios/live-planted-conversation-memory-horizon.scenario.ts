/**
 * Exercises recall from an Eliza-generated, runtime-ingested conversation corpus.
 * The selected tier plants one target in the oldest conversation, adds three
 * plausible decoys later in history, and recalls from a separate fresh room.
 */

import { asUUID } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  generateMessageCorpus,
  seedMessageCorpus,
} from "../../../agent/src/api/message-corpus";
import {
  memoryHorizonCorpusShape,
  parseMemoryHorizonSize,
} from "../../src/memory-horizon";
import { scoreMemoryRecall } from "../../src/memory-recall-metrics";
import { prepareOwnerMemoryRuntime } from "./_helpers/history-recall-runtime";

const TARGET_FACT =
  "The owner's archival project codename is Copper Heron 9184.";
const TARGET_VALUE = "Copper Heron 9184";
const DECOY_VALUES = [
  "Bronze Heron 9184",
  "Copper Egret 9184",
  "Copper Heron 8194",
] as const;

const parsedHorizon = parseMemoryHorizonSize(
  process.env.ELIZA_MEMORY_HORIZON_MESSAGES,
);
if (parsedHorizon.kind === "invalid") {
  throw new Error(parsedHorizon.reason);
}
const MESSAGE_COUNT = parsedHorizon.size;

function plantRecallCases(
  corpus: ReturnType<typeof generateMessageCorpus>,
): string | undefined {
  const target = corpus.conversations[0]?.messages[0];
  if (target?.role !== "user") {
    return "generated corpus did not expose an oldest user message";
  }
  target.text = TARGET_FACT;

  const decoyConversationIndexes = [3, 6, 9] as const;
  for (const [index, conversationIndex] of decoyConversationIndexes.entries()) {
    const decoy = corpus.conversations[conversationIndex]?.messages[0];
    if (decoy?.role !== "user") {
      return `generated corpus did not expose decoy user message ${conversationIndex}`;
    }
    decoy.text = `The owner's archival project codename is ${DECOY_VALUES[index]}.`;
  }
  return undefined;
}

async function seedPlantedConversationCorpus(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const prepared = await prepareOwnerMemoryRuntime(ctx);
  if (typeof prepared === "string") return prepared;
  if (!ctx.primaryUserId) return "scenario owner identity was not available";

  const corpus = generateMessageCorpus({
    ...memoryHorizonCorpusShape(MESSAGE_COUNT),
    spanMonths: 24,
    factsPerConversation: 0,
    seed: 9184,
    now: new Date("2026-08-25T12:00:00.000Z").getTime(),
  });
  const plantFailure = plantRecallCases(corpus);
  if (plantFailure) return plantFailure;

  const summary = await seedMessageCorpus(prepared, corpus, {
    ownerEntityId: asUUID(ctx.primaryUserId),
  });
  if (summary.messagesCreated !== MESSAGE_COUNT) {
    return `expected ${MESSAGE_COUNT} planted messages, created ${summary.messagesCreated}`;
  }
  if (summary.factsCreated !== 0) {
    return `expected no derived fact shortcuts, created ${summary.factsCreated}`;
  }
  return undefined;
}

function actionValues(call: CapturedAction): Record<string, unknown> | null {
  const values = call.result?.values;
  return isRecord(values) ? values : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateHorizonEvidence(ctx: ScenarioContext): string | undefined {
  const searches = ctx.actionsCalled.filter(
    (call) => call.actionName === "MEMORY_SEARCH",
  );
  if (searches.length < 2) {
    return `expected direct and live MEMORY_SEARCH calls, saw ${searches.length}`;
  }
  const directScanned = actionValues(searches[0])?.scanned;
  if (typeof directScanned !== "number" || directScanned < MESSAGE_COUNT) {
    return `direct search scanned ${String(directScanned)} rows, expected at least ${MESSAGE_COUNT} planted rows`;
  }
  const liveScanned = actionValues(searches.at(-1) ?? searches[0])?.scanned;
  if (liveScanned !== directScanned + 1) {
    return `live search scanned ${String(liveScanned)} rows, expected exactly one more than the direct scan of ${directScanned}`;
  }

  const response = ctx.turns?.[1]?.responseText ?? "";
  const score = scoreMemoryRecall([
    {
      id: `${MESSAGE_COUNT}-message-live-recall`,
      response,
      expected: [TARGET_VALUE],
      forbidden: [...DECOY_VALUES],
    },
  ]);
  if (score.kind === "invalid") return score.reason;
  if (
    score.recall !== 1 ||
    score.precision !== 1 ||
    score.falsePositiveRate !== 0
  ) {
    return `recall quality failed at ${MESSAGE_COUNT} messages: ${JSON.stringify(score)}`;
  }
  return undefined;
}

export default scenario({
  id: "live-planted-conversation-memory-horizon",
  lane: "live-only",
  title: "Recall from a graduated planted conversation corpus",
  domain: "scenario-runner",
  tags: ["live", "memory", "long-horizon", "planted-conversation", "scale"],
  isolation: "per-scenario",
  now: "2026-08-25T12:00:00.000Z",
  rooms: [
    {
      id: "main",
      source: "chat",
      channelType: "DM",
      title: "Fresh long-horizon recall room",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "plant canonical runtime conversation corpus",
      apply: seedPlantedConversationCorpus,
    },
  ],
  turns: [
    {
      kind: "action",
      name: "prove exhaustive direct retrieval before model recall",
      text: "Search the planted conversation history for the exact archival project codename.",
      actionName: "MEMORY_SEARCH",
      options: {
        parameters: {
          action: "search",
          type: "messages",
          query: "archival project codename Copper Heron 9184",
        },
      },
      responseIncludesAny: [TARGET_VALUE.toLowerCase()],
    },
    {
      kind: "message",
      name: "recall the oldest planted fact from a fresh room",
      room: "main",
      text: "What was the oldest archival project codename I told you? Search all stored conversation memory and use the stored timestamps before answering with only that oldest codename.",
      responseIncludesAny: [TARGET_VALUE.toLowerCase()],
      responseExcludes: DECOY_VALUES.map((value) => new RegExp(value, "i")),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "MEMORY_SEARCH",
      status: "success",
      minCount: 2,
    },
    {
      type: "custom",
      name: "complete scan and perfect recall quality at selected horizon",
      predicate: validateHorizonEvidence,
    },
  ],
});

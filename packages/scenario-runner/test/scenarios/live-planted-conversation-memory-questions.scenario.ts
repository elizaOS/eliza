/**
 * Exercises twenty independent recall questions against one runtime-ingested
 * conversation corpus. The suite plants exact temporal, corrected, numeric,
 * cross-topic, multi-hop, negative, and decoy-bearing facts, then requires the
 * live planner to search the complete authorized message snapshot per turn.
 */

import { asUUID } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioDefinition,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  type GeneratedMessageCorpus,
  generateMessageCorpus,
  seedMessageCorpus,
} from "../../../agent/src/api/message-corpus";
import {
  memoryHorizonCorpusShape,
  parseMemoryHorizonSize,
} from "../../src/memory-horizon";
import { prepareOwnerMemoryRuntime } from "./_helpers/history-recall-runtime";

interface RecallQuestion {
  id: string;
  prompt: string;
  expectedAny: readonly string[];
  expectedAll?: readonly string[];
}

interface PlantedMessage {
  conversation: number;
  message: number;
  text: string;
}

const parsedHorizon = parseMemoryHorizonSize(
  process.env.ELIZA_MEMORY_HORIZON_MESSAGES,
);
if (parsedHorizon.kind === "invalid") throw new Error(parsedHorizon.reason);
const MESSAGE_COUNT = parsedHorizon.size;

const PLANTED_MESSAGES: readonly PlantedMessage[] = [
  {
    conversation: 0,
    message: 0,
    text: "The owner's oldest archival project codename is Copper Heron 9184.",
  },
  {
    conversation: 9,
    message: -2,
    text: "The owner's newest archival project codename is Silver Falcon 2042.",
  },
  {
    conversation: 0,
    message: 2,
    text: "The original archive vault code was 4107.",
  },
  {
    conversation: 8,
    message: 2,
    text: "Correction: the current archive vault code is 9912, replacing 4107.",
  },
  {
    conversation: 1,
    message: 2,
    text: "The owner's old working timezone was Europe/London.",
  },
  {
    conversation: 7,
    message: 2,
    text: "Correction: the owner's current working timezone is Asia/Kolkata, not Europe/London.",
  },
  {
    conversation: 2,
    message: 2,
    text: "The previous production deployment region was us-east-2.",
  },
  {
    conversation: 6,
    message: 2,
    text: "Production moved to eu-west-1; that is the current deployment region.",
  },
  {
    conversation: 3,
    message: 2,
    text: "Project Juniper Kite is led by Mira Chen.",
  },
  {
    conversation: 5,
    message: 2,
    text: "Project Juniper Kite has a deadline of November 14, 2026.",
  },
  {
    conversation: 4,
    message: 2,
    text: "The owner's favorite tea is masala chai; the decoy drink is sencha.",
  },
  {
    conversation: 4,
    message: 4,
    text: "The owner is allergic to pistachios, not almonds.",
  },
  {
    conversation: 5,
    message: 4,
    text: "The saved literary science-fiction recommendation is The Left Hand of Darkness.",
  },
  {
    conversation: 5,
    message: 6,
    text: "The owner's target marathon city is Berlin, not Boston.",
  },
  {
    conversation: 6,
    message: 4,
    text: "The production gateway server nickname is cedar-gateway.",
  },
  {
    conversation: 6,
    message: 6,
    text: "The unpaid contractor invoice number is 48271.",
  },
  {
    conversation: 7,
    message: 4,
    text: "The tomato variety that ripened first was Sungold.",
  },
  {
    conversation: 7,
    message: 6,
    text: "The Kyoto booking is at Kumo Ryokan.",
  },
  {
    conversation: 8,
    message: 4,
    text: "The recurring project review meeting is on Thursday.",
  },
  {
    conversation: 8,
    message: 6,
    text: "Database backups run every six hours.",
  },
  {
    conversation: 0,
    message: 4,
    text: "Amber Lark 3100 was recorded before Indigo Wren 7700.",
  },
] as const;

const QUESTIONS: readonly RecallQuestion[] = [
  {
    id: "oldest-codename",
    prompt: "What is the oldest archival project codename I told you?",
    expectedAny: ["Copper Heron 9184"],
  },
  {
    id: "newest-codename",
    prompt: "What is the newest archival project codename I told you?",
    expectedAny: ["Silver Falcon 2042"],
  },
  {
    id: "original-vault-code",
    prompt: "What was the original archive vault code?",
    expectedAny: ["4107"],
  },
  {
    id: "current-vault-code",
    prompt: "What is the current archive vault code?",
    expectedAny: ["9912"],
  },
  {
    id: "current-timezone",
    prompt: "What is my current working timezone?",
    expectedAny: ["Asia/Kolkata"],
  },
  {
    id: "previous-timezone",
    prompt: "Which working timezone did I use before Asia/Kolkata?",
    expectedAny: ["Europe/London"],
  },
  {
    id: "current-region",
    prompt: "What is our current production deployment region?",
    expectedAny: ["eu-west-1"],
  },
  {
    id: "previous-region",
    prompt: "Which production region did we use before eu-west-1?",
    expectedAny: ["us-east-2"],
  },
  {
    id: "project-lead",
    prompt: "Who leads Project Juniper Kite?",
    expectedAny: ["Mira Chen"],
  },
  {
    id: "project-deadline",
    prompt: "When is Project Juniper Kite due?",
    expectedAny: ["November 14, 2026", "November 14 2026", "2026-11-14"],
  },
  {
    id: "project-multi-hop",
    prompt: "Who leads Project Juniper Kite, and when is it due?",
    expectedAny: ["Mira Chen"],
    expectedAll: ["Mira Chen", "November", "14", "2026"],
  },
  {
    id: "favorite-tea",
    prompt: "What is my favorite tea?",
    expectedAny: ["masala chai"],
  },
  {
    id: "allergy",
    prompt: "Which nut am I allergic to?",
    expectedAny: ["pistachios"],
  },
  {
    id: "book-recommendation",
    prompt: "Which literary science-fiction recommendation did I save?",
    expectedAny: ["The Left Hand of Darkness"],
  },
  {
    id: "marathon-city",
    prompt: "Which city am I targeting for the marathon?",
    expectedAny: ["Berlin"],
  },
  {
    id: "gateway-nickname",
    prompt: "What is the production gateway server's nickname?",
    expectedAny: ["cedar-gateway"],
  },
  {
    id: "invoice-number",
    prompt: "What is the unpaid contractor invoice number?",
    expectedAny: ["48271"],
  },
  {
    id: "cross-topic-pair",
    prompt: "Which tomato ripened first, and where is the Kyoto booking?",
    expectedAny: ["Sungold"],
    expectedAll: ["Sungold", "Kumo Ryokan"],
  },
  {
    id: "routine-pair",
    prompt:
      "What day is the recurring project review, and how often do database backups run?",
    expectedAny: ["Thursday"],
    expectedAll: ["Thursday", "six hours"],
  },
  {
    id: "temporal-order",
    prompt: "Which did I record first, Amber Lark 3100 or Indigo Wren 7700?",
    expectedAny: ["Amber Lark 3100"],
  },
] as const;

function setPlantedMessage(
  corpus: GeneratedMessageCorpus,
  plant: PlantedMessage,
): string | undefined {
  const messages = corpus.conversations[plant.conversation]?.messages;
  if (!messages) return `missing planted conversation ${plant.conversation}`;
  const index =
    plant.message < 0 ? messages.length + plant.message : plant.message;
  const target = messages[index];
  if (target?.role !== "user") {
    return `planted message ${plant.conversation}:${index} was not a user message`;
  }
  target.text = plant.text;
  return undefined;
}

async function seedQuestionCorpus(
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
  for (const plant of PLANTED_MESSAGES) {
    const failure = setPlantedMessage(corpus, plant);
    if (failure) return failure;
  }
  const summary = await seedMessageCorpus(prepared, corpus, {
    ownerEntityId: asUUID(ctx.primaryUserId),
  });
  return summary.messagesCreated === MESSAGE_COUNT
    ? undefined
    : `expected ${MESSAGE_COUNT} planted messages, created ${summary.messagesCreated}`;
}

function validateQuestionEvidence(ctx: ScenarioContext): string | undefined {
  const messageTurns = ctx.turns ?? [];
  if (messageTurns.length !== QUESTIONS.length) {
    return `expected ${QUESTIONS.length} live question turns, saw ${messageTurns.length}`;
  }
  for (const [index, turn] of messageTurns.entries()) {
    if (!turn.responseText?.trim()) {
      return `${QUESTIONS[index]?.id ?? index} returned no response`;
    }
  }
  return undefined;
}

const questionTurns: ScenarioDefinition["turns"] = QUESTIONS.map(
  (question) => ({
    kind: "message",
    name: question.id,
    room: "main",
    text: question.prompt,
    responseIncludesAny: [...question.expectedAny],
    responseIncludesAll: question.expectedAll
      ? [...question.expectedAll]
      : undefined,
  }),
);

export default scenario({
  id: "live-planted-conversation-memory-questions",
  lane: "live-only",
  title: "Twenty recall questions over one planted conversation corpus",
  domain: "scenario-runner",
  tags: ["live", "memory", "long-horizon", "multi-question", "scale"],
  isolation: "per-scenario",
  now: "2026-08-25T12:00:00.000Z",
  rooms: [
    {
      id: "main",
      source: "chat",
      channelType: "DM",
      title: "Fresh multi-question recall room",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "plant multi-question runtime conversation corpus",
      apply: seedQuestionCorpus,
    },
  ],
  turns: questionTurns,
  finalChecks: [
    {
      type: "custom",
      name: "every natural recall question returned a response",
      predicate: validateQuestionEvidence,
    },
  ],
});

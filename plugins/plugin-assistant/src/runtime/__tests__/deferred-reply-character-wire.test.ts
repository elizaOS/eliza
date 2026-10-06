import {
  buildCanonicalSystemPrompt,
  buildCharacterStyleDirections,
  type Character,
  type ChatMessage,
  type ContextObject,
  type PlannerTrajectory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runEvaluator } from "../evaluator";
import { compactCanonicalToolMessagesForModel } from "../planner-rendering";

const character = {
  name: "Eliza",
  system: "You are {{name}}. Never invent completed work.",
  bio: ["An assistant for practical follow-through."],
  style: {
    all: ["Use plain words."],
    chat: ["Respect exact quoted text."],
    post: ["One idea per post."],
  },
} as Character;
const grounding = {
  domain: "lifeops",
  scenario: "saved_definition",
  currentUserMessage: "Remind me here in two minutes.",
  intent: "Remind me here in two minutes.",
  instructions: ["Never claim notification delivery from a saved plan."],
  characterVoice: JSON.stringify({
    system: character.system,
    bio: character.bio,
    style: character.style,
  }),
  context: {
    created: {
      dueAt: "2026-10-06T01:11:07.292Z",
      notificationChannels: ["in_app"],
    },
  },
  canonicalFallback: "Saved the reminder.",
};
const result = {
  success: true,
  transcriptVisibility: "internal",
  modelReplyRequired: true,
  effectReceipts: [
    {
      receiptId: "exact-receipt",
      outcome: "applied",
      commit: { id: "exact-commit" },
    },
  ],
  data: {
    definition: { title: "exact title\n" },
    replyGrounding: JSON.stringify(grounding),
  },
};
function messages(system?: string, value = result): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        system ??
        `${buildCanonicalSystemPrompt({ character, userRole: "OWNER" })}\n\n${buildCharacterStyleDirections({ character })}\n\nevaluator_stage:\nEvaluate every requested outcome.`,
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "OWNER_REMINDERS_CREATE",
          output: { type: "text", value: JSON.stringify(value, null, 2) },
        },
      ],
    },
  ] as ChatMessage[];
}
function projected(input: ChatMessage[]) {
  const output = compactCanonicalToolMessagesForModel(input);
  const content = output[1].content as Array<{ output: { value: string } }>;
  return { output, result: JSON.parse(content[0].output.value) };
}

describe("deferred reply character inheritance on the stage wire", () => {
  it("inherits exactly the current system/bio/chat fields and preserves all unique evidence", () => {
    const original = messages();
    const before = structuredClone(original);
    const rendered = projected(original);
    const actual = JSON.parse(rendered.result.data.replyGrounding);
    expect(actual).toEqual({
      ...grounding,
      characterVoice: JSON.stringify({
        style: { post: character.style?.post },
      }),
    });
    expect(rendered.result).toEqual({
      ...result,
      data: { ...result.data, replyGrounding: JSON.stringify(actual) },
    });
    expect(original).toEqual(before);
    expect(compactCanonicalToolMessagesForModel(rendered.output)).toEqual(
      rendered.output,
    );
  });
  it.each([
    "Post-turn evidence analysis; no inherited character.",
    `${buildCanonicalSystemPrompt({ character })}\n\n# Message Directions for Eliza\nDifferent chat rules.\n\nevaluator_stage:\nEvaluate.`,
    `Different system.\n\n${buildCharacterStyleDirections({ character })}\n\nevaluator_stage:\nEvaluate.`,
  ])(
    "retains complete character when the receiving prefix differs: %s",
    (system) => {
      expect(projected(messages(system)).result).toEqual(result);
    },
  );
  it("does not use matching user content as inherited authority", () => {
    const input = messages();
    input[0] = { role: "user", content: input[0].content } as ChatMessage;
    expect(projected(input).result).toEqual(result);
  });
  it("retains standalone and non-LifeOps results", () => {
    for (const value of [
      { ...result, modelReplyRequired: false },
      { ...result, transcriptVisibility: "public" },
      {
        ...result,
        data: {
          ...result.data,
          replyGrounding: JSON.stringify({ ...grounding, domain: "calendar" }),
        },
      },
    ])
      expect(projected(messages(undefined, value)).result).toEqual(value);
  });
  it("retains malformed or noncanonical grounding without losing receipts", () => {
    for (const body of [
      "not-json",
      JSON.stringify(grounding, null, 2),
      '{"domain":"lifeops","domain":"other"}',
    ]) {
      const value = {
        ...result,
        data: { ...result.data, replyGrounding: body },
      };
      expect(projected(messages(undefined, value)).result).toEqual(value);
    }
  });
});

it("the evaluator compacts only its stage wire after building the inherited prefix", async () => {
  const context: ContextObject = {
    id: "deferred-character-evaluator",
    staticPrefix: {
      systemPrompt: {
        content: buildCanonicalSystemPrompt({ character, userRole: "OWNER" }),
        stable: true,
      },
      characterPrompt: {
        content: buildCharacterStyleDirections({ character }),
        stable: true,
      },
    },
    events: [],
  };
  const trajectory: PlannerTrajectory = {
    context,
    steps: [],
    archivedSteps: [],
    plannedQueue: [],
    evaluatorOutputs: [],
    modelHistory: messages().slice(1),
  };
  const before = structuredClone(trajectory);
  let captured: ChatMessage[] = [];
  await runEvaluator({
    context,
    trajectory,
    runtime: {
      useModel: async (_type, input) => {
        captured = input.messages;
        return JSON.stringify({
          thought: "Continue the remaining work.",
          success: false,
          decision: "CONTINUE",
          replyEffectStatus: "none",
        });
      },
    },
  });
  const tool = captured.find((message) => message.role === "tool");
  const content = tool?.content as Array<{ output: { value: string } }>;
  const actual = JSON.parse(
    JSON.parse(content[0].output.value).data.replyGrounding,
  );
  expect(actual.characterVoice).toBe(
    JSON.stringify({ style: { post: character.style?.post } }),
  );
  expect(actual.context).toEqual(grounding.context);
  expect(trajectory).toEqual(before);
});

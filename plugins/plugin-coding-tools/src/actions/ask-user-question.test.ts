import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

import { askUserQuestionAction } from "./ask-user-question.js";

function makeRuntime(): IAgentRuntime {
  return {
    getSetting: () => undefined,
  } as IAgentRuntime;
}

function makeMessage(roomId: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001" as UUID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    roomId: roomId as UUID,
    content: { text: "" },
  } as Memory;
}

async function invoke(params: Record<string, unknown>) {
  const runtime = makeRuntime();
  const message = makeMessage(`room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  return askUserQuestionAction.handler!(runtime, message, undefined, { parameters: params });
}

describe("askUserQuestionAction", () => {
  it("accepts a single question with three options", async () => {
    const result = await invoke({
      questions: [
        {
          header: "Pick a backend",
          question: "Which backend should we use?",
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "Mongo", description: "Document" },
            { label: "Sqlite", description: "Embedded" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.requiresUserInteraction).toBe(true);

    const questions = data?.questions as Array<Record<string, unknown>>;
    expect(questions).toHaveLength(1);
    expect(questions[0]!.header).toBe("Pick a backend");
    const opts = questions[0]!.options as Array<Record<string, unknown>>;
    expect(opts).toHaveLength(3);
    expect(opts[0]!.label).toBe("Postgres");

    expect(result.text).toContain("Pick a backend");
    expect(result.text).toContain("Postgres");
  });

  it("rejects an empty questions array", async () => {
    const result = await invoke({ questions: [] });
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/1-4/);
  });

  it("rejects more than four questions", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      header: `H${i}`,
      question: `Q${i}?`,
    }));
    const result = await invoke({ questions: five });
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/1-4/);
  });
});

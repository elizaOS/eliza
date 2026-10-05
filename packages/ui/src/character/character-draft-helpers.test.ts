import { describe, expect, it } from "vitest";
import { prepareDraftForSave } from "./character-draft-helpers";

describe("character message example persistence", () => {
  it("preserves each message's actions through speaker normalization and repeated text", () => {
    const saved = prepareDraftForSave({
      name: "Eliza",
      messageExamples: [
        {
          examples: [
            {
              name: "assistant",
              content: { text: "Hello Eliza", actions: ["FIRST"] },
            },
            {
              name: "assistant",
              content: { text: "Hello Eliza", actions: ["SECOND"] },
            },
          ],
        },
      ],
    });
    expect(saved.messageExamples).toEqual([
      {
        examples: [
          {
            name: "Eliza",
            content: { text: "Hello {{name}}", actions: ["FIRST"] },
          },
          {
            name: "Eliza",
            content: { text: "Hello {{name}}", actions: ["SECOND"] },
          },
        ],
      },
    ]);
  });
});

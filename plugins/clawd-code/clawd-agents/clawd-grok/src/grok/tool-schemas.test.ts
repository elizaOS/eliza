import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolSetToBatchTools } from "./tool-schemas";

describe("toolSetToBatchTools", () => {
  it("converts AI SDK tools into batch function tools", async () => {
    const tools = {
      greet: tool({
        description: "Say hello",
        inputSchema: z.object({
          name: z.string().describe("Who to greet"),
        }),
        execute: async () => ({ success: true }),
      }),
    };

    const batchTools = await toolSetToBatchTools(tools);
    expect(batchTools).toHaveLength(1);
    expect(batchTools[0]).toMatchObject({
      type: "function",
      function: {
        name: "greet",
        description: "Say hello",
      },
    });
    expect(batchTools[0]?.function.parameters).toMatchObject({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Who to greet",
        },
      },
      required: ["name"],
    });
  });
});

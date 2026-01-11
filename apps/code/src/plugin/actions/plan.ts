import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";

/**
 * PLAN action
 *
 * Generates a concrete, step-by-step plan for implementing a feature/change.
 * Uses a reasoning model to prioritize planning quality.
 */
export const planAction: Action = {
  name: "PLAN",
  similes: ["PLAN_TASK", "MAKE_PLAN", "DESIGN", "ARCHITECT"],
  description: `Create a detailed implementation plan with steps, files, and risk analysis without making changes.

USE THIS ACTION WHEN:
- User says "plan", "design", "architect", or "break down"
- User asks for an "approach" or "steps" to implement something
- User wants to think through a feature before implementing
- User wants to understand scope and risks before coding

DO NOT USE WHEN:
- User wants to actually implement the feature (use CREATE_TASK or WRITE_FILE)
- User wants general advice or explanation (use ASK)
- User wants to understand existing code (use EXPLAIN)
- User is ready to start coding immediately

BEHAVIOR:
- Uses reasoning model for high-quality planning
- Produces structured output: Plan steps, Expected files, Risks/edge cases
- Does NOT write any code or modify files
- Keeps plans concise (4-8 steps)

OUTPUT FORMAT:
## Plan
1. Step one...
2. Step two...

## Files (expected)
- file1.ts
- file2.ts

## Risks / edge cases
- Risk one...`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("plan") ||
      text.includes("break down") ||
      text.includes("steps") ||
      text.includes("approach") ||
      text.includes("design")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const request = message.content.text ?? "";

    const prompt = [
      "You are an expert software engineer helping a user plan work before implementation.",
      "",
      "Return a concise, actionable plan in this exact format:",
      "",
      "## Plan",
      "1. ...",
      "2. ...",
      "",
      "## Files (expected)",
      "- ...",
      "",
      "## Risks / edge cases",
      "- ...",
      "",
      "Constraints:",
      "- Keep it to 4-8 plan steps.",
      "- Name likely files/areas, but don't pretend you've read the repo if you haven't.",
      "- No code blocks.",
      "",
      "User request:",
      request,
    ].join("\n");

    try {
      // Prefer reasoning model if available, fall back to TEXT_LARGE
      const modelType = runtime.getModel(ModelType.TEXT_REASONING_LARGE)
        ? ModelType.TEXT_REASONING_LARGE
        : ModelType.TEXT_LARGE;

      const result = await runtime.useModel(modelType, {
        prompt,
        maxTokens: 1200,
        temperature: 0.2,
      });

      const planText =
        typeof result === "string" ? result.trim() : String(result).trim();
      await callback?.({ text: planText });
      return { success: true, text: planText };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`PLAN error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "plan how to add OAuth login to this app" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll propose a concrete plan first.",
          actions: ["PLAN"],
        },
      },
    ],
  ],
};

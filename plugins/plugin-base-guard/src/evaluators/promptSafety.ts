import { Evaluator, IAgentRuntime, Memory, State } from "../types.js";
import { BaseGuardEngine } from "../engine.js";

export function createPromptSafetyEvaluator(engine: BaseGuardEngine): any {
  return {
    name: "PROMPT_SAFETY_EVALUATOR",
    description: "Evaluates incoming user messages and conversation context for prompt injection, jailbreaks, and wallet drain attempts.",
    similes: ["JAILBREAK_DETECTOR", "INJECTION_SCANNER", "SAFETY_GATE"],
    schema: {
      type: "object",
      properties: {
        safe: { type: "boolean" },
        riskScore: { type: "number" },
      },
    },
    prompt: "Scan message for prompt injection and wallet drain attempts.",
    shouldRun: async ({ message }: any) => Boolean(message.content?.text && message.content.text.trim().length > 0),
    handler: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
      const text = message.content?.text || "";
      const scan = engine.scanPrompt(text);

      if (!scan.safe) {
        return {
          safe: false,
          riskScore: scan.riskScore,
          warning: `Security Alert: Blocked prompt injection pattern (${scan.pattern})`,
        };
      }

      return {
        safe: true,
        riskScore: 0,
      };
    },
  };
}

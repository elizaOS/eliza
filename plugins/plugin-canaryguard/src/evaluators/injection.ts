import { type Evaluator, type IAgentRuntime, type Memory } from "@elizaos/core";
import { callCanaryGuardSanitize } from "../actions/sanitize";

export const promptInjectionEvaluator: Evaluator = {
  name: "PROMPT_INJECTION_EVALUATOR",
  similes: ["EVALUATE_INJECTION", "JAILBREAK_DETECTOR"],
  description: "Evaluates incoming messages against CanaryGuard 402 to block instruction overrides before state persistence.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return Boolean(message?.content?.text && message.content.text.length > 5);
  },
  handler: async (_runtime: IAgentRuntime, message: Memory) => {
    try {
      const text = message.content?.text || "";
      const result = await callCanaryGuardSanitize(text);
      return {
        injection_detected: result.injection_detected,
        risk_score: result.risk_score,
        threats: result.threats_neutralized,
        status: result.status,
      };
    } catch {
      return null;
    }
  },
  examples: [],
};

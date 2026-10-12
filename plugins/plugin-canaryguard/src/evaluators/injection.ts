import { type Evaluator, type IAgentRuntime, type Memory } from "@elizaos/core";
import { sanitizeLocally } from "../engine/rules";
import { CanaryGuardState } from "../engine/state";
import { resolveConfig } from "../actions/sanitize";

export const promptInjectionEvaluator: Evaluator = {
  name: "PROMPT_INJECTION_EVALUATOR",
  similes: ["EVALUATE_INJECTION", "JAILBREAK_DETECTOR"],
  description: "Evaluates incoming messages in-memory via local deterministic rules to flag instruction overrides and wallet drain attempts.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return Boolean(message?.content?.text && message.content.text.trim().length > 0);
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const text = message.content?.text || "";
      const config = resolveConfig(runtime);
      // Evaluator ALWAYS runs in-memory through the local engine — ZERO network calls
      const result = sanitizeLocally(text, config.strictMode);
      CanaryGuardState.recordScan(result);
      return {
        injection_detected: result.injection_detected,
        risk_score: result.risk_score,
        threats: result.threats_neutralized,
        status: result.status,
      };
    } catch (err) {
      CanaryGuardState.recordError(err);
      return null;
    }
  },
  examples: [],
};

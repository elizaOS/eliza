/**
 * Training Data Validator
 *
 * Validates that training data contains real LLM calls.
 * No synthetic pattern detection needed - we simply don't generate synthetic data.
 */

/**
 * LLM Call structure in trajectory steps
 */
interface LLMCall {
  systemPrompt?: string;
  system_prompt?: string;
  userPrompt?: string;
  user_prompt?: string;
  response?: string;
}

/**
 * Step structure for trajectory validation
 */
interface TrajectoryStep {
  llmCalls?: LLMCall[];
  llm_calls?: LLMCall[];
}

/**
 * Validate that trajectory steps contain real LLM calls.
 *
 * Training data MUST have actual LLM calls with real prompts and responses.
 *
 * @returns Object with validation result and details
 */
export function validateLLMCalls(steps: TrajectoryStep[]): {
  valid: boolean;
  totalSteps: number;
  stepsWithLLM: number;
  totalLLMCalls: number;
  issues: string[];
} {
  const issues: string[] = [];
  let stepsWithLLM = 0;
  let totalLLMCalls = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const llmCalls = step?.llmCalls ?? step?.llm_calls ?? [];

    if (llmCalls.length === 0) {
      continue;
    }

    stepsWithLLM++;

    for (let j = 0; j < llmCalls.length; j++) {
      const call = llmCalls[j];
      if (!call) continue;
      totalLLMCalls++;

      // Validate LLM call has actual content
      const systemPrompt = call.systemPrompt ?? call.system_prompt ?? "";
      const userPrompt = call.userPrompt ?? call.user_prompt ?? "";
      const response = call.response ?? "";

      if (systemPrompt.length < 10) {
        issues.push(`Step ${i}, call ${j}: Missing or empty system prompt`);
      }

      if (userPrompt.length < 10) {
        issues.push(`Step ${i}, call ${j}: Missing or empty user prompt`);
      }

      if (response.length < 5) {
        issues.push(`Step ${i}, call ${j}: Missing or empty response`);
      }
    }
  }

  // At least 3 steps should have LLM calls for valid training data
  if (stepsWithLLM < 3) {
    issues.push(
      `Only ${stepsWithLLM}/${steps.length} steps have LLM calls (minimum: 3)`,
    );
  }

  return {
    valid: issues.length === 0,
    totalSteps: steps.length,
    stepsWithLLM,
    totalLLMCalls,
    issues,
  };
}

/**
 * Assert that trajectory steps contain real LLM calls.
 * Throws an error if validation fails.
 */
export function assertHasLLMCalls(
  steps: TrajectoryStep[],
  trajectoryId: string,
): void {
  const validation = validateLLMCalls(steps);

  if (!validation.valid) {
    throw new Error(
      `Trajectory ${trajectoryId} failed LLM validation: ${validation.issues.join("; ")}. ` +
        "Training data must contain real LLM calls.",
    );
  }
}

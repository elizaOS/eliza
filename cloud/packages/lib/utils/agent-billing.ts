/**
 * Agent Billing Utilities
 *
 * Provides pre-execution credit checks and post-execution billing
 * for agent operations. Ensures agents don't run operations they
 * can't afford.
 */

import { calculateCost, getProviderFromModel } from "@/lib/pricing";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { creditsService } from "@/lib/services/credits";
import { organizationsService } from "@/lib/services/organizations";
import { logger } from "@/lib/utils/logger";

// ============================================================================
// TYPES
// ============================================================================

export interface BillingContext {
  // Who to bill
  agentId?: string; // If set, uses agent budget
  organizationId: string; // Fallback to org credits

  // Cost information
  estimatedCost: number;
  description: string;

  // Operation metadata
  operationType?: string;
  model?: string;
}

export interface PreBillResult {
  canProceed: boolean;
  source: "agent_budget" | "org_credits";
  availableBalance: number;
  estimatedCost: number;
  error?: string;
}

export interface PostBillResult {
  success: boolean;
  actualCost: number;
  newBalance: number;
  transactionId?: string;
  error?: string;
}

// Estimated costs for common operations (USD)
// These should align with pricing-constants.ts where applicable
export const ESTIMATED_COSTS = {
  // LLM operations (per request average)
  chat_small: 0.001, // gpt-5-mini, Claude Haiku (~500 input + 200 output tokens)
  chat_large: 0.01, // GPT-4o, Claude Sonnet
  chat_xlarge: 0.03, // GPT-4o with long context

  // Media operations (aligned with current provider-backed defaults)
  image_gen: 0.0468, // Gemini 2.5 Flash Image default output
  video_gen: 3.84, // Veo 3 default 8s request with audio
  voice_tts: 0.06, // ElevenLabs Flash/Turbo per 1K characters
  voice_stt: 0.0044, // ElevenLabs STT per minute

  // External operations
  mcp_call: 0.01, // Average MCP tool call
  a2a_call: 0.02, // A2A chat call
};

// ============================================================================
// PRE-EXECUTION CHECK
// ============================================================================

/**
 * Check if agent/org can afford an operation BEFORE executing it.
 * This is a non-locking check - actual deduction happens post-execution.
 */
export async function preCheckBilling(context: BillingContext): Promise<PreBillResult> {
  const { agentId, organizationId, estimatedCost } = context;

  // If agent has a budget, check that first
  if (agentId) {
    const budgetCheck = await agentBudgetService.checkBudget(agentId, estimatedCost);

    if (budgetCheck.canProceed) {
      return {
        canProceed: true,
        source: "agent_budget",
        availableBalance: budgetCheck.availableBudget,
        estimatedCost,
      };
    }

    // Agent budget insufficient/paused - check if should fall back to org
    if (budgetCheck.isPaused) {
      return {
        canProceed: false,
        source: "agent_budget",
        availableBalance: budgetCheck.availableBudget,
        estimatedCost,
        error: budgetCheck.reason || "Agent budget is paused",
      };
    }

    // If agent has no budget at all (not initialized), fall through to org credits
    if (budgetCheck.availableBudget === 0) {
      logger.debug("[AgentBilling] No agent budget, falling back to org credits", {
        agentId,
        organizationId,
      });
    } else {
      // Agent has budget but insufficient
      return {
        canProceed: false,
        source: "agent_budget",
        availableBalance: budgetCheck.availableBudget,
        estimatedCost,
        error: budgetCheck.reason || "Insufficient agent budget",
      };
    }
  }

  // Check organization credits
  const org = await organizationsService.getById(organizationId);
  if (!org) {
    return {
      canProceed: false,
      source: "org_credits",
      availableBalance: 0,
      estimatedCost,
      error: "Organization not found",
    };
  }

  const balance = Number(org.credit_balance);

  if (balance < estimatedCost) {
    return {
      canProceed: false,
      source: "org_credits",
      availableBalance: balance,
      estimatedCost,
      error: `Insufficient credits. Available: $${balance.toFixed(2)}, Required: $${estimatedCost.toFixed(4)}`,
    };
  }

  return {
    canProceed: true,
    source: "org_credits",
    availableBalance: balance,
    estimatedCost,
  };
}

// ============================================================================
// POST-EXECUTION BILLING
// ============================================================================

/**
 * Bill for an operation AFTER successful execution.
 * Uses the pre-check result to determine billing source.
 */
export async function postBillOperation(
  context: BillingContext,
  preResult: PreBillResult,
  actualCost?: number,
): Promise<PostBillResult> {
  const cost = actualCost ?? context.estimatedCost;

  if (preResult.source === "agent_budget" && context.agentId) {
    // Deduct from agent budget
    const result = await agentBudgetService.deductBudget({
      agentId: context.agentId,
      amount: cost,
      description: context.description,
      operationType: context.operationType,
      model: context.model,
    });

    if (!result.success) {
      logger.error("[AgentBilling] Agent budget deduction failed", {
        agentId: context.agentId,
        cost,
        error: result.error,
      });
    }

    return {
      success: result.success,
      actualCost: cost,
      newBalance: result.newBalance,
      transactionId: result.transactionId,
      error: result.error,
    };
  }

  // Deduct from org credits
  const result = await creditsService.deductCredits({
    organizationId: context.organizationId,
    amount: cost,
    description: context.description,
    metadata: {
      agent_id: context.agentId,
      operation_type: context.operationType,
      model: context.model,
    },
  });

  return {
    success: result.success,
    actualCost: cost,
    newBalance: result.newBalance,
    transactionId: result.transaction?.id,
    error: result.success ? undefined : "Credit deduction failed",
  };
}

// ============================================================================
// INTEGRATED BILLING WRAPPER
// ============================================================================

/**
 * Execute an operation with integrated billing.
 * Pre-checks, executes, and bills in one flow.
 */
export async function executeWithBilling<T>(params: {
  context: BillingContext;
  execute: () => Promise<T>;
  calculateActualCost?: (result: T) => Promise<number>;
}): Promise<{
  success: boolean;
  result?: T;
  billing: PostBillResult | PreBillResult;
  error?: string;
}> {
  const { context, execute, calculateActualCost } = params;

  // Pre-check
  const preCheck = await preCheckBilling(context);
  if (!preCheck.canProceed) {
    return {
      success: false,
      billing: preCheck,
      error: preCheck.error,
    };
  }

  // Execute
  let result: T;
  try {
    result = await execute();
  } catch (error) {
    logger.error("[AgentBilling] Operation failed", {
      context,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      billing: preCheck,
      error: error instanceof Error ? error.message : "Operation failed",
    };
  }

  // Calculate actual cost if provided
  const actualCost = calculateActualCost
    ? await calculateActualCost(result)
    : context.estimatedCost;

  // Bill
  const billing = await postBillOperation(context, preCheck, actualCost);

  return {
    success: billing.success,
    result,
    billing,
    error: billing.error,
  };
}

// ============================================================================
// COST ESTIMATION HELPERS
// ============================================================================

/**
 * Estimate cost for an LLM request
 */
export async function estimateLLMCost(
  model: string,
  messages: Array<{ role: string; content: string }>,
): Promise<number> {
  // Quick estimate based on message content
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 4);

  // Assume 2x output tokens vs input
  const estimatedOutputTokens = Math.min(estimatedTokens, 1000);

  const provider = getProviderFromModel(model);
  const { totalCost } = await calculateCost(
    model,
    provider,
    estimatedTokens,
    estimatedOutputTokens,
  );

  return Math.max(totalCost, 0.001); // Minimum $0.001
}

/**
 * Get estimated cost for a known operation type
 */
export function getEstimatedCost(operation: keyof typeof ESTIMATED_COSTS): number {
  return ESTIMATED_COSTS[operation];
}

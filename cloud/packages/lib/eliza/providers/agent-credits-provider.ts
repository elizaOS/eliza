/**
 * Agent Credits Provider
 *
 * Provides credit/budget awareness to agents during runtime.
 * Allows agents to check their available budget before expensive operations.
 *
 * Usage in agent prompts:
 * - {{credits.available}} - Available budget
 * - {{credits.dailyRemaining}} - Remaining daily budget
 * - {{credits.isPaused}} - Whether budget is paused
 * - {{credits.canAfford}} - Whether agent can afford typical operations
 */

import type { IAgentRuntime, Provider } from "@elizaos/core";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { organizationsService } from "@/lib/services/organizations";
import { logger } from "@/lib/utils/logger";

// ============================================================================
// TYPES
// ============================================================================

export interface AgentCreditsState {
  // Budget status
  hasBudget: boolean;
  allocated: number;
  spent: number;
  available: number;

  // Daily limits
  dailyLimit: number | null;
  dailySpent: number;
  dailyRemaining: number | null;

  // Status
  isPaused: boolean;
  pauseReason: string | null;

  // Affordability checks
  canAffordChat: boolean; // ~$0.01
  canAffordImage: boolean; // ~$0.05
  canAffordVideo: boolean; // ~$0.50
  canAffordMcp: boolean; // ~$0.02 average

  // Summary text for prompt
  statusText: string;
  budgetWarning: string | null;
}

// Estimated costs for different operations
const OPERATION_COSTS = {
  chat: 0.01,
  image: 0.05,
  video: 0.5,
  mcp: 0.02,
  a2a: 0.03,
};

// ============================================================================
// PROVIDER
// ============================================================================

export const agentCreditsProvider: Provider = {
  name: "AGENT_CREDITS",
  description: "Provides agent budget and credit information",
  contexts: ["finance", "payments", "wallet", "crypto"],
  contextGate: { anyOf: ["finance", "payments", "wallet", "crypto"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, _message) => {
    const agentId = runtime.agentId;
    try {
      // Try to get budget for this agent
      const budget = await agentBudgetService.getBudget(agentId);

      let creditsState: AgentCreditsState;

      if (!budget) {
        // No dedicated budget - agent uses org credits directly
        // Try to get org credits from runtime settings
        const orgId = runtime.character.settings?.organizationId as string | undefined;

        let orgBalance = 0;
        if (orgId) {
          const org = await organizationsService.getById(orgId);
          orgBalance = org ? Number(org.credit_balance) : 0;
        }

        creditsState = {
          hasBudget: false,
          allocated: orgBalance,
          spent: 0,
          available: orgBalance,
          dailyLimit: null,
          dailySpent: 0,
          dailyRemaining: null,
          isPaused: false,
          pauseReason: null,
          canAffordChat: orgBalance >= OPERATION_COSTS.chat,
          canAffordImage: orgBalance >= OPERATION_COSTS.image,
          canAffordVideo: orgBalance >= OPERATION_COSTS.video,
          canAffordMcp: orgBalance >= OPERATION_COSTS.mcp,
          statusText: `Using organization credits: $${orgBalance.toFixed(2)} available`,
          budgetWarning: orgBalance < 1 ? "⚠️ Low organization credits - consider topping up" : null,
        };
      } else {
        const allocated = Number(budget.allocated_budget);
        const spent = Number(budget.spent_budget);
        const available = allocated - spent;
        const dailyLimit = budget.daily_limit ? Number(budget.daily_limit) : null;
        const dailySpent = Number(budget.daily_spent);
        const dailyRemaining = dailyLimit ? dailyLimit - dailySpent : null;

        // Determine effective available (minimum of budget and daily remaining)
        const effectiveAvailable =
          dailyRemaining !== null ? Math.min(available, dailyRemaining) : available;

        creditsState = {
          hasBudget: true,
          allocated,
          spent,
          available,
          dailyLimit,
          dailySpent,
          dailyRemaining,
          isPaused: budget.is_paused,
          pauseReason: budget.pause_reason,
          canAffordChat: !budget.is_paused && effectiveAvailable >= OPERATION_COSTS.chat,
          canAffordImage: !budget.is_paused && effectiveAvailable >= OPERATION_COSTS.image,
          canAffordVideo: !budget.is_paused && effectiveAvailable >= OPERATION_COSTS.video,
          canAffordMcp: !budget.is_paused && effectiveAvailable >= OPERATION_COSTS.mcp,
          statusText: budget.is_paused
            ? `⚠️ Budget paused: ${budget.pause_reason || "Unknown reason"}`
            : `Budget: $${available.toFixed(2)} available (${dailyRemaining !== null ? `$${dailyRemaining.toFixed(2)} daily remaining` : "no daily limit"})`,
          budgetWarning: getBudgetWarning(available, dailyRemaining, budget.is_paused),
        };
      }

      logger.debug("[AgentCredits] Provider state", {
        agentId,
        hasBudget: creditsState.hasBudget,
        available: creditsState.available,
        isPaused: creditsState.isPaused,
      });

      return {
        data: { credits: creditsState },
        values: { credits: creditsState },
      };
    } catch (error) {
      logger.warn("[AgentCredits] Provider fallback", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        data: {
          credits: {
            hasBudget: false,
            allocated: 0,
            spent: 0,
            available: 0,
            dailyLimit: null,
            dailySpent: 0,
            dailyRemaining: null,
            isPaused: false,
            pauseReason: null,
            canAffordChat: false,
            canAffordImage: false,
            canAffordVideo: false,
            canAffordMcp: false,
            statusText: "Budget information unavailable",
            budgetWarning: null,
          },
        },
        values: {},
      };
    }
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getBudgetWarning(
  available: number,
  dailyRemaining: number | null,
  isPaused: boolean,
): string | null {
  if (isPaused) {
    return "⚠️ Your budget is paused. Contact your administrator to resume operations.";
  }

  if (available <= 0) {
    return "🚫 No budget available. You cannot perform operations requiring credits.";
  }

  if (available < 0.5) {
    return `⚠️ Very low budget: $${available.toFixed(2)}. Some operations may fail.`;
  }

  if (dailyRemaining !== null && dailyRemaining < 0.1) {
    return `⚠️ Daily limit nearly reached: $${dailyRemaining.toFixed(2)} remaining today.`;
  }

  return null;
}

// ============================================================================
// PROMPT TEMPLATE HELPER
// ============================================================================

/**
 * Generate credit awareness text for agent's system prompt
 */
export function getCreditsPromptSection(credits: AgentCreditsState): string {
  if (!credits.hasBudget && credits.available > 10) {
    // Plenty of org credits, no need to mention
    return "";
  }

  const lines: string[] = [];

  lines.push("## Your Budget Status");
  lines.push("");
  lines.push(credits.statusText);

  if (credits.budgetWarning) {
    lines.push("");
    lines.push(credits.budgetWarning);
  }

  lines.push("");
  lines.push("### Operation Costs (approximate)");
  lines.push(`- Chat response: ~$${OPERATION_COSTS.chat.toFixed(2)}`);
  lines.push(`- Image generation: ~$${OPERATION_COSTS.image.toFixed(2)}`);
  lines.push(`- Video generation: ~$${OPERATION_COSTS.video.toFixed(2)}`);
  lines.push(`- MCP tool call: ~$${OPERATION_COSTS.mcp.toFixed(2)}`);

  if (!credits.canAffordImage) {
    lines.push("");
    lines.push("⚠️ You cannot afford image generation. If asked, politely decline.");
  }

  if (!credits.canAffordVideo) {
    lines.push("");
    lines.push("⚠️ You cannot afford video generation. If asked, politely decline.");
  }

  if (credits.isPaused) {
    lines.push("");
    lines.push("🛑 Your budget is PAUSED. You can only provide basic text responses.");
    lines.push("Politely inform users that you're temporarily limited.");
  }

  return lines.join("\n");
}

// ============================================================================
// BUDGET CHECK HELPER
// ============================================================================

/**
 * Check if agent can afford an operation
 * Call this before expensive operations
 */
export async function canAgentAfford(
  agentId: string,
  operation: keyof typeof OPERATION_COSTS,
): Promise<{
  canAfford: boolean;
  available: number;
  required: number;
  reason?: string;
}> {
  const required = OPERATION_COSTS[operation];
  const check = await agentBudgetService.checkBudget(agentId, required);

  return {
    canAfford: check.canProceed,
    available: check.availableBudget,
    required,
    reason: check.reason,
  };
}

/**
 * Deduct from agent budget after operation
 * Call this after successful operations
 */
export async function deductAgentBudget(
  agentId: string,
  amount: number,
  operation: string,
  metadata?: Record<string, unknown>,
): Promise<{
  success: boolean;
  newBalance: number;
  error?: string;
}> {
  const result = await agentBudgetService.deductBudget({
    agentId,
    amount,
    description: `Agent operation: ${operation}`,
    operationType: operation,
    metadata,
  });

  return {
    success: result.success,
    newBalance: result.newBalance,
    error: result.error,
  };
}

export default agentCreditsProvider;

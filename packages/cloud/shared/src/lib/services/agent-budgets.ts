/**
 * Agent Budget Service
 *
 * Manages dedicated credit pools for autonomous agents.
 * Provides atomic budget operations with full audit trail.
 *
 * Key Features:
 * - Allocate budget from org credits
 * - Deduct for operations (with pre-check)
 * - Daily limits with auto-reset
 * - Auto-refill when below threshold
 * - Pause on depletion
 * - Low budget alerts
 */

import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/client";
import {
  type AgentBudget,
  type AgentBudgetTransaction,
  agentBudgets,
  agentBudgetTransactions,
} from "../../db/schemas/agent-budgets";
import { organizations } from "../../db/schemas/organizations";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { logger } from "../utils/logger";
import { type CreditReservation, creditsService, InsufficientCreditsError } from "./credits";
import { emailService } from "./email";

const DEFAULT_LOW_BUDGET_THRESHOLD = new Decimal(5);
const DEFAULT_AUTO_REFILL_THRESHOLD = new Decimal(10);

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

// ============================================================================
// TYPES
// ============================================================================

export interface BudgetCheckResult {
  canProceed: boolean;
  availableBudget: number;
  dailyRemaining: number | null;
  isPaused: boolean;
  reason?: string;
}

export interface DeductBudgetParams {
  agentId: string;
  amount: number;
  description: string;
  operationType?: string;
  model?: string;
  tokensUsed?: number;
  metadata?: Record<string, unknown>;
}

export interface DeductBudgetResult {
  success: boolean;
  newBalance: number;
  dailySpent: number;
  transactionId?: string;
  error?: string;
  shouldPause?: boolean;
}

export interface AllocateBudgetParams {
  agentId: string;
  amount: number;
  fromOrgCredits?: boolean; // Deduct from org credits when allocating
  description?: string;
}

export interface RefillBudgetParams {
  agentId: string;
  amount: number;
  description?: string;
}

export interface UpdateBudgetSettingsParams {
  dailyLimit?: number | null;
  autoRefillEnabled?: boolean;
  autoRefillAmount?: number | null;
  autoRefillThreshold?: number | null;
  pauseOnDepleted?: boolean;
  lowBudgetThreshold?: number | null;
}

type BudgetNumericField =
  | "allocated_budget"
  | "spent_budget"
  | "daily_limit"
  | "daily_spent"
  | "auto_refill_amount"
  | "auto_refill_threshold"
  | "low_budget_threshold";

class InvalidAgentBudgetNumericValueError extends Error {
  constructor(
    readonly field: BudgetNumericField,
    readonly value: unknown,
  ) {
    super(`Invalid numeric budget value for ${field}`);
    this.name = "InvalidAgentBudgetNumericValueError";
  }
}

// ============================================================================
// SERVICE
// ============================================================================

class AgentBudgetService {
  /**
   * Get or create budget for an agent
   */
  async getOrCreateBudget(agentId: string): Promise<AgentBudget | null> {
    // Get agent to find owner org
    const agent = await dbRead.query.userCharacters.findFirst({
      where: eq(userCharacters.id, agentId),
    });

    if (!agent) {
      return null;
    }

    // Check for existing budget
    let [budget] = await dbRead
      .select()
      .from(agentBudgets)
      .where(eq(agentBudgets.agent_id, agentId));

    if (!budget) {
      // Create new budget with defaults
      [budget] = await dbWrite
        .insert(agentBudgets)
        .values({
          agent_id: agentId,
          owner_org_id: agent.organization_id,
          allocated_budget: "0.0000",
          spent_budget: "0.0000",
          daily_spent: "0.0000",
          daily_reset_at: this.getNextDailyReset(),
        })
        .returning();

      logger.info("[AgentBudgets] Created budget for agent", {
        agentId,
        orgId: agent.organization_id,
      });
    }

    return budget;
  }

  /**
   * Get budget by agent ID
   */
  async getBudget(agentId: string): Promise<AgentBudget | null> {
    const [budget] = await dbRead
      .select()
      .from(agentBudgets)
      .where(eq(agentBudgets.agent_id, agentId));

    return budget || null;
  }

  /**
   * Check if agent has sufficient budget for an operation
   * This is a pre-flight check - does not lock or modify anything
   */
  async checkBudget(agentId: string, estimatedCost: number): Promise<BudgetCheckResult> {
    if (!isPositiveFiniteNumber(estimatedCost)) {
      return {
        canProceed: false,
        availableBudget: 0,
        dailyRemaining: null,
        isPaused: false,
        reason: "Estimated cost must be a positive finite number",
      };
    }

    const budget = await this.getOrCreateBudget(agentId);

    if (!budget) {
      return {
        canProceed: false,
        availableBudget: 0,
        dailyRemaining: null,
        isPaused: false,
        reason: "Agent not found",
      };
    }

    const parsed = this.parseBudgetForRead(budget);
    if (!parsed.valid) {
      return this.invalidBudgetCheckResult(agentId, parsed.error);
    }

    const { allocated, spent, dailyLimit } = parsed;
    const dailyState = await this.maybeResetDailySpent(budget, parsed.dailySpent);
    const available = allocated.minus(spent);
    const dailyRemaining = dailyLimit ? dailyLimit.minus(dailyState.dailySpent).toNumber() : null;

    // Check if paused
    if (budget.is_paused) {
      return {
        canProceed: false,
        availableBudget: available.toNumber(),
        dailyRemaining,
        isPaused: true,
        reason: budget.pause_reason || "Agent budget is paused",
      };
    }

    // Check daily limit if set
    if (dailyRemaining !== null) {
      if (dailyRemaining < estimatedCost) {
        return {
          canProceed: false,
          availableBudget: available.toNumber(),
          dailyRemaining,
          isPaused: false,
          reason: `Daily limit reached. Remaining today: $${dailyRemaining.toFixed(4)}`,
        };
      }
    }

    // Check available budget
    if (available.lt(estimatedCost)) {
      return {
        canProceed: false,
        availableBudget: available.toNumber(),
        dailyRemaining,
        isPaused: false,
        reason: `Insufficient budget. Available: $${available.toFixed(4)}, Required: $${estimatedCost.toFixed(4)}`,
      };
    }

    return {
      canProceed: true,
      availableBudget: available.toNumber(),
      dailyRemaining,
      isPaused: false,
    };
  }

  /**
   * Deduct from agent's budget atomically
   */
  async deductBudget(params: DeductBudgetParams): Promise<DeductBudgetResult> {
    const { agentId, amount, description, operationType, model, tokensUsed, metadata } = params;

    if (!isPositiveFiniteNumber(amount)) {
      return {
        success: false,
        newBalance: 0,
        dailySpent: 0,
        error: "Amount must be positive",
      };
    }

    return await dbWrite.transaction(async (tx) => {
      // Lock the budget row
      const [budget] = await tx
        .select()
        .from(agentBudgets)
        .where(eq(agentBudgets.agent_id, agentId))
        .for("update");

      if (!budget) {
        return {
          success: false,
          newBalance: 0,
          dailySpent: 0,
          error: "Budget not found for agent",
        };
      }

      const parsed = this.parseBudgetForRead(budget);
      if (!parsed.valid) {
        return this.invalidDeductResult(agentId, parsed.error);
      }

      const { allocated, spent, dailyLimit } = parsed;

      if (budget.is_paused) {
        return {
          success: false,
          newBalance: allocated.minus(spent).toNumber(),
          dailySpent: parsed.dailySpent.toNumber(),
          error: budget.pause_reason || "Agent budget is paused",
        };
      }

      // Reset daily if needed
      const now = new Date();
      let dailySpent = parsed.dailySpent;
      let dailyResetAt = budget.daily_reset_at;

      if (dailyResetAt && now >= dailyResetAt) {
        dailySpent = new Decimal(0);
        dailyResetAt = this.getNextDailyReset();
      }

      // Calculate current state
      const available = allocated.minus(spent);

      // Check daily limit
      if (dailyLimit) {
        const dailyRemaining = dailyLimit.minus(dailySpent);

        if (dailyRemaining.lt(amount)) {
          return {
            success: false,
            newBalance: available.toNumber(),
            dailySpent: dailySpent.toNumber(),
            error: `Daily limit exceeded. Remaining: $${dailyRemaining.toFixed(4)}`,
          };
        }
      }

      // Check available budget
      if (available.lt(amount)) {
        // Should we pause?
        if (budget.pause_on_depleted) {
          await tx
            .update(agentBudgets)
            .set({
              is_paused: true,
              pause_reason: "Budget depleted",
              paused_at: now,
              updated_at: now,
            })
            .where(eq(agentBudgets.id, budget.id));

          return {
            success: false,
            newBalance: available.toNumber(),
            dailySpent: dailySpent.toNumber(),
            error: "Insufficient budget - agent paused",
            shouldPause: true,
          };
        }

        return {
          success: false,
          newBalance: available.toNumber(),
          dailySpent: dailySpent.toNumber(),
          error: `Insufficient budget. Available: $${available.toFixed(4)}`,
        };
      }

      // Perform deduction
      const newSpent = spent.plus(amount);
      const newDailySpent = dailySpent.plus(amount);
      const newBalance = allocated.minus(newSpent);
      let lowThreshold: Decimal;
      let autoRefillThreshold: Decimal | null;

      try {
        lowThreshold = this.parseOptionalBudgetDecimal(
          "low_budget_threshold",
          budget.low_budget_threshold,
          DEFAULT_LOW_BUDGET_THRESHOLD,
        );
        autoRefillThreshold = this.parseOptionalBudgetDecimal(
          "auto_refill_threshold",
          budget.auto_refill_threshold,
          null,
        );
      } catch (error) {
        if (error instanceof InvalidAgentBudgetNumericValueError) {
          return this.invalidDeductResult(agentId, error);
        }
        throw error;
      }

      await tx
        .update(agentBudgets)
        .set({
          spent_budget: newSpent.toFixed(4),
          daily_spent: newDailySpent.toFixed(4),
          daily_reset_at: dailyResetAt,
          updated_at: now,
        })
        .where(eq(agentBudgets.id, budget.id));

      // Record transaction
      const [txn] = await tx
        .insert(agentBudgetTransactions)
        .values({
          budget_id: budget.id,
          agent_id: agentId,
          type: "deduction",
          amount: new Decimal(-amount).toFixed(4),
          balance_after: newBalance.toFixed(4),
          daily_spent_after: newDailySpent.toFixed(4),
          description,
          operation_type: operationType,
          model,
          tokens_used: tokensUsed ? String(tokensUsed) : undefined,
          source_type: "usage",
          metadata: metadata || {},
        })
        .returning();

      logger.info("[AgentBudgets] Budget deducted", {
        agentId,
        amount,
        newBalance: newBalance.toNumber(),
        dailySpent: newDailySpent.toNumber(),
        operationType,
      });

      // Check if we should trigger auto-refill (fire-and-forget, logged on failure)
      if (
        budget.auto_refill_enabled &&
        autoRefillThreshold &&
        newBalance.lte(autoRefillThreshold)
      ) {
        // Trigger auto-refill asynchronously - failure is non-critical
        this.triggerAutoRefill(agentId).catch((err) =>
          logger.error("[AgentBudgets] Auto-refill failed", {
            agentId,
            error: String(err),
          }),
        );
      }

      // Check for low budget alert (fire-and-forget, logged on failure)
      if (newBalance.lte(lowThreshold) && !budget.low_budget_alert_sent) {
        this.sendLowBudgetAlert(agentId, newBalance.toNumber()).catch((err) =>
          logger.error("[AgentBudgets] Low budget alert failed", {
            agentId,
            error: String(err),
          }),
        );
      }

      return {
        success: true,
        newBalance: newBalance.toNumber(),
        dailySpent: newDailySpent.toNumber(),
        transactionId: txn.id,
      };
    });
  }

  /**
   * Allocate credits to agent's budget
   */
  async allocateBudget(params: AllocateBudgetParams): Promise<{
    success: boolean;
    newBalance: number;
    error?: string;
  }> {
    const { agentId, amount, fromOrgCredits = true, description } = params;

    if (!isPositiveFiniteNumber(amount)) {
      return {
        success: false,
        newBalance: 0,
        error: "Amount must be positive",
      };
    }

    const budget = await this.getOrCreateBudget(agentId);
    if (!budget) {
      return { success: false, newBalance: 0, error: "Agent not found" };
    }

    // Reserve credits BEFORE the transaction to prevent TOCTOU issues
    let reservation: CreditReservation | null = null;
    if (fromOrgCredits) {
      try {
        reservation = await creditsService.reserve({
          organizationId: budget.owner_org_id,
          amount,
          description: description || `Budget allocation to agent ${agentId}`,
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          const parsed = this.parseBudgetForRead(budget);
          if (!parsed.valid) {
            logger.error("[AgentBudgets] Invalid budget numeric value", {
              agentId,
              field: parsed.error.field,
              value: parsed.error.value,
            });
            return {
              success: false,
              newBalance: 0,
              error: "Invalid budget data",
            };
          }
          const currentBalance = parsed.allocated.minus(parsed.spent).toNumber();
          return {
            success: false,
            newBalance: currentBalance,
            error: "Insufficient organization credits",
          };
        }
        throw error;
      }
    }

    try {
      const result = await dbWrite.transaction(async (tx) => {
        // Lock budget row
        const [lockedBudget] = await tx
          .select()
          .from(agentBudgets)
          .where(eq(agentBudgets.id, budget.id))
          .for("update");

        // Add to allocated budget
        const parsed = this.parseBudgetForRead(lockedBudget);
        if (!parsed.valid) {
          logger.error("[AgentBudgets] Invalid budget numeric value", {
            agentId,
            field: parsed.error.field,
            value: parsed.error.value,
          });
          return {
            success: false,
            newBalance: 0,
            error: "Invalid budget data",
          };
        }

        const currentAllocated = parsed.allocated;
        const newAllocated = currentAllocated.plus(amount);
        const newBalance = newAllocated.minus(parsed.spent);

        // Update budget
        await tx
          .update(agentBudgets)
          .set({
            allocated_budget: newAllocated.toFixed(4),
            // Unpause if was paused due to depletion
            is_paused:
              lockedBudget.is_paused && lockedBudget.pause_reason === "Budget depleted"
                ? false
                : lockedBudget.is_paused,
            pause_reason:
              lockedBudget.pause_reason === "Budget depleted" ? null : lockedBudget.pause_reason,
            low_budget_alert_sent: false, // Reset alert flag
            updated_at: new Date(),
          })
          .where(eq(agentBudgets.id, lockedBudget.id));

        // Record transaction
        await tx.insert(agentBudgetTransactions).values({
          budget_id: lockedBudget.id,
          agent_id: agentId,
          type: "allocation",
          amount: new Decimal(amount).toFixed(4),
          balance_after: newBalance.toFixed(4),
          description: description || "Budget allocation",
          source_type: fromOrgCredits ? "org_transfer" : "manual",
          metadata: { from_org_credits: fromOrgCredits },
        });

        logger.info("[AgentBudgets] Budget allocated", {
          agentId,
          amount,
          newBalance: newBalance.toNumber(),
          fromOrgCredits,
        });

        return {
          success: true,
          newBalance: newBalance.toNumber(),
        };
      });

      // Reconcile only after a successful allocation; a non-throwing transaction
      // can still reject corrupt locked budget state and must refund the reserve.
      if (reservation) {
        await reservation.reconcile(result.success ? amount : 0);
      }

      return result;
    } catch (error) {
      // Refund on failure
      if (reservation) {
        await reservation.reconcile(0);
      }
      throw error;
    }
  }

  /**
   * Refill budget from org credits
   */
  async refillBudget(params: RefillBudgetParams): Promise<{
    success: boolean;
    newBalance: number;
    error?: string;
  }> {
    return this.allocateBudget({
      agentId: params.agentId,
      amount: params.amount,
      fromOrgCredits: true,
      description: params.description || "Budget refill",
    });
  }

  /**
   * Trigger auto-refill for an agent
   * Returns true if refill was performed, false if skipped
   */
  async triggerAutoRefill(agentId: string): Promise<boolean> {
    const budget = await this.getBudget(agentId);
    if (!budget || !budget.auto_refill_enabled) {
      return false;
    }

    // Cooldown check - don't refill more than once per hour
    if (budget.last_refill_at) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (budget.last_refill_at > hourAgo) {
        logger.debug("[AgentBudgets] Auto-refill skipped (cooldown)", {
          agentId,
        });
        return false;
      }
    }

    let refillAmount: Decimal | null;
    try {
      refillAmount = this.parseOptionalBudgetDecimal(
        "auto_refill_amount",
        budget.auto_refill_amount,
        null,
      );
    } catch (error) {
      if (error instanceof InvalidAgentBudgetNumericValueError) {
        logger.error("[AgentBudgets] Invalid auto-refill amount", {
          agentId,
          value: budget.auto_refill_amount,
        });
        return false;
      }
      throw error;
    }

    if (!refillAmount || refillAmount.lte(0)) {
      logger.error("[AgentBudgets] Invalid auto-refill amount", {
        agentId,
        value: budget.auto_refill_amount,
      });
      return false;
    }

    const result = await this.refillBudget({
      agentId,
      amount: refillAmount.toNumber(),
      description: "Auto-refill",
    });

    if (result.success) {
      await dbWrite
        .update(agentBudgets)
        .set({ last_refill_at: new Date(), updated_at: new Date() })
        .where(eq(agentBudgets.id, budget.id));

      logger.info("[AgentBudgets] Auto-refill completed", {
        agentId,
        amount: refillAmount.toNumber(),
        newBalance: result.newBalance,
      });
      return true;
    }

    logger.warn("[AgentBudgets] Auto-refill failed", {
      agentId,
      error: result.error,
    });
    return false;
  }

  /**
   * Pause an agent's budget
   */
  async pauseBudget(agentId: string, reason: string): Promise<void> {
    await dbWrite
      .update(agentBudgets)
      .set({
        is_paused: true,
        pause_reason: reason,
        paused_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(agentBudgets.agent_id, agentId));

    logger.info("[AgentBudgets] Budget paused", { agentId, reason });
  }

  /**
   * Resume an agent's budget
   */
  async resumeBudget(agentId: string): Promise<void> {
    await dbWrite
      .update(agentBudgets)
      .set({
        is_paused: false,
        pause_reason: null,
        paused_at: null,
        updated_at: new Date(),
      })
      .where(eq(agentBudgets.agent_id, agentId));

    logger.info("[AgentBudgets] Budget resumed", { agentId });
  }

  /**
   * Update budget settings
   */
  async updateSettings(
    agentId: string,
    settings: UpdateBudgetSettingsParams,
  ): Promise<{ success: boolean; error?: string }> {
    const budget = await this.getBudget(agentId);
    if (!budget) {
      return { success: false, error: "Budget not found" };
    }

    const updateData: Partial<AgentBudget> = {
      updated_at: new Date(),
    };

    try {
      if (settings.dailyLimit !== undefined) {
        updateData.daily_limit =
          settings.dailyLimit === null
            ? null
            : this.formatSettingAmount("daily_limit", settings.dailyLimit);
      }
      if (settings.autoRefillEnabled !== undefined) {
        updateData.auto_refill_enabled = settings.autoRefillEnabled;
      }
      if (settings.autoRefillAmount !== undefined) {
        updateData.auto_refill_amount =
          settings.autoRefillAmount === null
            ? null
            : this.formatSettingAmount("auto_refill_amount", settings.autoRefillAmount);
      }
      if (settings.autoRefillThreshold !== undefined) {
        updateData.auto_refill_threshold =
          settings.autoRefillThreshold === null
            ? null
            : this.formatSettingAmount("auto_refill_threshold", settings.autoRefillThreshold);
      }
      if (settings.pauseOnDepleted !== undefined) {
        updateData.pause_on_depleted = settings.pauseOnDepleted;
      }
      if (settings.lowBudgetThreshold !== undefined) {
        updateData.low_budget_threshold =
          settings.lowBudgetThreshold === null
            ? null
            : this.formatSettingAmount("low_budget_threshold", settings.lowBudgetThreshold);
      }
    } catch (error) {
      if (error instanceof InvalidAgentBudgetNumericValueError) {
        logger.error("[AgentBudgets] Invalid budget settings numeric value", {
          agentId,
          field: error.field,
          value: error.value,
        });
        return { success: false, error: "Invalid budget settings" };
      }
      throw error;
    }

    await dbWrite.update(agentBudgets).set(updateData).where(eq(agentBudgets.id, budget.id));

    logger.info("[AgentBudgets] Settings updated", { agentId, settings });

    return { success: true };
  }

  /**
   * Get transaction history for a budget
   */
  async getTransactions(agentId: string, limit = 50): Promise<AgentBudgetTransaction[]> {
    const budget = await this.getBudget(agentId);
    if (!budget) {
      return [];
    }

    return await dbRead.query.agentBudgetTransactions.findMany({
      where: eq(agentBudgetTransactions.budget_id, budget.id),
      orderBy: (t, { desc }) => desc(t.created_at),
      limit,
    });
  }

  /**
   * Get all budgets for an organization
   */
  async getOrgBudgets(orgId: string): Promise<AgentBudget[]> {
    return await dbRead.query.agentBudgets.findMany({
      where: eq(agentBudgets.owner_org_id, orgId),
    });
  }

  /**
   * Process all auto-refills (for cron job)
   *
   * Note: Errors are collected rather than thrown to allow batch processing
   * to continue. All errors are logged with full context.
   */
  async processAutoRefills(): Promise<{
    processed: number;
    errors: number;
    failedAgents: string[];
  }> {
    // Find all budgets that need refilling
    const budgetsToRefill = await dbRead
      .select()
      .from(agentBudgets)
      .where(and(eq(agentBudgets.auto_refill_enabled, true), eq(agentBudgets.is_paused, false)));

    let processed = 0;
    const failedAgents: string[] = [];

    for (const budget of budgetsToRefill) {
      const parsed = this.parseBudgetForRead(budget);
      if (!parsed.valid) {
        logger.error("[AgentBudgets] Invalid budget numeric value", {
          agentId: budget.agent_id,
          field: parsed.error.field,
          value: parsed.error.value,
        });
        failedAgents.push(budget.agent_id);
        continue;
      }

      const available = parsed.allocated.minus(parsed.spent);
      let threshold: Decimal;
      let refillAmount: Decimal | null;

      try {
        threshold = this.parseOptionalBudgetDecimal(
          "auto_refill_threshold",
          budget.auto_refill_threshold,
          DEFAULT_AUTO_REFILL_THRESHOLD,
        );
        refillAmount = this.parseOptionalBudgetDecimal(
          "auto_refill_amount",
          budget.auto_refill_amount,
          null,
        );
      } catch (error) {
        if (error instanceof InvalidAgentBudgetNumericValueError) {
          logger.error("[AgentBudgets] Invalid budget numeric value", {
            agentId: budget.agent_id,
            field: error.field,
            value: error.value,
          });
          failedAgents.push(budget.agent_id);
          continue;
        }
        throw error;
      }

      if (available.lte(threshold)) {
        if (!refillAmount || refillAmount.lte(0)) {
          logger.error("[AgentBudgets] Invalid auto-refill amount", {
            agentId: budget.agent_id,
            value: budget.auto_refill_amount,
          });
          failedAgents.push(budget.agent_id);
          continue;
        }

        // Let errors propagate but track them for batch reporting
        const result = await this.refillBudget({
          agentId: budget.agent_id,
          amount: refillAmount.toNumber(),
          description: "Auto-refill",
        });

        if (result.success) {
          await dbWrite
            .update(agentBudgets)
            .set({ last_refill_at: new Date(), updated_at: new Date() })
            .where(eq(agentBudgets.id, budget.id));
          processed++;
        } else {
          logger.error("[AgentBudgets] Auto-refill failed", {
            agentId: budget.agent_id,
            error: result.error,
          });
          failedAgents.push(budget.agent_id);
        }
      }
    }

    return { processed, errors: failedAgents.length, failedAgents };
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private getNextDailyReset(): Date {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow;
  }

  private parseBudgetForRead(budget: AgentBudget):
    | {
        valid: true;
        allocated: Decimal;
        spent: Decimal;
        dailyLimit: Decimal | null;
        dailySpent: Decimal;
      }
    | { valid: false; error: InvalidAgentBudgetNumericValueError } {
    try {
      return {
        valid: true,
        allocated: this.parseRequiredBudgetDecimal("allocated_budget", budget.allocated_budget),
        spent: this.parseRequiredBudgetDecimal("spent_budget", budget.spent_budget),
        dailyLimit: this.parseOptionalBudgetDecimal("daily_limit", budget.daily_limit, null),
        dailySpent: this.parseRequiredBudgetDecimal("daily_spent", budget.daily_spent),
      };
    } catch (error) {
      if (error instanceof InvalidAgentBudgetNumericValueError) {
        return { valid: false, error };
      }
      throw error;
    }
  }

  private parseRequiredBudgetDecimal(field: BudgetNumericField, value: unknown): Decimal {
    const parsed = this.parseBudgetDecimal(field, value);
    if (!parsed) {
      throw new InvalidAgentBudgetNumericValueError(field, value);
    }
    return parsed;
  }

  private parseOptionalBudgetDecimal<T extends Decimal | null>(
    field: BudgetNumericField,
    value: unknown,
    defaultValue: T,
  ): Decimal | T {
    const parsed = this.parseBudgetDecimal(field, value, { allowNull: true });
    return parsed ?? defaultValue;
  }

  private parseBudgetDecimal(
    field: BudgetNumericField,
    value: unknown,
    options: { allowNull?: boolean } = {},
  ): Decimal | null {
    if (value === null || value === undefined) {
      if (options.allowNull) {
        return null;
      }
      throw new InvalidAgentBudgetNumericValueError(field, value);
    }

    if (typeof value === "string" && value.trim() === "") {
      throw new InvalidAgentBudgetNumericValueError(field, value);
    }

    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new InvalidAgentBudgetNumericValueError(field, value);
    }

    try {
      const decimal = new Decimal(value as Decimal.Value);
      if (!decimal.isFinite() || decimal.isNegative()) {
        throw new InvalidAgentBudgetNumericValueError(field, value);
      }
      return decimal;
    } catch (error) {
      if (error instanceof InvalidAgentBudgetNumericValueError) {
        throw error;
      }
      throw new InvalidAgentBudgetNumericValueError(field, value);
    }
  }

  private formatSettingAmount(field: BudgetNumericField, value: number): string {
    return this.parseRequiredBudgetDecimal(field, value).toFixed(4);
  }

  private invalidBudgetCheckResult(
    agentId: string,
    error: InvalidAgentBudgetNumericValueError,
  ): BudgetCheckResult {
    logger.error("[AgentBudgets] Invalid budget numeric value", {
      agentId,
      field: error.field,
      value: error.value,
    });
    return {
      canProceed: false,
      availableBudget: 0,
      dailyRemaining: null,
      isPaused: false,
      reason: "Invalid budget data",
    };
  }

  private invalidDeductResult(
    agentId: string,
    error: InvalidAgentBudgetNumericValueError,
  ): DeductBudgetResult {
    logger.error("[AgentBudgets] Invalid budget numeric value", {
      agentId,
      field: error.field,
      value: error.value,
    });
    return {
      success: false,
      newBalance: 0,
      dailySpent: 0,
      error: "Invalid budget data",
    };
  }

  private async maybeResetDailySpent(
    budget: AgentBudget,
    dailySpent: Decimal,
  ): Promise<{ dailySpent: Decimal; dailyResetAt: Date | null }> {
    const now = new Date();
    if (budget.daily_reset_at && now >= budget.daily_reset_at) {
      const dailyResetAt = this.getNextDailyReset();
      await dbWrite
        .update(agentBudgets)
        .set({
          daily_spent: "0.0000",
          daily_reset_at: dailyResetAt,
          updated_at: now,
        })
        .where(eq(agentBudgets.id, budget.id));
      return { dailySpent: new Decimal(0), dailyResetAt };
    }
    return { dailySpent, dailyResetAt: budget.daily_reset_at };
  }

  private async sendLowBudgetAlert(agentId: string, balance: number): Promise<boolean> {
    // Mark alert as sent
    await dbWrite
      .update(agentBudgets)
      .set({ low_budget_alert_sent: true, updated_at: new Date() })
      .where(eq(agentBudgets.agent_id, agentId));

    // Get agent and organization info for email
    const [agentInfo] = await dbRead
      .select({
        agentName: userCharacters.name,
        organizationId: userCharacters.organization_id,
        ownerId: userCharacters.user_id,
      })
      .from(userCharacters)
      .where(eq(userCharacters.id, agentId))
      .limit(1);

    if (!agentInfo?.organizationId) {
      logger.warn("[AgentBudgets] Cannot send alert - no organization found", {
        agentId,
      });
      return false;
    }

    // Get billing email from organization or owner
    const [orgInfo] = await dbRead
      .select({
        billingEmail: organizations.billing_email,
        orgName: organizations.name,
      })
      .from(organizations)
      .where(eq(organizations.id, agentInfo.organizationId))
      .limit(1);

    let recipientEmail = orgInfo?.billingEmail;

    // Fallback to owner's email if no billing email
    if (!recipientEmail && agentInfo.ownerId) {
      const [ownerInfo] = await dbRead
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, agentInfo.ownerId))
        .limit(1);
      recipientEmail = ownerInfo?.email;
    }

    if (!recipientEmail) {
      logger.warn("[AgentBudgets] Cannot send alert - no email found", {
        agentId,
      });
      return false;
    }

    // Send email using low credits template (repurposed for agent budget)
    await emailService.sendLowCreditsEmail({
      email: recipientEmail,
      organizationName: orgInfo?.orgName ?? "Your Organization",
      currentBalance: balance,
      threshold: 5.0, // Standard low budget threshold
      billingUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing`,
    });

    logger.info("[AgentBudgets] Low budget alert sent", {
      agentId,
      agentName: agentInfo.agentName,
      balance,
      email: recipientEmail,
    });
    return true;
  }
}

// Export singleton
export const agentBudgetService = new AgentBudgetService();

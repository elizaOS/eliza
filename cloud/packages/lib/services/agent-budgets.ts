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
import { dbRead, dbWrite } from "@/db/client";
import {
  type AgentBudget,
  type AgentBudgetTransaction,
  agentBudgets,
  agentBudgetTransactions,
} from "@/db/schemas/agent-budgets";
import { organizations } from "@/db/schemas/organizations";
import { userCharacters } from "@/db/schemas/user-characters";
import { users } from "@/db/schemas/users";
import { logger } from "@/lib/utils/logger";
import { type CreditReservation, creditsService, InsufficientCreditsError } from "./credits";
import { emailService } from "./email";

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

    // Check if paused
    if (budget.is_paused) {
      return {
        canProceed: false,
        availableBudget: Number(budget.allocated_budget) - Number(budget.spent_budget),
        dailyRemaining: budget.daily_limit
          ? Number(budget.daily_limit) - Number(budget.daily_spent)
          : null,
        isPaused: true,
        reason: budget.pause_reason || "Agent budget is paused",
      };
    }

    // Reset daily spent if needed
    await this.maybeResetDailySpent(budget);

    // Calculate available budget
    const allocated = new Decimal(budget.allocated_budget);
    const spent = new Decimal(budget.spent_budget);
    const available = allocated.minus(spent);

    // Check daily limit if set
    let dailyRemaining: number | null = null;
    if (budget.daily_limit) {
      const dailyLimit = new Decimal(budget.daily_limit);
      const dailySpent = new Decimal(budget.daily_spent);
      dailyRemaining = dailyLimit.minus(dailySpent).toNumber();

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

    if (amount <= 0) {
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

      if (budget.is_paused) {
        return {
          success: false,
          newBalance: Number(budget.allocated_budget) - Number(budget.spent_budget),
          dailySpent: Number(budget.daily_spent),
          error: budget.pause_reason || "Agent budget is paused",
        };
      }

      // Reset daily if needed
      const now = new Date();
      let dailySpent = new Decimal(budget.daily_spent);
      let dailyResetAt = budget.daily_reset_at;

      if (dailyResetAt && now >= dailyResetAt) {
        dailySpent = new Decimal(0);
        dailyResetAt = this.getNextDailyReset();
      }

      // Calculate current state
      const allocated = new Decimal(budget.allocated_budget);
      const spent = new Decimal(budget.spent_budget);
      const available = allocated.minus(spent);

      // Check daily limit
      if (budget.daily_limit) {
        const dailyLimit = new Decimal(budget.daily_limit);
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
      const lowThreshold = budget.low_budget_threshold
        ? new Decimal(budget.low_budget_threshold)
        : new Decimal(5);

      if (
        budget.auto_refill_enabled &&
        budget.auto_refill_threshold &&
        newBalance.lte(budget.auto_refill_threshold)
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

    if (amount <= 0) {
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
          const currentBalance = Number(budget.allocated_budget) - Number(budget.spent_budget);
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
        const currentAllocated = new Decimal(lockedBudget.allocated_budget);
        const newAllocated = currentAllocated.plus(amount);
        const newBalance = newAllocated.minus(lockedBudget.spent_budget);

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

      // Reconcile the reservation after successful transaction
      if (reservation) {
        await reservation.reconcile(amount);
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
    if (!budget || !budget.auto_refill_enabled || !budget.auto_refill_amount) {
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

    const refillAmount = Number(budget.auto_refill_amount);

    const result = await this.refillBudget({
      agentId,
      amount: refillAmount,
      description: "Auto-refill",
    });

    if (result.success) {
      await dbWrite
        .update(agentBudgets)
        .set({ last_refill_at: new Date(), updated_at: new Date() })
        .where(eq(agentBudgets.id, budget.id));

      logger.info("[AgentBudgets] Auto-refill completed", {
        agentId,
        amount: refillAmount,
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

    if (settings.dailyLimit !== undefined) {
      updateData.daily_limit = settings.dailyLimit ? String(settings.dailyLimit) : null;
    }
    if (settings.autoRefillEnabled !== undefined) {
      updateData.auto_refill_enabled = settings.autoRefillEnabled;
    }
    if (settings.autoRefillAmount !== undefined) {
      updateData.auto_refill_amount = settings.autoRefillAmount
        ? String(settings.autoRefillAmount)
        : null;
    }
    if (settings.autoRefillThreshold !== undefined) {
      updateData.auto_refill_threshold = settings.autoRefillThreshold
        ? String(settings.autoRefillThreshold)
        : null;
    }
    if (settings.pauseOnDepleted !== undefined) {
      updateData.pause_on_depleted = settings.pauseOnDepleted;
    }
    if (settings.lowBudgetThreshold !== undefined) {
      updateData.low_budget_threshold = settings.lowBudgetThreshold
        ? String(settings.lowBudgetThreshold)
        : null;
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
      const available = new Decimal(budget.allocated_budget).minus(budget.spent_budget);
      const threshold = budget.auto_refill_threshold
        ? new Decimal(budget.auto_refill_threshold)
        : new Decimal(10);

      if (available.lte(threshold)) {
        // Let errors propagate but track them for batch reporting
        const result = await this.refillBudget({
          agentId: budget.agent_id,
          amount: Number(budget.auto_refill_amount),
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

  private async maybeResetDailySpent(budget: AgentBudget): Promise<void> {
    const now = new Date();
    if (budget.daily_reset_at && now >= budget.daily_reset_at) {
      await dbWrite
        .update(agentBudgets)
        .set({
          daily_spent: "0.0000",
          daily_reset_at: this.getNextDailyReset(),
          updated_at: now,
        })
        .where(eq(agentBudgets.id, budget.id));
    }
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

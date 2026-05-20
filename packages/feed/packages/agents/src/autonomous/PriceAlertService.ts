/**
 * Price Alert Service
 *
 * Monitors perpetual market prices against user-configured thresholds
 * and delivers alerts via team chat or group chat.
 *
 * Called during each autonomous agent tick (~3 minutes). Checks are
 * non-LLM (pure DB lookups) so they add negligible latency to the tick.
 *
 * Alert delivery:
 * - team_chat: Uses executeDirectMessage with the team chat's chatId
 * - group: Uses executeDirectMessage with the configured group chatId
 *
 * Note: Agent→owner DMs are blocked by executeDirectMessage (DirectExecutors.ts:1392).
 * Owner alerts use team chat instead.
 */

import {
  db,
  eq,
  perpMarketSnapshots,
  sql,
  userAgentConfigs,
  users,
} from "@feed/db";
import type { PriceAlert } from "@feed/db/schema";
// Import TeamChatService to resolve the team chat for owner alerts
import { teamChatService } from "../services/TeamChatService";
import { logger } from "../shared/logger";
import { executeDirectMessage } from "./DirectExecutors";

/**
 * Price Alert Service
 *
 * Checks configured price alerts for an agent and sends notifications
 * when thresholds are breached.
 */
export class PriceAlertService {
  /**
   * Check all price alerts for an agent during autonomous tick.
   * Returns the number of alerts triggered and sent.
   */
  async checkAlerts(agentUserId: string): Promise<number> {
    const [config] = await db
      .select({ priceAlerts: userAgentConfigs.priceAlerts })
      .from(userAgentConfigs)
      .where(eq(userAgentConfigs.userId, agentUserId))
      .limit(1);

    const alerts = (config?.priceAlerts ?? []) as PriceAlert[];
    const enabledAlerts = alerts.filter((a) => a.enabled);

    if (enabledAlerts.length === 0) return 0;

    let alertsSent = 0;

    for (const alert of enabledAlerts) {
      // Check cooldown
      if (alert.lastTriggeredAt) {
        const cooldownMs = (alert.cooldownMinutes || 15) * 60 * 1000;
        const elapsed = Date.now() - new Date(alert.lastTriggeredAt).getTime();
        if (elapsed < cooldownMs) {
          continue;
        }
      }

      // Get current price from perpetual market snapshots
      const currentPrice = await this.getCurrentPrice(alert.tokenSymbol);
      if (currentPrice === null) continue;

      // Check threshold
      const triggered =
        (alert.condition === "below" && currentPrice < alert.threshold) ||
        (alert.condition === "above" && currentPrice > alert.threshold);

      if (!triggered) continue;

      // Resolve delivery target
      const message = this.formatAlertMessage(alert, currentPrice);
      let deliveryChatId: string | undefined;

      if (alert.deliveryChannel === "group" && alert.deliveryChatId) {
        deliveryChatId = alert.deliveryChatId;
      } else {
        // Default: deliver to team chat (agent→owner standard channel)
        deliveryChatId = await this.getOwnerTeamChatId(agentUserId);
      }

      if (!deliveryChatId) {
        logger.warn(
          `[PriceAlert] No delivery channel found for alert ${alert.id}`,
          { agentUserId, tokenSymbol: alert.tokenSymbol },
          "PriceAlertService",
        );
        continue;
      }

      // Send alert
      const result = await executeDirectMessage({
        agentUserId,
        chatId: deliveryChatId,
        content: message,
      });

      if (result.success) {
        alertsSent++;
        logger.info(
          `[PriceAlert] Alert triggered: ${alert.tokenSymbol} ${alert.condition} ${alert.threshold} (current: ${currentPrice})`,
          { agentUserId, alertId: alert.id, chatId: deliveryChatId },
          "PriceAlertService",
        );

        // Update lastTriggeredAt in the config
        await this.updateAlertTimestamp(agentUserId, alert.id);
      } else {
        logger.warn(
          `[PriceAlert] Failed to send alert: ${result.error}`,
          { agentUserId, alertId: alert.id },
          "PriceAlertService",
        );
      }
    }

    return alertsSent;
  }

  /**
   * Format a price alert message for delivery.
   */
  private formatAlertMessage(alert: PriceAlert, currentPrice: number): string {
    const direction =
      alert.condition === "below" ? "dropped below" : "rose above";
    const emoji = alert.condition === "below" ? "📉" : "📈";
    const diff = Math.abs(currentPrice - alert.threshold);
    const pctDiff = ((diff / alert.threshold) * 100).toFixed(1);

    return `${emoji} Price Alert: ${alert.tokenSymbol} has ${direction} $${alert.threshold}. Current price: $${currentPrice.toFixed(2)} (${pctDiff}% ${alert.condition === "below" ? "below" : "above"} threshold).`;
  }

  /**
   * Get current market price for a token symbol from perpMarketSnapshots.
   * Returns markPrice if available, otherwise currentPrice.
   */
  private async getCurrentPrice(tokenSymbol: string): Promise<number | null> {
    const [snapshot] = await db
      .select({
        currentPrice: perpMarketSnapshots.currentPrice,
        markPrice: perpMarketSnapshots.markPrice,
      })
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, tokenSymbol))
      .limit(1);

    return snapshot?.markPrice ?? snapshot?.currentPrice ?? null;
  }

  /**
   * Get the team chat ID for an agent's owner.
   * Agents communicate with owners via the team chat (Agents group).
   */
  private async getOwnerTeamChatId(
    agentUserId: string,
  ): Promise<string | undefined> {
    // Find the agent's owner
    const [agent] = await db
      .select({ managedBy: users.managedBy })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (!agent?.managedBy) return undefined;

    // Get the owner's team chat
    const teamChat = await teamChatService.getTeamChat(agent.managedBy);
    return teamChat?.chatId;
  }

  /**
   * Update the lastTriggeredAt timestamp for a specific alert.
   * Uses an atomic SQL JSONB update to avoid read-modify-write race conditions.
   */
  private async updateAlertTimestamp(
    agentUserId: string,
    alertId: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    // Atomic JSON update: iterate the array and set lastTriggeredAt on the matching alert.
    // This avoids the read-modify-write race of SELECT → map → UPDATE.
    // Column is json (not jsonb), so cast to jsonb for processing, then back to json.
    await db
      .update(userAgentConfigs)
      .set({
        priceAlerts: sql`(
          SELECT COALESCE(
            jsonb_agg(
              CASE
                WHEN elem->>'id' = ${alertId}
                THEN elem || jsonb_build_object('lastTriggeredAt', ${now}::text)
                ELSE elem
              END
            ),
            '[]'::jsonb
          )::json
          FROM jsonb_array_elements(
            COALESCE(${userAgentConfigs.priceAlerts}::jsonb, '[]'::jsonb)
          ) AS elem
        )`,
        updatedAt: new Date(),
      })
      .where(eq(userAgentConfigs.userId, agentUserId));
  }
}

export const priceAlertService = new PriceAlertService();

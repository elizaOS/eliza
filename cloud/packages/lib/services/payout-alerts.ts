/**
 * Payout Alerting Service
 *
 * Sends alerts for critical payout events to Slack/PagerDuty.
 *
 * ALERT TYPES:
 * - CRITICAL: System paused, security breach suspected
 * - HIGH: Hot wallet low, repeated failures
 * - MEDIUM: High volume, unusual patterns
 * - LOW: Informational
 */

import { MONITORING } from "@/lib/config/redemption-security";
import { logger } from "@/lib/utils/logger";

// ============================================================================
// TYPES
// ============================================================================

type AlertSeverity = "critical" | "high" | "medium" | "low";

interface AlertPayload {
  severity: AlertSeverity;
  title: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp?: Date;
}

interface SlackMessage {
  text: string;
  attachments: Array<{
    color: string;
    title: string;
    text: string;
    fields: Array<{ title: string; value: string; short: boolean }>;
    ts: number;
  }>;
}

// ============================================================================
// SEVERITY COLORS
// ============================================================================

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  critical: "#FF0000", // Red
  high: "#FF8C00", // Orange
  medium: "#FFD700", // Gold
  low: "#00CED1", // Cyan
};

const SEVERITY_EMOJIS: Record<AlertSeverity, string> = {
  critical: "🚨",
  high: "⚠️",
  medium: "📊",
  low: "ℹ️",
};

// ============================================================================
// PAYOUT ALERTS SERVICE
// ============================================================================

export class PayoutAlertsService {
  private slackWebhookUrl: string | undefined;
  private pagerDutyKey: string | undefined;

  constructor() {
    this.slackWebhookUrl = process.env[MONITORING.SLACK_WEBHOOK_ENV];
    this.pagerDutyKey = process.env[MONITORING.PAGERDUTY_KEY_ENV];

    if (!this.slackWebhookUrl && !this.pagerDutyKey && process.env.NODE_ENV === "production") {
      logger.warn("[PayoutAlerts] No alert channels configured");
    }
  }

  /**
   * Send an alert to configured channels
   */
  async sendAlert(payload: AlertPayload): Promise<void> {
    const { severity, title, message, details, timestamp = new Date() } = payload;

    logger.info(`[PayoutAlerts] ${severity.toUpperCase()}: ${title}`, {
      message,
      details,
    });

    // Send to Slack
    if (this.slackWebhookUrl) {
      await this.sendSlackAlert(severity, title, message, details, timestamp);
    }

    // Send to PagerDuty for critical/high severity
    if (this.pagerDutyKey && (severity === "critical" || severity === "high")) {
      await this.sendPagerDutyAlert(severity, title, message, details);
    }
  }

  /**
   * Send Slack webhook message
   */
  private async sendSlackAlert(
    severity: AlertSeverity,
    title: string,
    message: string,
    details?: Record<string, unknown>,
    timestamp?: Date,
  ): Promise<void> {
    const emoji = SEVERITY_EMOJIS[severity];
    const color = SEVERITY_COLORS[severity];

    const slackPayload: SlackMessage = {
      text: `${emoji} *[elizaOS Payout]* ${title}`,
      attachments: [
        {
          color,
          title: `${severity.toUpperCase()}: ${title}`,
          text: message,
          fields: details
            ? Object.entries(details).map(([key, value]) => ({
                title: key,
                value: String(value),
                short: true,
              }))
            : [],
          ts: Math.floor((timestamp ?? new Date()).getTime() / 1000),
        },
      ],
    };

    try {
      const response = await fetch(this.slackWebhookUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackPayload),
      });

      if (!response.ok) {
        logger.error("[PayoutAlerts] Slack webhook failed", {
          status: response.status,
        });
      }
    } catch (error) {
      logger.error("[PayoutAlerts] Failed to send Slack alert", { error });
    }
  }

  /**
   * Send PagerDuty alert
   */
  private async sendPagerDutyAlert(
    severity: AlertSeverity,
    title: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const pagerDutyPayload = {
      routing_key: this.pagerDutyKey,
      event_action: "trigger",
      dedup_key: `payout-${title.replace(/\s/g, "-").toLowerCase()}-${Date.now()}`,
      payload: {
        summary: `[elizaOS Payout] ${title}`,
        severity: severity === "critical" ? "critical" : "error",
        source: "eliza-cloud-payout",
        custom_details: {
          message,
          ...details,
        },
      },
    };

    try {
      const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pagerDutyPayload),
      });

      if (!response.ok) {
        logger.error("[PayoutAlerts] PagerDuty alert failed", {
          status: response.status,
        });
      }
    } catch (error) {
      logger.error("[PayoutAlerts] Failed to send PagerDuty alert", { error });
    }
  }

  // ========================================
  // PREDEFINED ALERT METHODS
  // ========================================

  /**
   * Alert: Hot wallet balance is low
   */
  async alertLowBalance(network: string, balance: number, threshold: number): Promise<void> {
    await this.sendAlert({
      severity: "high",
      title: "Low Hot Wallet Balance",
      message: `The ${network} hot wallet balance is below the threshold.`,
      details: {
        network,
        currentBalance: `${balance.toFixed(4)} tokens`,
        threshold: `${threshold} tokens`,
        percentRemaining: `${((balance / threshold) * 100).toFixed(1)}%`,
      },
    });
  }

  /**
   * Alert: Velocity limit triggered (possible attack)
   */
  async alertVelocityLimit(redemptionCount: number, windowMinutes: number): Promise<void> {
    await this.sendAlert({
      severity: "critical",
      title: "Velocity Limit Triggered",
      message: `Too many redemptions in short period - possible coordinated attack. System paused.`,
      details: {
        redemptionCount,
        timeWindow: `${windowMinutes} minutes`,
        action: "System automatically paused",
      },
    });
  }

  /**
   * Alert: Price volatility circuit breaker
   */
  async alertVolatilityBreaker(
    network: string,
    volatility: number,
    threshold: number,
  ): Promise<void> {
    await this.sendAlert({
      severity: "high",
      title: "Price Volatility Circuit Breaker",
      message: `${network} price volatility exceeded threshold. Redemptions paused.`,
      details: {
        network,
        volatility: `${(volatility * 100).toFixed(2)}%`,
        threshold: `${(threshold * 100).toFixed(2)}%`,
        action: "Redemptions paused until volatility decreases",
      },
    });
  }

  /**
   * Alert: Consecutive payout failures
   */
  async alertConsecutiveFailures(failureCount: number, lastError: string): Promise<void> {
    await this.sendAlert({
      severity: "high",
      title: "Consecutive Payout Failures",
      message: `${failureCount} consecutive payout failures detected. Manual intervention may be required.`,
      details: {
        failureCount,
        lastError,
        action: "Review failed redemptions in admin panel",
      },
    });
  }

  /**
   * Alert: High redemption volume
   */
  async alertHighVolume(
    currentVolumeUsd: number,
    limitUsd: number,
    period: "hourly" | "daily",
  ): Promise<void> {
    await this.sendAlert({
      severity: "medium",
      title: `High ${period.charAt(0).toUpperCase() + period.slice(1)} Redemption Volume`,
      message: `Redemption volume approaching ${period} limit.`,
      details: {
        currentVolume: `$${currentVolumeUsd.toFixed(2)}`,
        limit: `$${limitUsd.toFixed(2)}`,
        percentUsed: `${((currentVolumeUsd / limitUsd) * 100).toFixed(1)}%`,
      },
    });
  }

  /**
   * Alert: Large redemption for review
   */
  async alertLargeRedemption(
    redemptionId: string,
    userId: string,
    usdValue: number,
    network: string,
  ): Promise<void> {
    await this.sendAlert({
      severity: "medium",
      title: "Large Redemption Pending Review",
      message: `A large redemption request requires admin approval.`,
      details: {
        redemptionId: redemptionId.slice(0, 8) + "...",
        userId: userId.slice(0, 8) + "...",
        usdValue: `$${usdValue.toFixed(2)}`,
        network,
        action: "Review in admin panel",
      },
    });
  }

  /**
   * Alert: Emergency pause activated
   */
  async alertEmergencyPause(reason: string, activatedBy?: string): Promise<void> {
    await this.sendAlert({
      severity: "critical",
      title: "Emergency Pause Activated",
      message: `All redemptions have been paused.`,
      details: {
        reason,
        activatedBy: activatedBy || "System",
        action: "Manual intervention required to resume",
      },
    });
  }

  /**
   * Alert: Successful large payout
   */
  async alertPayoutSuccess(
    redemptionId: string,
    usdValue: number,
    network: string,
    txHash: string,
  ): Promise<void> {
    if (usdValue >= 100) {
      // Only alert for significant payouts
      await this.sendAlert({
        severity: "low",
        title: "Large Payout Completed",
        message: `Successfully processed a large redemption.`,
        details: {
          redemptionId: redemptionId.slice(0, 8) + "...",
          usdValue: `$${usdValue.toFixed(2)}`,
          network,
          txHash: txHash.slice(0, 10) + "...",
        },
      });
    }
  }
}

// Export singleton
export const payoutAlertsService = new PayoutAlertsService();

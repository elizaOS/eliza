/**
 * Delivers security-critical payout alerts to the configured Slack webhook and
 * the fixed PagerDuty Events API without allowing an alert hop to pin payout
 * processing or redirect its payload to an unintended endpoint.
 */

import { MONITORING } from "../config/redemption-security";
import { safeFetch } from "../security/safe-fetch";
import { logger } from "../utils/logger";

const ALERT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ALERT_REQUEST_BODY_BYTES = 64 * 1024;
const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type AlertTransport = (url: string, init?: RequestInit) => Promise<Response>;

function assertAllowedAlertEndpoint(input: string | URL): URL {
  const url = new URL(input.toString());
  const isSlackWebhook =
    url.hostname === "hooks.slack.com" &&
    url.pathname.startsWith("/services/") &&
    url.pathname.split("/").filter(Boolean).length === 4;
  const isPagerDutyEventsApi = url.toString() === PAGERDUTY_EVENTS_URL;

  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (!isSlackWebhook && !isPagerDutyEventsApi)
  ) {
    throw new Error("Payout alert endpoint is not an approved Slack or PagerDuty URL");
  }

  return url;
}

/**
 * Sends one bounded payout-alert request. Only the two owned alert endpoints
 * are accepted, redirects are rejected, and caller cancellation is composed
 * with (rather than substituted for) the per-hop deadline.
 */
export async function alertFetch(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = ALERT_REQUEST_TIMEOUT_MS,
  transport: AlertTransport = safeFetch,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Payout alert timeout must be a positive integer");
  }

  const url = assertAllowedAlertEndpoint(input);
  if (init.body != null && typeof init.body !== "string") {
    throw new TypeError("Payout alert request body must be a JSON string");
  }
  if (
    typeof init.body === "string" &&
    new TextEncoder().encode(init.body).byteLength > MAX_ALERT_REQUEST_BODY_BYTES
  ) {
    throw new RangeError("Payout alert request body exceeds the 64 KiB limit");
  }

  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await transport(url.toString(), {
    ...init,
    redirect: "manual",
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
  if (REDIRECT_STATUSES.has(response.status)) {
    await releaseAlertResponse(response, "redirect");
    throw new Error(`Payout alert endpoint redirected with status ${response.status}`);
  }
  return response;
}

async function releaseAlertResponse(response: Response, channel: string): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    // error-policy:J6 Response disposal is best-effort after delivery completed.
    logger.warn(`[PayoutAlerts] Failed to release ${channel} response body`, { error });
  }
}

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

  constructor(private readonly transport: AlertTransport = safeFetch) {
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

    let response: Response | undefined;
    try {
      response = await alertFetch(
        this.slackWebhookUrl!,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(slackPayload),
        },
        ALERT_REQUEST_TIMEOUT_MS,
        this.transport,
      );

      if (!response.ok) {
        logger.error("[PayoutAlerts] Slack webhook failed", {
          status: response.status,
        });
      }
    } catch (error) {
      // error-policy:J7 Alert diagnostics must not stop payout processing.
      logger.error("[PayoutAlerts] Failed to send Slack alert", { error });
    } finally {
      if (response) await releaseAlertResponse(response, "Slack");
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

    let response: Response | undefined;
    try {
      response = await alertFetch(
        PAGERDUTY_EVENTS_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pagerDutyPayload),
        },
        ALERT_REQUEST_TIMEOUT_MS,
        this.transport,
      );

      if (!response.ok) {
        logger.error("[PayoutAlerts] PagerDuty alert failed", {
          status: response.status,
        });
      }
    } catch (error) {
      // error-policy:J7 Alert diagnostics must not stop payout processing.
      logger.error("[PayoutAlerts] Failed to send PagerDuty alert", { error });
    } finally {
      if (response) await releaseAlertResponse(response, "PagerDuty");
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

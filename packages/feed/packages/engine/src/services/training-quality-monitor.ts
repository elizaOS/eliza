/**
 * Training Data Quality Monitor
 *
 * Lightweight quality checks that run inline during game ticks.
 * Logs warnings when training data quality metrics exceed thresholds.
 * Does NOT block game tick execution — observe only.
 *
 * Usage:
 *   import { trainingQualityMonitor } from './training-quality-monitor';
 *   await trainingQualityMonitor.checkPostQuality(post);
 *   await trainingQualityMonitor.checkTradeQuality(trades);
 *   trainingQualityMonitor.flushSummary(); // end of tick
 */

import { logger } from "@feed/shared";
import { StaticDataRegistry } from "./static-data-registry";

interface QualityAlert {
  metric: string;
  severity: "warning" | "critical";
  message: string;
  value?: number;
}

// Real names derived from actor data at init
let realNames: string[] | null = null;

function getRealNames(): string[] {
  if (realNames) return realNames;
  realNames = [];
  for (const actor of StaticDataRegistry.getAllActors()) {
    const pack = StaticDataRegistry.getPackActor(actor.id);
    if (pack?.realName && pack.realName !== actor.name) {
      realNames.push(pack.realName);
    }
  }
  realNames.push(
    "OpenAI",
    "Tesla",
    "Google",
    "Microsoft",
    "Amazon",
    "Apple",
    "NVIDIA",
    "BlackRock",
    "Bitcoin",
    "Ethereum",
  );
  return realNames;
}

const emojiRegex =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}]/u;

class TrainingQualityMonitor {
  private tickAlerts: QualityAlert[] = [];
  private postsChecked = 0;
  private tradesChecked = 0;

  /**
   * Check a single post for training quality issues.
   * Call after each NPC post is generated.
   */
  checkPostQuality(post: { authorId: string; content: string }): void {
    this.postsChecked++;

    // Real name leakage
    for (const name of getRealNames()) {
      if (post.content.includes(name)) {
        this.tickAlerts.push({
          metric: "real_name_leak",
          severity: "critical",
          message: `Post by ${post.authorId} contains real name "${name}"`,
        });
        break;
      }
    }

    // Hashtag leakage
    if (post.content.includes("#")) {
      this.tickAlerts.push({
        metric: "hashtag_leak",
        severity: "critical",
        message: `Post by ${post.authorId} contains hashtag`,
      });
    }

    // Emoji leakage
    if (emojiRegex.test(post.content)) {
      this.tickAlerts.push({
        metric: "emoji_leak",
        severity: "warning",
        message: `Post by ${post.authorId} contains emoji`,
      });
    }

    // Game mechanic leakage
    const lower = post.content.toLowerCase();
    const mechanicTerms = [
      "predetermined",
      "scripted",
      "arc plan",
      "game tick",
      "simulation",
      "cluestrength",
      "pointstoward",
      "insider status",
      "npc",
    ];
    for (const term of mechanicTerms) {
      if (lower.includes(term)) {
        this.tickAlerts.push({
          metric: "mechanic_leak",
          severity: "critical",
          message: `Post by ${post.authorId} exposes game mechanic: "${term}"`,
        });
        break;
      }
    }

    // Ceiling hit detection
    if (post.content.length >= 195) {
      this.tickAlerts.push({
        metric: "ceiling_hit",
        severity: "warning",
        message: `Post by ${post.authorId} at ${post.content.length} chars (near/at ceiling)`,
      });
    }
  }

  /**
   * Check a batch of trades for training quality issues.
   */
  checkTradeQuality(
    trades: Array<{ action: string; npcActorId: string }>,
  ): void {
    this.tradesChecked += trades.length;

    // Check YES/long bias within this batch
    const longCount = trades.filter(
      (t) => t.action === "buy_yes" || t.action === "open_long",
    ).length;
    const longRate = trades.length > 0 ? longCount / trades.length : 0;

    if (longRate > 0.85 && trades.length >= 5) {
      this.tickAlerts.push({
        metric: "trade_bias",
        severity: "warning",
        message: `${(longRate * 100).toFixed(0)}% of ${trades.length} trades are YES/long`,
        value: longRate,
      });
    }
  }

  /**
   * Log summary of quality alerts for this tick.
   * Call at end of each game tick.
   */
  flushSummary(): void {
    if (this.tickAlerts.length === 0) {
      if (this.postsChecked > 0 || this.tradesChecked > 0) {
        logger.debug(
          "Training quality check passed",
          {
            postsChecked: this.postsChecked,
            tradesChecked: this.tradesChecked,
          },
          "TrainingQuality",
        );
      }
    } else {
      const criticals = this.tickAlerts.filter(
        (a) => a.severity === "critical",
      );
      const warnings = this.tickAlerts.filter((a) => a.severity === "warning");

      logger.warn(
        "Training quality issues detected",
        {
          postsChecked: this.postsChecked,
          tradesChecked: this.tradesChecked,
          criticals: criticals.length,
          warnings: warnings.length,
          alerts: this.tickAlerts.map((a) => a.message),
        },
        "TrainingQuality",
      );
    }

    // Reset for next tick
    this.tickAlerts = [];
    this.postsChecked = 0;
    this.tradesChecked = 0;
  }
}

export const trainingQualityMonitor = new TrainingQualityMonitor();

import type { IAgentRuntime } from "@elizaos/core";
import { getScoutClient, getScoutConfig } from "../runtime-store.js";

export interface ScoreChange {
  domain: string;
  previousScore: number;
  currentScore: number;
  delta: number;
  previousLevel: string;
  currentLevel: string;
}

export class TrustMonitorService {
  static serviceType = "scout_trust_monitor";
  capabilityDescription = "Monitors watched x402 services for trust score changes";

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private previousScores = new Map<string, { score: number; level: string }>();
  private runtime: IAgentRuntime | null = null;

  static async start(runtime: IAgentRuntime): Promise<TrustMonitorService> {
    const service = new TrustMonitorService();
    service.runtime = runtime;
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    if (!this.runtime) return;

    const config = getScoutConfig(this.runtime);
    if (!config || config.watchedDomains.length === 0) return;

    const intervalMs = config.watchInterval * 60 * 1000;
    this.intervalId = setInterval(() => this.checkWatchedDomains(), intervalMs);

    // Run initial check
    await this.checkWatchedDomains();
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async checkWatchedDomains(): Promise<void> {
    if (!this.runtime) return;

    const client = getScoutClient(this.runtime);
    const config = getScoutConfig(this.runtime);
    if (!client || !config || config.watchedDomains.length === 0) return;

    try {
      const result = await client.batchScore(config.watchedDomains);
      const changes: ScoreChange[] = [];

      for (const r of result.results) {
        if (r.score === null || r.level === null) continue;

        const prev = this.previousScores.get(r.domain);
        if (prev) {
          const delta = r.score - prev.score;
          // Only report significant changes (>= 10 points or level change)
          if (Math.abs(delta) >= 10 || prev.level !== r.level) {
            changes.push({
              domain: r.domain,
              previousScore: prev.score,
              currentScore: r.score,
              delta,
              previousLevel: prev.level,
              currentLevel: r.level,
            });
          }
        }

        this.previousScores.set(r.domain, {
          score: r.score,
          level: r.level,
        });
      }

      if (changes.length > 0) {
        this.emitChanges(changes);
      }
    } catch {
      // Silently fail - background monitoring should not crash the agent
    }
  }

  private emitChanges(changes: ScoreChange[]): void {
    if (!this.runtime) return;
    // Emit via ELIZA runtime logger if available, otherwise silent
    for (const change of changes) {
      const direction = change.delta > 0 ? "increased" : "decreased";
      const msg =
        `[Scout Monitor] ${change.domain} trust score ${direction}: ` +
        `${change.previousScore} -> ${change.currentScore} ` +
        `(${change.previousLevel} -> ${change.currentLevel})`;
      this.runtime?.logger?.info(msg);
    }
  }
}
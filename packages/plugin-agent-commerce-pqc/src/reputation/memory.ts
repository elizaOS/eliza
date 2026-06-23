import type { IReputationProvider, ReputationScore } from './index';

export interface MemoryReputationConfig {
  /** Minimum score required to fund a job (0–100). Defaults to 0. */
  minScore?: number;
  /** Maximum amount allowed per job. 0n = unlimited. */
  maxAmountPerJob?: bigint;
  /** Initial seed scores for known agents. */
  initialScores?: Record<string, Omit<ReputationScore, 'agentId' | 'source'>>;
}

export class MemoryReputationProvider implements IReputationProvider {
  private readonly scores = new Map<string, ReputationScore>();
  private readonly minScore: number;
  private readonly maxAmountPerJob: bigint;

  constructor(config: MemoryReputationConfig = {}) {
    this.minScore = config.minScore ?? 0;
    this.maxAmountPerJob = config.maxAmountPerJob ?? 0n;

    for (const [agentId, partial] of Object.entries(config.initialScores ?? {})) {
      this.scores.set(agentId, {
        agentId,
        source: 'memory',
        ...partial,
      });
    }
  }

  async canFundJob(agentId: string, amount: bigint): Promise<boolean> {
    if (this.maxAmountPerJob > 0n && amount > this.maxAmountPerJob) return false;
    const { score } = await this.getScore(agentId);
    return score >= this.minScore;
  }

  async getScore(agentId: string): Promise<ReputationScore> {
    const existing = this.scores.get(agentId);
    if (existing) return { ...existing };

    const fresh: ReputationScore = {
      agentId,
      score: 100,
      jobsCompleted: 0,
      jobsFailed: 0,
      source: 'memory',
      updatedAt: Date.now(),
    };
    this.scores.set(agentId, fresh);
    return { ...fresh };
  }

  async recordOutcome(_jobId: string, agentId: string, success: boolean): Promise<void> {
    const current = await this.getScore(agentId);
    const updated: ReputationScore = {
      ...current,
      jobsCompleted: current.jobsCompleted + (success ? 1 : 0),
      jobsFailed: current.jobsFailed + (success ? 0 : 1),
      score: success
        ? Math.min(100, current.score + 1)
        : Math.max(0, current.score - 5),
      updatedAt: Date.now(),
    };
    this.scores.set(agentId, updated);
  }
}

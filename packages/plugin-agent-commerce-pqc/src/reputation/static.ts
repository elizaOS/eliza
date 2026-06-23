import type { IReputationProvider, ReputationScore } from './index';

export interface StaticReputationConfig {
  /** Minimum score required to fund a job (0–100). Defaults to 0 (allow all). */
  minScore?: number;
  /** Maximum amount allowed per job. 0n = unlimited. */
  maxAmountPerJob?: bigint;
  /** Agents unconditionally denied, regardless of score. */
  denyList?: string[];
  /** Per-agent score overrides. Unknown agents receive score 100. */
  scores?: Record<string, number>;
}

export class StaticReputationProvider implements IReputationProvider {
  private readonly minScore: number;
  private readonly maxAmountPerJob: bigint;
  private readonly denyList: ReadonlySet<string>;
  private readonly scores: Readonly<Record<string, number>>;

  constructor(config: StaticReputationConfig = {}) {
    this.minScore = config.minScore ?? 0;
    this.maxAmountPerJob = config.maxAmountPerJob ?? 0n;
    this.denyList = new Set(config.denyList ?? []);
    this.scores = Object.freeze({ ...(config.scores ?? {}) });
  }

  async canFundJob(agentId: string, amount: bigint): Promise<boolean> {
    if (this.denyList.has(agentId)) return false;
    if (this.maxAmountPerJob > 0n && amount > this.maxAmountPerJob) return false;
    const { score } = await this.getScore(agentId);
    return score >= this.minScore;
  }

  async getScore(agentId: string): Promise<ReputationScore> {
    const score = this.scores[agentId] ?? 100;
    return {
      agentId,
      score,
      jobsCompleted: 0,
      jobsFailed: 0,
      source: 'static',
      updatedAt: 0,
    };
  }
}

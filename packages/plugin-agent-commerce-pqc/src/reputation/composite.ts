import type { IReputationProvider, ReputationScore } from './index';

/**
 * Chains multiple IReputationProvider instances.
 * - canFundJob: all providers must approve (AND semantics)
 * - getScore: returns the minimum score across all providers (conservative)
 * - recordOutcome: forwarded to all providers that support it
 */
export class CompositeReputationProvider implements IReputationProvider {
  constructor(private readonly providers: ReadonlyArray<IReputationProvider>) {
    if (providers.length === 0) {
      throw new Error('CompositeReputationProvider requires at least one provider');
    }
  }

  async canFundJob(agentId: string, amount: bigint): Promise<boolean> {
    for (const provider of this.providers) {
      if (!(await provider.canFundJob(agentId, amount))) return false;
    }
    return true;
  }

  async getScore(agentId: string): Promise<ReputationScore> {
    let min: ReputationScore | null = null;
    for (const provider of this.providers) {
      const score = await provider.getScore(agentId);
      if (min === null || score.score < min.score) {
        min = score;
      }
    }
    return min as ReputationScore;
  }

  async recordOutcome(jobId: string, agentId: string, success: boolean): Promise<void> {
    await Promise.all(
      this.providers
        .filter((p) => typeof p.recordOutcome === 'function')
        .map((p) => p.recordOutcome!(jobId, agentId, success)),
    );
  }
}

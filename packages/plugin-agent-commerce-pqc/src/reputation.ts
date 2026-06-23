export interface ReputationScore {
  agentId: string;
  score: number;
  jobsCompleted: number;
  jobsFailed: number;
  source: string;
}

export class MockReputationGate {
  private readonly scores = new Map<string, ReputationScore>([
    ['alice', { agentId: 'alice', score: 95, jobsCompleted: 47, jobsFailed: 1, source: 'mock' }],
    ['bob', { agentId: 'bob', score: 88, jobsCompleted: 31, jobsFailed: 2, source: 'mock' }],
  ]);

  async getScore(agentId: string): Promise<ReputationScore> {
    const existing = this.scores.get(agentId);
    if (existing) {
      return { ...existing };
    }

    const score: ReputationScore = {
      agentId,
      score: 60,
      jobsCompleted: 0,
      jobsFailed: 0,
      source: 'mock',
    };
    this.scores.set(agentId, score);
    return { ...score };
  }

  async canFundJob(_clientAgent: string, providerAgent: string, _amount: string): Promise<boolean> {
    const score = await this.getScore(providerAgent);
    return score.score >= 50;
  }

  async recordOutcome(jobId: string, agentId: string, success: boolean): Promise<void> {
    const score = await this.getScore(agentId);
    if (success) {
      score.jobsCompleted += 1;
      score.score = Math.min(100, score.score + 1);
    } else {
      score.jobsFailed += 1;
      score.score = Math.max(0, score.score - 5);
    }
    this.scores.set(agentId, score);
  }
}

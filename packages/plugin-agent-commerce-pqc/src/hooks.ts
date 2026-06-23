import type { IPqcReputationGateHook } from './types';

export class MockPqcReputationGate implements IPqcReputationGateHook {
  private reputationScores: Map<string, number> = new Map();
  private fundingLimits: Map<string, bigint> = new Map();

  constructor() {
    this.reputationScores.set('agent-1', 85);
    this.reputationScores.set('agent-2', 92);
    this.reputationScores.set('agent-3', 45);
    this.reputationScores.set('agent-unknown', 0);

    this.fundingLimits.set('agent-1', 1_000_000n);
    this.fundingLimits.set('agent-2', 5_000_000n);
    this.fundingLimits.set('agent-3', 100_000n);
  }

  async canFundJob(agentId: string, amount: bigint): Promise<boolean> {
    const reputation = await this.getReputation(agentId);
    const limit = this.fundingLimits.get(agentId) || 0n;

    console.log(
      `[PQC Gate] Checking funding: ${agentId} (rep=${reputation}, limit=${limit.toString()})`,
    );

    if (reputation < 50) {
      console.log(`[PQC Gate] DENIED: Reputation ${reputation} < 50`);
      return false;
    }

    if (amount > limit) {
      console.log(
        `[PQC Gate] DENIED: Amount ${amount.toString()} > limit ${limit.toString()}`,
      );
      return false;
    }

    console.log(`[PQC Gate] APPROVED: Funding allowed`);
    return true;
  }

  async getReputation(agentId: string): Promise<number> {
    return this.reputationScores.get(agentId) ?? 0;
  }

  setReputation(agentId: string, score: number): void {
    this.reputationScores.set(agentId, score);
  }

  setFundingLimit(agentId: string, limit: bigint): void {
    this.fundingLimits.set(agentId, limit);
  }
}

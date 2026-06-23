import type { IReputationGateHook } from './types';
import { getPluginLogger } from './lib/logger';

export class StubReputationGate implements IReputationGateHook {
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
    const logger = getPluginLogger();
    const reputation = await this.getReputation(agentId);
    const limit = this.fundingLimits.get(agentId) || 0n;

    logger.debug(
      `Reputation gate check for ${agentId} (rep=${reputation}, limit=${limit.toString()})`,
    );

    if (reputation < 50) {
      logger.info(`Funding denied for ${agentId}: reputation ${reputation} < 50`);
      return false;
    }

    if (amount > limit) {
      logger.info(
        `Funding denied for ${agentId}: amount ${amount.toString()} > limit ${limit.toString()}`,
      );
      return false;
    }

    logger.debug(`Funding approved for ${agentId}`);
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

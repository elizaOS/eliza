/**
 * ERC-8004 reputation registry client.
 * Uses mock data until the reputation contract is deployed.
 */

import type { FeedbackSignal, RegistryConfig, ReputationScore } from "./types";

export class ReputationRegistryClient {
  readonly config: RegistryConfig;

  constructor(config: RegistryConfig) {
    this.config = config;
  }

  /** Return a mock transaction hash until on-chain submission is implemented. */
  async postFeedback(_params: FeedbackSignal): Promise<string> {
    return `0x${"0".repeat(64)}`;
  }

  /** Return a zeroed reputation score until on-chain lookups are implemented. */
  async getReputation(agentTokenId: string): Promise<ReputationScore> {
    return {
      agentId: agentTokenId,
      scoreOnchain: 0,
      scoreInternal: 0,
      scoreCombined: 0,
      feedbackCount: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  /** Return no history until feedback events are indexed. */
  async getFeedbackHistory(_agentTokenId: string, _limit?: number): Promise<FeedbackSignal[]> {
    return [];
  }
}

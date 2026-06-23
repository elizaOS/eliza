export interface ReputationScore {
  agentId: string;
  score: number;
  jobsCompleted: number;
  jobsFailed: number;
  source: string;
  updatedAt: number;
}

export interface IReputationProvider {
  /** Returns true if the agent is allowed to participate at the given amount. */
  canFundJob(agentId: string, amount: bigint): Promise<boolean>;
  /** Returns current reputation score for the agent (0–100). */
  getScore(agentId: string): Promise<ReputationScore>;
  /** Records a job outcome so the provider can update its internal state. Optional. */
  recordOutcome?(jobId: string, agentId: string, success: boolean): Promise<void>;
}

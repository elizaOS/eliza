export enum ERC8183JobState {
  OPEN = 'OPEN',
  FUNDED = 'FUNDED',
  SUBMITTED = 'SUBMITTED',
  COMPLETE = 'COMPLETE',
  REFUND = 'REFUND',
  ABORTED = 'ABORTED',
  EXPIRED = 'EXPIRED',
  TERMINAL = 'TERMINAL',
}

export type ERC8183JobStateType = keyof typeof ERC8183JobState;

export type EvaluatorFunction = (
  deliverable: string,
  requirements: Record<string, unknown>,
) => Promise<boolean>;

export interface IErc8183Job {
  jobId: string;
  clientAgent: string;
  providerAgent: string;
  evaluatorAgent?: string;
  state: ERC8183JobState;
  taskDescription: string;
  requiredAmount: bigint;
  fundedAmount: bigint;
  deliverableHash?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata: Record<string, unknown>;
}

export interface IPqcReputationGateHook {
  canFundJob(agentId: string, amount: bigint): Promise<boolean>;
  getReputation(agentId: string): Promise<number>;
}

export interface IJobStore {
  save(job: IErc8183Job): Promise<void>;
  get(jobId: string): Promise<IErc8183Job | null>;
  listByAgent(agentId: string): Promise<IErc8183Job[]>;
  clear(): Promise<void>;
}

export interface ICommerceContext {
  runtime: unknown;
  jobStore: IJobStore;
  reputationGate: IPqcReputationGateHook;
}

export enum EvaluationDecision {
  ACCEPT = 'ACCEPT',
  REJECT = 'REJECT',
  PARTIAL = 'PARTIAL',
}

export class MemoryJobStore implements IJobStore {
  private jobs: Map<string, IErc8183Job> = new Map();

  async save(job: IErc8183Job): Promise<void> {
    this.jobs.set(job.jobId, job);
  }

  async get(jobId: string): Promise<IErc8183Job | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async listByAgent(agentId: string): Promise<IErc8183Job[]> {
    return Array.from(this.jobs.values()).filter(
      (job) => job.clientAgent === agentId || job.providerAgent === agentId,
    );
  }

  async clear(): Promise<void> {
    this.jobs.clear();
  }
}
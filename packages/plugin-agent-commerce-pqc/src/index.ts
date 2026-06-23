import { ERC8183StateMachine } from './state-machine';
import { MockPqcReputationGate } from './hooks';
import { MockReputationGate, type ReputationScore } from './reputation';
import { MemoryJobStore, EvaluationDecision } from './types';
import type {
  ERC8183JobState,
  IErc8183Job,
  ICommerceContext,
  IJobStore,
  IPqcReputationGateHook,
  EvaluatorFunction,
} from './types';
import type { StvorTransportManager } from './lib/pqc';

export type {
  ERC8183JobState,
  IErc8183Job,
  ICommerceContext,
  IJobStore,
  IPqcReputationGateHook,
  EvaluatorFunction,
} from './types';
export { ERC8183StateMachine } from './state-machine';
export { MockPqcReputationGate } from './hooks';
export { MockReputationGate, type ReputationScore } from './reputation';
export { MemoryJobStore, EvaluationDecision } from './types';
export {
  CommerceTransportBridge,
  createCommerceTransportBridge,
  type ICommerceEventListener,
} from './lifecycle';

export {
  agentCommercePlugin,
  commerceActions,
  commerceEvaluator,
  commerceProvider,
  securityEvaluator,
} from './elizaos/index';

export { agentCommercePlugin as default } from './elizaos/index';

export interface ICommercePlugin {
  registerEventListener(listener: import('./lifecycle').ICommerceEventListener): void;
  createJob(
    clientAgent: string,
    providerAgent: string,
    taskDescription: string,
    requiredAmount: bigint,
  ): Promise<IErc8183Job>;
  fundJob(jobId: string, clientAgent: string, fundAmount: bigint): Promise<IErc8183Job>;
  submitJob(jobId: string, providerAgent: string, deliverableHash: string, deliverablePayload?: unknown): Promise<IErc8183Job>;
  evaluateJob(
    jobId: string,
    callerAgent: string,
    decision: 'ACCEPT' | 'REJECT' | 'PARTIAL',
    reason?: string,
  ): Promise<IErc8183Job>;
  getJob(jobId: string): Promise<IErc8183Job | null>;
  getJobState(jobId: string): Promise<ERC8183JobState | null>;
  listJobs(agentId: string): Promise<IErc8183Job[]>;
  getContext(): ICommerceContext;
  getTransport(): StvorTransportManager | null;
}

export class AgentCommercePlugin implements ICommercePlugin {
  private readonly context: ICommerceContext;
  private readonly transport: StvorTransportManager | null;
  private readonly eventListeners: import('./lifecycle').ICommerceEventListener[] = [];

  constructor(
    runtime: unknown,
    transport?: StvorTransportManager,
    context?: Partial<ICommerceContext>,
  ) {
    this.transport = transport ?? null;
    this.context = {
      runtime,
      jobStore: context?.jobStore ?? new MemoryJobStore(),
      reputationGate: context?.reputationGate ?? new MockPqcReputationGate(),
    };
  }

  registerEventListener(listener: import('./lifecycle').ICommerceEventListener): void {
    this.eventListeners.push(listener);
  }

  private async notifyJobCreated(job: IErc8183Job): Promise<void> {
    for (const listener of this.eventListeners) {
      await listener.onJobCreated(job);
    }
  }

  private async notifyJobFunded(job: IErc8183Job): Promise<void> {
    for (const listener of this.eventListeners) {
      await listener.onJobFunded(job);
    }
  }

  private async notifyJobSubmitted(job: IErc8183Job): Promise<void> {
    for (const listener of this.eventListeners) {
      await listener.onJobSubmitted(job);
    }
  }

  private async notifyJobEvaluated(job: IErc8183Job, decision: string): Promise<void> {
    for (const listener of this.eventListeners) {
      await listener.onJobEvaluated(job, decision);
    }
  }

  async createJob(
    clientAgent: string,
    providerAgent: string,
    taskDescription: string,
    requiredAmount: bigint,
  ): Promise<IErc8183Job> {
    const job = await ERC8183StateMachine.createJob(
      this.context,
      clientAgent,
      providerAgent,
      taskDescription,
      requiredAmount,
    );
    await this.notifyJobCreated(job);
    return job;
  }

  async fundJob(jobId: string, clientAgent: string, fundAmount: bigint): Promise<IErc8183Job> {
    const job = await ERC8183StateMachine.fundJob(this.context, jobId, clientAgent, fundAmount);
    await this.notifyJobFunded(job);
    return job;
  }

  async submitJob(
    jobId: string,
    providerAgent: string,
    deliverableHash: string,
    deliverablePayload?: unknown,
  ): Promise<IErc8183Job> {
    const job = await ERC8183StateMachine.submitJob(
      this.context,
      jobId,
      providerAgent,
      deliverableHash,
      deliverablePayload,
    );
    await this.notifyJobSubmitted(job);
    return job;
  }

  async evaluateJob(
    jobId: string,
    callerAgent: string,
    decision: 'ACCEPT' | 'REJECT' | 'PARTIAL',
    reason?: string,
  ): Promise<IErc8183Job> {
    const job = await ERC8183StateMachine.evaluateJob(
      this.context,
      jobId,
      callerAgent,
      decision as EvaluationDecision,
      reason,
    );
    await this.notifyJobEvaluated(job, decision);
    return job;
  }

  async getJob(jobId: string): Promise<IErc8183Job | null> {
    return this.context.jobStore.get(jobId);
  }

  async getJobState(jobId: string): Promise<ERC8183JobState | null> {
    const job = await this.getJob(jobId);
    return job?.state ?? null;
  }

  async listJobs(agentId: string): Promise<IErc8183Job[]> {
    return this.context.jobStore.listByAgent(agentId);
  }

  getContext(): ICommerceContext {
    return this.context;
  }

  getTransport(): StvorTransportManager | null {
    return this.transport;
  }
}

export function createCommercePlugin(
  runtime: unknown,
  transport?: StvorTransportManager,
  context?: Partial<ICommerceContext>,
): AgentCommercePlugin {
  return new AgentCommercePlugin(runtime, transport, context);
}

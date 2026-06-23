import { ERC8183StateMachine } from './state-machine';
import { StubReputationGate } from './hooks';
import { MockReputationGate, type ReputationScore } from './reputation';
import { MemoryJobStore, EvaluationDecision } from './types';
import type {
  ERC8183JobState,
  IErc8183Job,
  ICommerceContext,
  IJobStore,
  IReputationGateHook,
  EvaluatorFunction,
} from './types';
import type { StvorTransportManager } from './lib/pqc';

export type {
  ERC8183JobState,
  IErc8183Job,
  ICommerceContext,
  IJobStore,
  IReputationGateHook,
  EvaluatorFunction,
} from './types';
export { ERC8183StateMachine } from './state-machine';
export { StubReputationGate } from './hooks';
export { MockReputationGate } from './reputation';
export { MemoryJobStore, EvaluationDecision } from './types';
export {
  CommerceTransportBridge,
  createCommerceTransportBridge,
  type ICommerceEventListener,
} from './lifecycle';

export {
  agentCommercePlugin,
  commerceActions,
  commerceProvider,
} from './elizaos/index';

export { agentCommercePlugin as default } from './elizaos/index';

export { AgentCommerceService, AGENT_COMMERCE_SERVICE_TYPE } from './service';
export type { AgentCommerceServiceConfig } from './service';
export type { IReputationProvider } from './reputation/index';
export type { ReputationScore } from './reputation/index';
export { StaticReputationProvider } from './reputation/static';
export type { StaticReputationConfig } from './reputation/static';
export { MemoryReputationProvider } from './reputation/memory';
export type { MemoryReputationConfig } from './reputation/memory';
export { CompositeReputationProvider } from './reputation/composite';
export { ElizaJobStore } from './store/elizaos';

export interface ICommercePlugin {
  registerEventListener(listener: import('./lifecycle').ICommerceEventListener): void;
  clearEventListeners(): void;
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
    transport?: StvorTransportManager,
    context?: Partial<ICommerceContext>,
  ) {
    this.transport = transport ?? null;
    this.context = {
      jobStore: context?.jobStore ?? new MemoryJobStore(),
      reputationGate: context?.reputationGate ?? new StubReputationGate(),
    };
  }

  registerEventListener(listener: import('./lifecycle').ICommerceEventListener): void {
    this.eventListeners.push(listener);
  }

  clearEventListeners(): void {
    this.eventListeners.length = 0;
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
  transport?: StvorTransportManager,
  context?: Partial<ICommerceContext>,
): AgentCommercePlugin {
  return new AgentCommercePlugin(transport, context);
}

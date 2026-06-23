import type { IElizaRuntime, Memory, State } from './types';
import type { IJobStore, ICommerceContext, ERC8183JobState } from '../types';
import { MockPqcReputationGate } from '../hooks';

const contexts = new Map<string, { ctx: ICommerceContext; store: IJobStore }>();

class LocalMemoryJobStore implements IJobStore {
  private jobs: Map<string, { jobId: string; clientAgent: string; providerAgent: string; state: ERC8183JobState; taskDescription: string; requiredAmount: bigint; fundedAmount: bigint; createdAt: number; updatedAt: number; metadata: Record<string, unknown> }> = new Map();

  async save(job: { jobId: string; clientAgent: string; providerAgent: string; state: ERC8183JobState; taskDescription: string; requiredAmount: bigint; fundedAmount: bigint; createdAt: number; updatedAt: number; metadata: Record<string, unknown> }): Promise<void> {
    this.jobs.set(job.jobId, job);
  }

  async get(jobId: string): Promise<{ jobId: string; clientAgent: string; providerAgent: string; state: ERC8183JobState; taskDescription: string; requiredAmount: bigint; fundedAmount: bigint; createdAt: number; updatedAt: number; metadata: Record<string, unknown> } | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async listByAgent(agentId: string): Promise<{ jobId: string; clientAgent: string; providerAgent: string; state: ERC8183JobState; taskDescription: string; requiredAmount: bigint; fundedAmount: bigint; createdAt: number; updatedAt: number; metadata: Record<string, unknown> }[]> {
    return Array.from(this.jobs.values()).filter(
      (job) => job.clientAgent === agentId || job.providerAgent === agentId,
    );
  }

  async clear(): Promise<void> {
    this.jobs.clear();
  }
}

function getOrCreate(runtime: IElizaRuntime): { ctx: ICommerceContext; store: IJobStore } {
  if (!contexts.has(runtime.agentId)) {
    const store = new LocalMemoryJobStore();
    const gate = new MockPqcReputationGate();
    const ctx: ICommerceContext = {
      runtime,
      jobStore: store,
      reputationGate: gate,
    };
    contexts.set(runtime.agentId, { ctx, store });
  }
  return contexts.get(runtime.agentId) as { ctx: ICommerceContext; store: IJobStore };
}

export const commerceProvider = {
  name: 'COMMERCE_CONTEXT',
  description: 'Provides active ERC-8183 job context and crypto transport status to the agent',
  get: async (runtime: IElizaRuntime, _message: Memory, _state: State): Promise<string> => {
    const { store } = getOrCreate(runtime);
    const jobs = await store.listByAgent(runtime.agentId);

    if (jobs.length === 0) {
      return '[Commerce] No active jobs. You can create a new job with "Create a job for <provider> to <task>, budget <amount>"';
    }

    const recent = jobs.slice(-5);
    const summary = recent.map((j) =>
      `• ${j.jobId} | ${j.state} | provider: ${j.providerAgent} | "${j.taskDescription.slice(0, 40)}..."`,
    ).join('\n');

    return `[Commerce — ERC-8183 Secure Jobs]\n${summary}\n[Transport: ML-KEM-768 + AES-256-GCM | Ledger: SHA-256 attestation only]`;
  },
};
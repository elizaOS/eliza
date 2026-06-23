import type { IElizaRuntime, Memory, State, HandlerCallback } from './types';
import { ERC8183StateMachine } from '../state-machine';
import { MockPqcReputationGate } from '../hooks';
import { PayloadHasher } from '../lib/pqc';
import type { ICommerceContext, IErc8183Job, IJobStore } from '../types';

const contexts = new Map<string, ICommerceContext>();

function getContext(runtime: IElizaRuntime): ICommerceContext {
  if (!contexts.has(runtime.agentId)) {
    const gate = new MockPqcReputationGate();
    const jobStore: IJobStore = new LocalMemoryJobStore();
    const ctx: ICommerceContext = {
      runtime,
      jobStore,
      reputationGate: gate,
    };
    contexts.set(runtime.agentId, ctx);
  }
  return contexts.get(runtime.agentId) as ICommerceContext;
}

class LocalMemoryJobStore implements IJobStore {
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

export const createJobAction = {
  name: 'CREATE_SECURE_JOB',
  description: 'Create a new ERC-8183 agentic commerce job with PQC-secured transport',
  similes: ['create job', 'new job', 'start job', 'create secure job', 'hire agent'],
  examples: [[
    { user: 'user', content: { text: 'Create a job for bob to build a REST API, budget 1000000' } },
    { user: 'agent', content: { text: 'Job created successfully. Job ID: job-xxx. Status: OPEN.' } }
  ]],
  validate: async (_runtime: IElizaRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return text.includes('create') && (text.includes('job') || text.includes('task'));
  },
  handler: async (
    runtime: IElizaRuntime,
    message: Memory,
    _state: State,
    _options: unknown,
    callback: HandlerCallback
  ) => {
    const text = message.content.text;
    const providerMatch = text.match(/for\s+(\w+)/i);
    const amountMatch = text.match(/(\d+)/);
    const taskMatch = text.match(/to\s+(.+?)(?:,|budget|$)/i);

    if (!providerMatch || !amountMatch) {
      await callback({
        text: 'Please specify: "Create a job for <provider> to <task description>, budget <amount>"'
      });
      return;
    }

    const ctx = getContext(runtime);
    const job = await ERC8183StateMachine.createJob(
      ctx,
      runtime.agentId,
      providerMatch[1],
      taskMatch?.[1]?.trim() ?? 'Unspecified task',
      BigInt(amountMatch[1]),
    );

    await callback({
      text: `✅ Job created.\n**Job ID:** ${job.jobId}\n**Status:** ${job.state}\n**Provider:** ${job.providerAgent}\n**Task:** ${job.taskDescription}`,
      data: { jobId: job.jobId, status: job.state }
    });
  }
};

export const fundJobAction = {
  name: 'FUND_SECURE_JOB',
  description: 'Fund an ERC-8183 job and trigger encrypted task delivery via PQC transport',
  similes: ['fund job', 'pay for job', 'lock funds', 'escrow'],
  examples: [[
    { user: 'user', content: { text: 'Fund job job-abc123 with 1000000' } },
    { user: 'agent', content: { text: 'Job funded. Task spec encrypted and delivered to provider.' } }
  ]],
  validate: async (_runtime: IElizaRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return text.includes('fund') && text.includes('job');
  },
  handler: async (
    runtime: IElizaRuntime,
    message: Memory,
    _state: State,
    _options: unknown,
    callback: HandlerCallback
  ) => {
    const text = message.content.text;
    const jobIdMatch = text.match(/job-[\w-]+/i);
    const amountMatch = text.match(/(\d+)/);

    if (!jobIdMatch) {
      await callback({ text: 'Please specify a job ID (e.g. "Fund job job-abc123 with 1000000")' });
      return;
    }

    if (!amountMatch) {
      await callback({
        text: 'Please specify a funding amount (e.g. "Fund job job-abc123 with 1000000")',
      });
      return;
    }

    const fundAmount = BigInt(amountMatch[1]);
    if (fundAmount <= 0n) {
      await callback({ text: 'Funding amount must be greater than 0.' });
      return;
    }

    const ctx = getContext(runtime);
    try {
      const job = await ERC8183StateMachine.fundJob(
        ctx,
        jobIdMatch[0],
        runtime.agentId,
        fundAmount,
      );
      await callback({
        text: `🔐 Job funded & secured.\n**Job ID:** ${job.jobId}\n**Status:** ${job.state}\n**Encrypted task delivered to provider via ML-KEM-768 + AES-256-GCM**`,
        data: { jobId: job.jobId, status: job.state }
      });
    } catch (e) {
      await callback({ text: `Failed to fund job: ${(e as Error).message}` });
    }
  }
};

export const submitDeliverableAction = {
  name: 'SUBMIT_DELIVERABLE',
  description: 'Submit encrypted deliverable for a funded ERC-8183 job',
  similes: ['submit deliverable', 'submit work', 'complete job', 'deliver result'],
  examples: [[
    { user: 'user', content: { text: 'Submit deliverable for job-abc123: API is complete at https://api.example.com' } },
    { user: 'agent', content: { text: 'Deliverable submitted and encrypted. Awaiting evaluator.' } }
  ]],
  validate: async (_runtime: IElizaRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return text.includes('submit') && (text.includes('deliverable') || text.includes('work') || text.includes('result'));
  },
  handler: async (
    runtime: IElizaRuntime,
    message: Memory,
    _state: State,
    _options: unknown,
    callback: HandlerCallback
  ) => {
    const text = message.content.text;
    const jobIdMatch = text.match(/job-[\w-]+/i);
    const colonIdx = text.indexOf(':');
    const deliverable = colonIdx > -1 ? text.slice(colonIdx + 1).trim() : text;

    if (!jobIdMatch) {
      await callback({ text: 'Please specify: "Submit deliverable for job-<id>: <your deliverable>"' });
      return;
    }

    const ctx = getContext(runtime);
    try {
      const deliverablePayload = { text: deliverable };
      const deliverableHash = PayloadHasher.hashPayload(deliverablePayload);
      const job = await ERC8183StateMachine.submitJob(
        ctx,
        jobIdMatch[0],
        runtime.agentId,
        deliverableHash,
        deliverablePayload,
      );
      await callback({
        text: `📦 Deliverable submitted.\n**Job ID:** ${job.jobId}\n**Status:** ${job.state}\n**Hash recorded on ledger (no plaintext stored)**`,
        data: { jobId: job.jobId, status: job.state }
      });
    } catch (e) {
      await callback({ text: `Failed to submit: ${(e as Error).message}` });
    }
  }
};

export const jobStatusAction = {
  name: 'JOB_STATUS',
  description: 'Check the status of an ERC-8183 commerce job',
  similes: ['job status', 'check job', 'what is job status', 'job state'],
  examples: [[
    { user: 'user', content: { text: 'What is the status of job-abc123?' } },
    { user: 'agent', content: { text: 'Job job-abc123 is currently FUNDED.' } }
  ]],
  validate: async (_runtime: IElizaRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return (text.includes('status') || text.includes('state') || text.includes('check'))
      && text.includes('job');
  },
  handler: async (
    runtime: IElizaRuntime,
    message: Memory,
    _state: State,
    _options: unknown,
    callback: HandlerCallback
  ) => {
    const text = message.content.text;
    const jobIdMatch = text.match(/job-[\w-]+/i);

    if (!jobIdMatch) {
      await callback({ text: 'Please include a job ID, e.g. "status of job-abc123"' });
      return;
    }

    const ctx = getContext(runtime);
    try {
      const job = await ctx.jobStore.get(jobIdMatch[0]);
      if (!job) {
        await callback({ text: `Job ${jobIdMatch[0]} not found.` });
        return;
      }
      await callback({
        text: `📊 **Job:** ${job.jobId}\n**Status:** ${job.state}\n**Client:** ${job.clientAgent}\n**Provider:** ${job.providerAgent}\n**Task:** ${job.taskDescription}`,
        data: job
      });
    } catch (e) {
      await callback({ text: `Error fetching job: ${(e as Error).message}` });
    }
  }
};

export const commerceActions = [
  createJobAction,
  fundJobAction,
  submitDeliverableAction,
  jobStatusAction,
];
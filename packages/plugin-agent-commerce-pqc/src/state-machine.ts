import { randomUUID, timingSafeEqual } from 'crypto';
import type { IErc8183Job, ICommerceContext, IJobStore } from './types';
import { EvaluationDecision, ERC8183JobState } from './types';
import { getPluginLogger } from './lib/logger';

const log = getPluginLogger();

export async function clearJobStore(jobStore: IJobStore): Promise<void> {
  await jobStore.clear();
}

function decisionEquals(
  decision: EvaluationDecision,
  expected: EvaluationDecision,
): boolean {
  const a = Buffer.from(decision);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class ERC8183StateMachine {
  static async createJob(
    ctx: ICommerceContext,
    clientAgent: string,
    providerAgent: string,
    taskDescription: string,
    requiredAmount: bigint,
  ): Promise<IErc8183Job> {
    if (!clientAgent || !providerAgent) {
      throw new Error('Both clientAgent and providerAgent are required');
    }
    if (requiredAmount <= 0n) {
      throw new Error('requiredAmount must be greater than 0');
    }

    const jobId = `job-${randomUUID().substring(0, 8)}`;
    const now = Date.now();

    const job: IErc8183Job = {
      jobId,
      clientAgent,
      providerAgent,
      state: ERC8183JobState.OPEN,
      taskDescription,
      requiredAmount,
      fundedAmount: 0n,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };

    await ctx.jobStore.save(job);
    log.info(`[ERC-8183] Created job ${jobId} (${ERC8183JobState.OPEN})`);
    return job;
  }

  static async fundJob(
    ctx: ICommerceContext,
    jobId: string,
    clientAgent: string,
    fundAmount: bigint,
  ): Promise<IErc8183Job> {
    const job = await ctx.jobStore.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (job.state !== ERC8183JobState.OPEN) {
      throw new Error(`Cannot fund job in state ${job.state}. Expected ${ERC8183JobState.OPEN}.`);
    }
    if (job.clientAgent !== clientAgent) {
      throw new Error('Only the job creator can fund this job');
    }

    const canFund = await ctx.reputationGate.canFundJob(clientAgent, fundAmount);
    if (!canFund) {
      throw new Error(`Reputation gate denied funding for agent ${clientAgent}`);
    }
    if (fundAmount <= 0n) {
      throw new Error('Fund amount must be greater than 0');
    }

    const newFundedAmount = job.fundedAmount + fundAmount;
    job.fundedAmount = newFundedAmount;

    if (newFundedAmount >= job.requiredAmount) {
      job.state = ERC8183JobState.FUNDED;
    }

    job.updatedAt = Date.now();
    await ctx.jobStore.save(job);

    log.info(
      `[ERC-8183] Funded job ${jobId} with ${fundAmount.toString()} (state: ${job.state})`,
    );
    return job;
  }

  static async submitJob(
    ctx: ICommerceContext,
    jobId: string,
    providerAgent: string,
    deliverableHash: string,
    deliverablePayload?: unknown,
  ): Promise<IErc8183Job> {
    if (!/^[0-9a-f]{64}$/i.test(deliverableHash)) {
      throw new Error('deliverableHash must be a valid SHA-256 hex string');
    }
    const job = await ctx.jobStore.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (job.state !== ERC8183JobState.FUNDED) {
      throw new Error(`Cannot submit to job in state ${job.state}. Expected ${ERC8183JobState.FUNDED}.`);
    }
    if (job.providerAgent !== providerAgent) {
      throw new Error('Only the provider can submit to this job');
    }

    job.deliverableHash = deliverableHash;
    if (deliverablePayload !== undefined) {
      job.metadata.deliverablePayload = deliverablePayload;
    }
    job.state = ERC8183JobState.SUBMITTED;
    job.updatedAt = Date.now();

    await ctx.jobStore.save(job);
    log.info(`[ERC-8183] Submitted deliverable for job ${jobId} (hash: ${deliverableHash})`);
    return job;
  }

  static async refundJob(
    ctx: ICommerceContext,
    jobId: string,
    reason?: string,
  ): Promise<IErc8183Job> {
    const job = await ctx.jobStore.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.state === ERC8183JobState.REFUND) {
      return job;
    }

    if (
      job.state !== ERC8183JobState.OPEN &&
      job.state !== ERC8183JobState.FUNDED &&
      job.state !== ERC8183JobState.SUBMITTED &&
      job.state !== ERC8183JobState.EXPIRED
    ) {
      throw new Error(
        `Cannot refund job in state ${job.state}. Expected ${ERC8183JobState.OPEN}, ${ERC8183JobState.FUNDED}, ${ERC8183JobState.SUBMITTED}, or ${ERC8183JobState.EXPIRED}.`,
      );
    }

    job.state = ERC8183JobState.REFUND;
    job.metadata.refundReason =
      reason ?? 'Escrow refund triggered by timeout or recovery.';
    job.updatedAt = Date.now();
    job.completedAt = Date.now();

    await ctx.jobStore.save(job);
    log.warn(`[ERC-8183] Refund triggered for job ${jobId}: ${job.metadata.refundReason}`);
    return job;
  }

  static async expireJob(
    ctx: ICommerceContext,
    jobId: string,
    reason?: string,
  ): Promise<IErc8183Job> {
    const job = await ctx.jobStore.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.state === ERC8183JobState.EXPIRED) {
      return job;
    }

    if (
      job.state !== ERC8183JobState.OPEN &&
      job.state !== ERC8183JobState.FUNDED &&
      job.state !== ERC8183JobState.SUBMITTED
    ) {
      throw new Error(
        `Cannot expire job in state ${job.state}. Expected ${ERC8183JobState.OPEN}, ${ERC8183JobState.FUNDED}, or ${ERC8183JobState.SUBMITTED}.`,
      );
    }

    job.state = ERC8183JobState.EXPIRED;
    job.metadata.expirationReason = reason ?? 'Job expired due to peer timeout.';
    job.updatedAt = Date.now();
    job.completedAt = Date.now();

    await ctx.jobStore.save(job);
    log.warn(`[ERC-8183] Expired job ${jobId}: ${job.metadata.expirationReason}`);
    return job;
  }

  static async abortJob(
    ctx: ICommerceContext,
    jobId: string,
    reason?: string,
  ): Promise<IErc8183Job> {
    const job = await ctx.jobStore.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.state === ERC8183JobState.ABORTED) {
      return job;
    }

    if (
      job.state === ERC8183JobState.COMPLETE ||
      job.state === ERC8183JobState.REFUND ||
      job.state === ERC8183JobState.TERMINAL
    ) {
      throw new Error(`Cannot abort job in state ${job.state}.`);
    }

    job.state = ERC8183JobState.ABORTED;
    job.metadata.securityAlert = reason ?? 'Security abort triggered by validation failure.';
    job.metadata.maliciousProvider = true;
    job.updatedAt = Date.now();
    job.completedAt = Date.now();

    await ctx.jobStore.save(job);
    log.error(`[SECURITY-ALERT] Aborted job ${jobId}: ${job.metadata.securityAlert}`);
    return job;
  }

  static async evaluateJob(
    ctx: ICommerceContext,
    jobId: string,
    callerAgent: string,
    decision: EvaluationDecision,
    reason?: string,
  ): Promise<IErc8183Job> {
    const job = await ctx.jobStore.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (job.state !== ERC8183JobState.SUBMITTED) {
      throw new Error(`Cannot evaluate job in state ${job.state}. Expected ${ERC8183JobState.SUBMITTED}.`);
    }
    if (callerAgent !== job.evaluatorAgent && callerAgent !== job.clientAgent) {
      throw new Error('Only the evaluator agent or client agent can evaluate this job');
    }

    if (decisionEquals(decision, EvaluationDecision.ACCEPT)) {
      job.state = ERC8183JobState.COMPLETE;
      job.metadata.evaluationReason = reason ?? 'Deliverable accepted by evaluator.';
      job.completedAt = Date.now();
    } else if (decisionEquals(decision, EvaluationDecision.REJECT)) {
      job.state = ERC8183JobState.REFUND;
      job.metadata.refundReason = reason ?? 'Deliverable rejected by evaluator.';
      job.completedAt = Date.now();
    } else {
      job.state = ERC8183JobState.REFUND;
      job.metadata.refundReason = reason ?? 'Partial completion requires refund.';
      job.completedAt = Date.now();
    }

    job.updatedAt = Date.now();
    await ctx.jobStore.save(job);
    log.info(`[ERC-8183] Evaluated job ${jobId}: ${decision} → ${job.state}`);
    return job;
  }

  static async getJobState(
    ctx: ICommerceContext,
    jobId: string,
  ): Promise<ERC8183JobState | null> {
    const job = await ctx.jobStore.get(jobId);
    return job?.state ?? null;
  }
}

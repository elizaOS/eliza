import type { IErc8183Job, ICommerceContext } from './types';
import type { IStvorTransport, IStvorMessage } from './lib/pqc';
import { PayloadHasher } from './lib/pqc';
import { SecurityGuard } from './lib/security';
import { ERC8183StateMachine } from './state-machine';
import { getPluginLogger } from './lib/logger';

export interface ICommerceEventListener {
  onJobCreated(job: IErc8183Job): Promise<void>;
  onJobFunded(job: IErc8183Job): Promise<void>;
  onJobSubmitted(job: IErc8183Job): Promise<void>;
  onJobEvaluated(job: IErc8183Job, decision: string): Promise<void>;
}

export class CommerceTransportBridge implements ICommerceEventListener {
  private readonly transport: IStvorTransport;
  private readonly context: ICommerceContext;
  private readonly hasher = new PayloadHasher();
  private readonly peerTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly responseWindowMs: number;
  private readonly guard: SecurityGuard;
  private readonly log = getPluginLogger();
  private readonly boundMessageHandler: (msg: IStvorMessage) => Promise<void>;

  constructor(
    transport: IStvorTransport,
    context: ICommerceContext,
    responseWindowMs = 15000,
    guard?: SecurityGuard,
  ) {
    this.transport = transport;
    this.context = context;
    this.responseWindowMs = responseWindowMs;
    this.guard = guard ?? new SecurityGuard();

    this.boundMessageHandler = async (msg) => {
      await this.handleIncomingMessage(msg);
    };
    this.transport.onMessage(this.boundMessageHandler);
  }

  async onJobCreated(job: IErc8183Job): Promise<void> {
    this.log.info(
      `[CommerceTransportBridge] Job created: ${job.jobId} (state: ${job.state})`,
    );
  }

  async onJobFunded(job: IErc8183Job): Promise<void> {
    // Exclude metadata to avoid reference aliasing: adding taskPayloadHash to
    // job.metadata would otherwise mutate this object after the hash is computed.
    const taskPayload: Record<string, unknown> = {
      jobId: job.jobId,
      taskDescription: job.taskDescription,
      requiredAmount: job.requiredAmount.toString(),
      clientAgent: job.clientAgent,
      fundedAmount: job.fundedAmount.toString(),
      deadline: Date.now() + 24 * 60 * 60 * 1000,
    };

    const payloadHash = this.hasher.hashPayload(taskPayload);
    job.metadata.taskPayloadHash = payloadHash;
    await this.context.jobStore.save(job);

    const msgId = await this.transport.sendSecurePayload(
      job.providerAgent,
      job.jobId,
      'job_prompt',
      taskPayload,
    );

    this.log.info(
      `[CommerceTransportBridge] Sent task specification to provider (msgId: ${msgId})`,
    );

    this.schedulePeerTimeout(
      job.jobId,
      job.providerAgent,
      `Provider did not acknowledge prompt within ${this.responseWindowMs}ms`,
    );
  }

  async onJobSubmitted(job: IErc8183Job): Promise<void> {
    if (!job.deliverableHash) {
      this.log.warn(`[CommerceTransportBridge] No deliverable hash recorded`);
      return;
    }

    const receivedPayload = job.metadata.deliverablePayload;
    if (!receivedPayload) {
      await ERC8183StateMachine.abortJob(
        this.context,
        job.jobId,
        `[SECURITY-ALERT] Missing deliverable payload for verification on job ${job.jobId}`,
      );
      return;
    }

    if (!PayloadHasher.verifyHash(receivedPayload, job.deliverableHash as string)) {
      await ERC8183StateMachine.abortJob(
        this.context,
        job.jobId,
        `[SECURITY-ALERT] HASH_MISMATCH_ALERT for job ${job.jobId}`,
      );
      return;
    }

    this.schedulePeerTimeout(
      job.jobId,
      job.providerAgent,
      `Deliverable not received by evaluator within ${this.responseWindowMs}ms`,
    );
  }

  async onJobEvaluated(job: IErc8183Job, decision: string): Promise<void> {
    this.clearPeerTimeout(job.jobId);

    if (job.completedAt) {
      const duration = job.completedAt - job.createdAt;
      this.log.info(`[CommerceTransportBridge] Cycle time: ${duration}ms (${decision})`);
    }
  }

  private schedulePeerTimeout(
    jobId: string,
    _peerId: string,
    reason: string,
  ): void {
    this.clearPeerTimeout(jobId);
    const timer = setTimeout(async () => {
      const job = await this.context.jobStore.get(jobId);
      if (!job) return;

      if (job.state === 'FUNDED' || job.state === 'SUBMITTED' || job.state === 'OPEN') {
        await ERC8183StateMachine.refundJob(this.context, jobId, reason);
      }
    }, this.responseWindowMs);

    this.peerTimeouts.set(jobId, timer);
  }

  destroy(): void {
    this.transport.offMessage(this.boundMessageHandler);
    for (const [jobId, timer] of this.peerTimeouts) {
      clearTimeout(timer);
      this.peerTimeouts.delete(jobId);
    }
  }

  private clearPeerTimeout(jobId: string): void {
    const timeout = this.peerTimeouts.get(jobId);
    if (timeout) {
      clearTimeout(timeout);
      this.peerTimeouts.delete(jobId);
    }
  }

  async handleIncomingMessage(msg: IStvorMessage): Promise<void> {
    try {
      this.guard.assertPayloadSafe(msg.content.data);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : '[SECURITY-ALERT] Malicious payload detected';

      if (msg.content.jobId) {
        await ERC8183StateMachine.abortJob(this.context, msg.content.jobId, reason);
      }
      return;
    }

    const job = await this.context.jobStore.get(msg.content.jobId);
    if (!job) {
      this.log.warn(
        `[CommerceTransportBridge] Received message for unknown job ${msg.content.jobId}`,
      );
      return;
    }

    this.clearPeerTimeout(msg.content.jobId);

    if (msg.content.type === 'job_prompt') {
      const expectedHash = job.metadata.taskPayloadHash;
      if (expectedHash && !PayloadHasher.verifyHash(msg.content.data, expectedHash as string)) {
        await ERC8183StateMachine.abortJob(
          this.context,
          job.jobId,
          `[SECURITY-ALERT] HASH_MISMATCH_ALERT for job ${job.jobId}`,
        );
      }
    } else if (msg.content.type === 'job_deliverable') {
      if (!job.deliverableHash) return;

      if (!PayloadHasher.verifyHash(msg.content.data, job.deliverableHash as string)) {
        await ERC8183StateMachine.abortJob(
          this.context,
          job.jobId,
          `[SECURITY-ALERT] HASH_MISMATCH_ALERT for job ${job.jobId}`,
        );
      }
    }
  }
}

export function createCommerceTransportBridge(
  transport: IStvorTransport,
  context: ICommerceContext,
  responseWindowMs = 15000,
  guard?: SecurityGuard,
): ICommerceEventListener {
  return new CommerceTransportBridge(transport, context, responseWindowMs, guard);
}

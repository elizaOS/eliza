import type { IAgentRuntime, UUID } from '@elizaos/core';
import type { IJobStore, IErc8183Job } from '../types';

const JOB_MEMORY_PREFIX = 'erc8183:job:';
const JOB_TABLE = 'memories';

function serializeJob(job: IErc8183Job): string {
  return JSON.stringify({
    ...job,
    requiredAmount: job.requiredAmount.toString(),
    fundedAmount: job.fundedAmount.toString(),
  });
}

function deserializeJob(raw: string): IErc8183Job {
  const data = JSON.parse(raw) as Record<string, unknown>;
  return {
    ...(data as Omit<IErc8183Job, 'requiredAmount' | 'fundedAmount'>),
    requiredAmount: BigInt(data.requiredAmount as string),
    fundedAmount: BigInt(data.fundedAmount as string),
  };
}

/**
 * ElizaOS-backed job store. In-memory cache is the source of truth;
 * ElizaOS memories provide durability across agent restarts.
 */
export class ElizaJobStore implements IJobStore {
  private readonly cache = new Map<string, IErc8183Job>();
  private hydratePromise: Promise<void> | null = null;

  constructor(private readonly runtime: IAgentRuntime) {}

  async save(job: IErc8183Job): Promise<void> {
    this.cache.set(job.jobId, job);
    try {
      await this.runtime.createMemory(
        {
          entityId: this.runtime.agentId as UUID,
          agentId: this.runtime.agentId as UUID,
          roomId: this.runtime.agentId as UUID,
          content: {
            text: `${JOB_MEMORY_PREFIX}${job.jobId}`,
            jobData: serializeJob(job),
          },
        },
        JOB_TABLE,
        false,
      );
    } catch {
      // Persistence is best-effort; in-memory cache remains authoritative.
    }
  }

  async get(jobId: string): Promise<IErc8183Job | null> {
    if (this.cache.has(jobId)) return this.cache.get(jobId) ?? null;
    await this.hydrate();
    return this.cache.get(jobId) ?? null;
  }

  async listByAgent(agentId: string): Promise<IErc8183Job[]> {
    await this.hydrate();
    return Array.from(this.cache.values()).filter(
      (j) => j.clientAgent === agentId || j.providerAgent === agentId,
    );
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.hydratePromise = null;
  }

  private hydrate(): Promise<void> {
    if (!this.hydratePromise) {
      this.hydratePromise = this._doHydrate();
    }
    return this.hydratePromise;
  }

  private async _doHydrate(): Promise<void> {
    try {
      const memories = await this.runtime.getMemories({
        agentId: this.runtime.agentId as UUID,
        tableName: JOB_TABLE,
        count: 1000,
      });
      for (const mem of memories) {
        const text = mem.content.text ?? '';
        const jobData = (mem.content as Record<string, unknown>).jobData as string | undefined;
        if (text.startsWith(JOB_MEMORY_PREFIX) && jobData) {
          try {
            const job = deserializeJob(jobData);
            const existing = this.cache.get(job.jobId);
            if (!existing || job.updatedAt > existing.updatedAt) {
              this.cache.set(job.jobId, job);
            }
          } catch {
            // Skip malformed entries
          }
        }
      }
    } catch {
      // Non-fatal; start with empty cache
    }
  }
}

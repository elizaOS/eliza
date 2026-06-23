import { Service } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import type { IJobStore } from './types';
import type { IReputationProvider } from './reputation/index';
import { StaticReputationProvider } from './reputation/static';
import { ElizaJobStore } from './store/elizaos';
import { MemoryJobStore } from './types';
import { SecurityGuard } from './lib/security';

declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    AGENT_COMMERCE: 'agent_commerce';
  }
}

export const AGENT_COMMERCE_SERVICE_TYPE = 'agent_commerce' as const;

export interface AgentCommerceServiceConfig {
  /** Override the job store (e.g. for testing or custom persistence). */
  jobStore?: IJobStore;
  /** Override the reputation provider. */
  reputationProvider?: IReputationProvider;
  /** Minimum reputation score (0–100) required to fund a job. Reads from runtime setting COMMERCE_MIN_REPUTATION if not set. */
  minReputation?: number;
  /** Strict mode: treat security warnings as errors. Reads from runtime setting STVOR_STRICT_MODE. */
  strictMode?: boolean;
}

export class AgentCommerceService extends Service {
  static override serviceType = AGENT_COMMERCE_SERVICE_TYPE;
  override capabilityDescription =
    'ERC-8183 agentic commerce: job lifecycle management, reputation gating, and payload attestation';

  readonly jobStore: IJobStore;
  readonly reputationProvider: IReputationProvider;
  readonly securityGuard: SecurityGuard;

  constructor(runtime?: IAgentRuntime, config: AgentCommerceServiceConfig = {}) {
    super(runtime);

    const minReputation =
      config.minReputation ??
      Number(runtime?.getSetting('COMMERCE_MIN_REPUTATION') ?? '0');

    const strictMode =
      config.strictMode ??
      (runtime?.getSetting('STVOR_STRICT_MODE') === true ||
        runtime?.getSetting('STVOR_STRICT_MODE') === 'true');

    this.jobStore =
      config.jobStore ?? (runtime ? new ElizaJobStore(runtime) : new MemoryJobStore());
    this.reputationProvider =
      config.reputationProvider ?? new StaticReputationProvider({ minScore: minReputation });
    this.securityGuard = new SecurityGuard({ strictMode });
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    return new AgentCommerceService(runtime);
  }

  override async stop(): Promise<void> {}
}

import { type IAgentRuntime, Service, ServiceType, type UUID, logger } from '@elizaos/core';
import { PrivateKeyAccount } from 'viem';
import { Keypair } from '@solana/web3.js';
import { type RemoteAttestationQuote } from '@elizaos/core';
import { PhalaDeriveKeyProvider } from './providers/deriveKeyProvider';

interface TEEServiceConfig {
  teeMode?: string;
}

export class TEEService extends Service {
  private provider: PhalaDeriveKeyProvider;
  public config: TEEServiceConfig;
  static serviceType = ServiceType.TEE;
  public capabilityDescription = 'Trusted Execution Environment for secure key management';

  constructor(runtime: IAgentRuntime, config: TEEServiceConfig = {}) {
    super(runtime);
    this.config = config;
    const teeMode = config.teeMode || runtime.getSetting('TEE_MODE');
    this.provider = new PhalaDeriveKeyProvider(teeMode);
  }

  static async start(runtime: IAgentRuntime): Promise<TEEService> {
    const teeMode = runtime.getSetting('TEE_MODE');
    logger.log(`Starting TEE service with mode: ${teeMode}`);
    const teeService = new TEEService(runtime, { teeMode });
    return teeService;
  }

  async stop(): Promise<void> {
    logger.log('Stopping TEE service');
    // No cleanup needed for now
  }

  async deriveEcdsaKeypair(
    path: string,
    subject: string,
    agentId: UUID
  ): Promise<{
    keypair: PrivateKeyAccount;
    attestation: RemoteAttestationQuote;
  }> {
    logger.log('TEE Service: Deriving ECDSA keypair');
    return await this.provider.deriveEcdsaKeypair(path, subject, agentId);
  }

  async deriveEd25519Keypair(
    path: string,
    subject: string,
    agentId: UUID
  ): Promise<{
    keypair: Keypair;
    attestation: RemoteAttestationQuote;
  }> {
    logger.log('TEE Service: Deriving Ed25519 keypair');
    return await this.provider.deriveEd25519Keypair(path, subject, agentId);
  }
}

import {
  type IAgentRuntime,
  logger,
  type Metadata,
  Service,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import type { DeriveKeyResponse } from "@phala/dstack-sdk";
import type { Keypair } from "@solana/web3.js";
import type { PrivateKeyAccount } from "viem";
import { PhalaDeriveKeyProvider } from "../providers/deriveKey";
import type { RemoteAttestationQuote, TeeServiceConfig } from "../types";
import { TeeMode, TeeVendor } from "../types";

export class TEEService extends Service {
  private provider: PhalaDeriveKeyProvider;
  static serviceType = ServiceType.TEE;
  public capabilityDescription = "Trusted Execution Environment for secure key management";
  public declare config?: Metadata;

  constructor(runtime: IAgentRuntime, config?: Partial<TeeServiceConfig>) {
    super(runtime);

    const teeModeRaw = config?.mode ?? runtime.getSetting("TEE_MODE") ?? TeeMode.LOCAL;
    const teeMode = typeof teeModeRaw === "string" ? (teeModeRaw as TeeMode) : TeeMode.LOCAL;
    const vendor = config?.vendor ?? TeeVendor.PHALA;
    const secretSaltRaw = config?.secretSalt ?? runtime.getSetting("WALLET_SECRET_SALT");
    const secretSalt = typeof secretSaltRaw === "string" ? secretSaltRaw : undefined;

    // Set config as Metadata-compatible object
    this.config = {
      mode: teeMode,
      vendor,
      ...(secretSalt ? { secretSalt } : {}),
    } as Metadata;

    this.provider = new PhalaDeriveKeyProvider(teeMode);
  }

  static async start(runtime: IAgentRuntime): Promise<TEEService> {
    const teeModeRaw = runtime.getSetting("TEE_MODE") ?? TeeMode.LOCAL;
    const teeMode = typeof teeModeRaw === "string" ? (teeModeRaw as TeeMode) : TeeMode.LOCAL;
    logger.info(`Starting TEE service with mode: ${teeMode}`);
    const service = new TEEService(runtime, { mode: teeMode });
    return service;
  }

  async stop(): Promise<void> {
    logger.info("Stopping TEE service");
  }

  async deriveEcdsaKeypair(
    path: string,
    subject: string,
    agentId: UUID
  ): Promise<{
    keypair: PrivateKeyAccount;
    attestation: RemoteAttestationQuote;
  }> {
    return this.provider.deriveEcdsaKeypair(path, subject, agentId);
  }

  async deriveEd25519Keypair(
    path: string,
    subject: string,
    agentId: UUID
  ): Promise<{
    keypair: Keypair;
    attestation: RemoteAttestationQuote;
  }> {
    return this.provider.deriveEd25519Keypair(path, subject, agentId);
  }

  async rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResponse> {
    return this.provider.rawDeriveKeyResponse(path, subject);
  }
}

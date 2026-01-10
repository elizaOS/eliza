/**
 * TEE Service for elizaOS.
 */

import { type IAgentRuntime, Service, ServiceType, type UUID, logger } from "@elizaos/core";
import type { PrivateKeyAccount } from "viem";
import type { Keypair } from "@solana/web3.js";
import type { DeriveKeyResponse } from "@phala/dstack-sdk";
import type { RemoteAttestationQuote, TeeServiceConfig } from "../types";
import { TeeMode, TeeVendor } from "../types";
import { PhalaDeriveKeyProvider } from "../providers/deriveKey";

/**
 * TEE Service for secure key management within a Trusted Execution Environment.
 *
 * This service provides:
 * - Ed25519 key derivation (for Solana)
 * - ECDSA key derivation (for EVM chains)
 * - Raw key derivation for custom use cases
 * - Remote attestation for all derived keys
 */
export class TEEService extends Service {
  private provider: PhalaDeriveKeyProvider;
  public config: TeeServiceConfig;
  static serviceType = ServiceType.TEE;
  public capabilityDescription = "Trusted Execution Environment for secure key management";

  constructor(runtime: IAgentRuntime, config?: Partial<TeeServiceConfig>) {
    super(runtime);

    const teeMode = config?.mode ?? runtime.getSetting("TEE_MODE") ?? TeeMode.LOCAL;
    const vendor = config?.vendor ?? TeeVendor.PHALA;
    const secretSalt = config?.secretSalt ?? runtime.getSetting("WALLET_SECRET_SALT");

    this.config = {
      mode: teeMode as TeeMode,
      vendor,
      secretSalt,
    };

    this.provider = new PhalaDeriveKeyProvider(teeMode);
  }

  /**
   * Start the TEE service.
   */
  static async start(runtime: IAgentRuntime): Promise<TEEService> {
    const teeMode = runtime.getSetting("TEE_MODE") ?? TeeMode.LOCAL;
    logger.info(`Starting TEE service with mode: ${teeMode}`);
    const service = new TEEService(runtime, { mode: teeMode as TeeMode });
    return service;
  }

  /**
   * Stop the TEE service.
   */
  async stop(): Promise<void> {
    logger.info("Stopping TEE service");
    // No cleanup needed currently
  }

  /**
   * Derive an ECDSA keypair for EVM chains.
   *
   * @param path - The derivation path (e.g., secret salt).
   * @param subject - The subject for the certificate chain (e.g., "evm").
   * @param agentId - The agent ID for attestation.
   * @returns The keypair and attestation.
   */
  async deriveEcdsaKeypair(
    path: string,
    subject: string,
    agentId: UUID
  ): Promise<{
    keypair: PrivateKeyAccount;
    attestation: RemoteAttestationQuote;
  }> {
    logger.debug("TEE Service: Deriving ECDSA keypair");
    return this.provider.deriveEcdsaKeypair(path, subject, agentId);
  }

  /**
   * Derive an Ed25519 keypair for Solana.
   *
   * @param path - The derivation path (e.g., secret salt).
   * @param subject - The subject for the certificate chain (e.g., "solana").
   * @param agentId - The agent ID for attestation.
   * @returns The keypair and attestation.
   */
  async deriveEd25519Keypair(
    path: string,
    subject: string,
    agentId: UUID
  ): Promise<{
    keypair: Keypair;
    attestation: RemoteAttestationQuote;
  }> {
    logger.debug("TEE Service: Deriving Ed25519 keypair");
    return this.provider.deriveEd25519Keypair(path, subject, agentId);
  }

  /**
   * Derive a raw key for custom use cases.
   *
   * @param path - The derivation path.
   * @param subject - The subject for the certificate chain.
   * @returns The raw DeriveKeyResponse from DStack SDK.
   */
  async rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResponse> {
    logger.debug("TEE Service: Deriving raw key");
    return this.provider.rawDeriveKeyResponse(path, subject);
  }
}


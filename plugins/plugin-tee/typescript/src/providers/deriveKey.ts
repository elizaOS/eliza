/**
 * Key Derivation Provider for Phala TEE.
 */

import { type Provider, type IAgentRuntime, type Memory, logger } from "@elizaos/core";
import { TappdClient, type DeriveKeyResponse } from "@phala/dstack-sdk";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import { Keypair } from "@solana/web3.js";
import crypto from "node:crypto";
import type {
  RemoteAttestationQuote,
  DeriveKeyAttestationData,
  DeriveKeyResult,
  TeeProviderResult,
} from "../types";
import { getTeeEndpoint } from "../utils";
import { DeriveKeyProvider } from "./base";
import { PhalaRemoteAttestationProvider } from "./remoteAttestation";

/**
 * Phala Network Key Derivation Provider.
 *
 * Derives cryptographic keys within the TEE using Phala's DStack SDK.
 */
export class PhalaDeriveKeyProvider extends DeriveKeyProvider {
  private readonly client: TappdClient;
  private readonly raProvider: PhalaRemoteAttestationProvider;

  constructor(teeMode: string) {
    super();
    const endpoint = getTeeEndpoint(teeMode);

    logger.info(
      endpoint
        ? `TEE: Connecting to key derivation service at ${endpoint}`
        : "TEE: Running key derivation in production mode"
    );

    this.client = endpoint ? new TappdClient(endpoint) : new TappdClient();
    this.raProvider = new PhalaRemoteAttestationProvider(teeMode);
  }

  /**
   * Generate attestation for derived key.
   */
  private async generateDeriveKeyAttestation(
    agentId: string,
    publicKey: string,
    subject?: string
  ): Promise<RemoteAttestationQuote> {
    const deriveKeyData: DeriveKeyAttestationData = {
      agentId,
      publicKey,
      subject,
    };

    logger.debug("Generating attestation for derived key...");
    const quote = await this.raProvider.generateAttestation(JSON.stringify(deriveKeyData));
    logger.info("Key derivation attestation generated successfully");
    return quote;
  }

  /**
   * Derive a raw key from the TEE.
   *
   * @param path - The derivation path.
   * @param subject - The subject for the certificate chain.
   * @returns The derived key response.
   */
  async rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResult> {
    if (!path || !subject) {
      throw new Error("Path and subject are required for key derivation");
    }

    try {
      logger.debug("Deriving raw key in TEE...");
      const response: DeriveKeyResponse = await this.client.deriveKey(path, subject);

      logger.info("Raw key derived successfully");
      return {
        key: response.asUint8Array(),
        certificateChain: [], // DStack SDK doesn't expose certificate chain directly
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error deriving raw key: ${message}`);
      throw error;
    }
  }

  /**
   * Derive the raw DeriveKeyResponse for advanced use cases.
   *
   * @param path - The derivation path.
   * @param subject - The subject for the certificate chain.
   * @returns The raw DeriveKeyResponse from DStack SDK.
   */
  async rawDeriveKeyResponse(path: string, subject: string): Promise<DeriveKeyResponse> {
    if (!path || !subject) {
      throw new Error("Path and subject are required for key derivation");
    }

    logger.debug("Deriving raw key response in TEE...");
    const response = await this.client.deriveKey(path, subject);
    logger.info("Raw key response derived successfully");
    return response;
  }

  /**
   * Derive an Ed25519 keypair (for Solana).
   *
   * @param path - The derivation path.
   * @param subject - The subject for the certificate chain.
   * @param agentId - The agent ID for attestation.
   * @returns The keypair and attestation.
   */
  async deriveEd25519Keypair(
    path: string,
    subject: string,
    agentId: string
  ): Promise<{ keypair: Keypair; attestation: RemoteAttestationQuote }> {
    if (!path || !subject) {
      throw new Error("Path and subject are required for key derivation");
    }

    try {
      logger.debug("Deriving Ed25519 key in TEE...");

      const derivedKey = await this.client.deriveKey(path, subject);
      const uint8ArrayDerivedKey = derivedKey.asUint8Array();

      // Hash the derived key to get a proper 32-byte seed
      const hash = crypto.createHash("sha256");
      hash.update(uint8ArrayDerivedKey);
      const seed = new Uint8Array(hash.digest());

      const keypair = Keypair.fromSeed(seed.slice(0, 32));

      // Generate attestation for the derived public key
      const attestation = await this.generateDeriveKeyAttestation(
        agentId,
        keypair.publicKey.toBase58(),
        subject
      );

      logger.info("Ed25519 key derived successfully");
      return { keypair, attestation };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error deriving Ed25519 key: ${message}`);
      throw error;
    }
  }

  /**
   * Derive an ECDSA keypair (for EVM).
   *
   * @param path - The derivation path.
   * @param subject - The subject for the certificate chain.
   * @param agentId - The agent ID for attestation.
   * @returns The keypair and attestation.
   */
  async deriveEcdsaKeypair(
    path: string,
    subject: string,
    agentId: string
  ): Promise<{ keypair: PrivateKeyAccount; attestation: RemoteAttestationQuote }> {
    if (!path || !subject) {
      throw new Error("Path and subject are required for key derivation");
    }

    try {
      logger.debug("Deriving ECDSA key in TEE...");

      const derivedKey: DeriveKeyResponse = await this.client.deriveKey(path, subject);
      const hex = keccak256(derivedKey.asUint8Array());
      const keypair: PrivateKeyAccount = privateKeyToAccount(hex);

      // Generate attestation for the derived address
      const attestation = await this.generateDeriveKeyAttestation(
        agentId,
        keypair.address,
        subject
      );

      logger.info("ECDSA key derived successfully");
      return { keypair, attestation };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error deriving ECDSA key: ${message}`);
      throw error;
    }
  }
}

/**
 * elizaOS Provider for key derivation.
 *
 * This provider derives Solana and EVM keypairs for the agent.
 */
export const phalaDeriveKeyProvider: Provider = {
  name: "phala-derive-key",

  get: async (runtime: IAgentRuntime, _message?: Memory): Promise<TeeProviderResult> => {
    const teeMode = runtime.getSetting("TEE_MODE");
    if (!teeMode) {
      return {
        data: null,
        values: {},
        text: "TEE_MODE is not configured",
      };
    }

    const secretSalt = runtime.getSetting("WALLET_SECRET_SALT");
    if (!secretSalt) {
      logger.error("WALLET_SECRET_SALT is not configured");
      return {
        data: null,
        values: {},
        text: "WALLET_SECRET_SALT is not configured in settings",
      };
    }

    const provider = new PhalaDeriveKeyProvider(teeMode);
    const agentId = runtime.agentId;

    try {
      const solanaKeypair = await provider.deriveEd25519Keypair(secretSalt, "solana", agentId);
      const evmKeypair = await provider.deriveEcdsaKeypair(secretSalt, "evm", agentId);

      const walletData = {
        solana: solanaKeypair.keypair.publicKey.toBase58(),
        evm: evmKeypair.keypair.address,
      };

      const values = {
        solana_public_key: solanaKeypair.keypair.publicKey.toBase58(),
        evm_address: evmKeypair.keypair.address,
      };

      const text = `Solana Public Key: ${values.solana_public_key}\nEVM Address: ${values.evm_address}`;

      return {
        data: walletData,
        values,
        text,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error in derive key provider: ${message}`);
      return {
        data: null,
        values: {},
        text: `Failed to derive keys: ${message}`,
      };
    }
  },
};



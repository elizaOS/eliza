import crypto from "node:crypto";
import { type IAgentRuntime, logger, type Memory, type Provider } from "@elizaos/core";
import { type DeriveKeyResponse, TappdClient } from "@phala/dstack-sdk";
import { Keypair } from "@solana/web3.js";
import { keccak256 } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import type {
  DeriveKeyAttestationData,
  DeriveKeyResult,
  RemoteAttestationQuote,
  TeeProviderResult,
} from "../types";
import { getTeeEndpoint } from "../utils";
import { DeriveKeyProvider } from "./base";
import { PhalaRemoteAttestationProvider } from "./remoteAttestation";

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
    return this.raProvider.generateAttestation(JSON.stringify(deriveKeyData));
  }

  async rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResult> {
    if (!path || !subject) {
      throw new Error("Path and subject are required for key derivation");
    }

    try {
      const response: DeriveKeyResponse = await this.client.deriveKey(path, subject);
      return {
        key: response.asUint8Array(),
        certificateChain: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error deriving raw key: ${message}`);
      throw error;
    }
  }

  async rawDeriveKeyResponse(path: string, subject: string): Promise<DeriveKeyResponse> {
    if (!path || !subject) {
      throw new Error("Path and subject are required for key derivation");
    }
    return this.client.deriveKey(path, subject);
  }

  async deriveEd25519Keypair(
    path: string,
    subject: string,
    agentId: string
  ): Promise<{ keypair: Keypair; attestation: RemoteAttestationQuote }> {
    if (!path || !subject) {
      throw new Error("Path and subject are required for key derivation");
    }

    try {
      const derivedKey = await this.client.deriveKey(path, subject);
      const uint8ArrayDerivedKey = derivedKey.asUint8Array();

      const hash = crypto.createHash("sha256");
      hash.update(uint8ArrayDerivedKey);
      const seed = new Uint8Array(hash.digest());

      const keypair = Keypair.fromSeed(seed.slice(0, 32));

      const attestation = await this.generateDeriveKeyAttestation(
        agentId,
        keypair.publicKey.toBase58(),
        subject
      );

      return { keypair, attestation };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error deriving Ed25519 key: ${message}`);
      throw error;
    }
  }

  async deriveEcdsaKeypair(
    path: string,
    subject: string,
    agentId: string
  ): Promise<{
    keypair: PrivateKeyAccount;
    attestation: RemoteAttestationQuote;
  }> {
    if (!path || !subject) {
      throw new Error("Path and subject are required for key derivation");
    }

    try {
      const derivedKey: DeriveKeyResponse = await this.client.deriveKey(path, subject);
      const hex = keccak256(derivedKey.asUint8Array());
      const keypair: PrivateKeyAccount = privateKeyToAccount(hex);

      const attestation = await this.generateDeriveKeyAttestation(
        agentId,
        keypair.address,
        subject
      );

      return { keypair, attestation };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error deriving ECDSA key: ${message}`);
      throw error;
    }
  }
}

export const phalaDeriveKeyProvider: Provider = {
  name: "phala-derive-key",

  get: async (runtime: IAgentRuntime, _message?: Memory): Promise<TeeProviderResult> => {
    const teeModeRaw = runtime.getSetting("TEE_MODE");
    if (!teeModeRaw) {
      return {
        data: null,
        values: {},
        text: "TEE_MODE is not configured",
      };
    }
    const teeMode = typeof teeModeRaw === "string" ? teeModeRaw : String(teeModeRaw);

    const secretSaltRaw = runtime.getSetting("WALLET_SECRET_SALT");
    if (!secretSaltRaw) {
      logger.error("WALLET_SECRET_SALT is not configured");
      return {
        data: null,
        values: {},
        text: "WALLET_SECRET_SALT is not configured in settings",
      };
    }
    const secretSalt = typeof secretSaltRaw === "string" ? secretSaltRaw : String(secretSaltRaw);

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

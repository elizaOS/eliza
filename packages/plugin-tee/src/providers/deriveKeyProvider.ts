import { type IAgentRuntime, type Memory, type Provider, type State, logger } from '@elizaos/core';
import { type DeriveKeyAttestationData, type RemoteAttestationQuote, TEEMode } from '@elizaos/core';
import { type DeriveKeyResponse, TappdClient } from '@phala/dstack-sdk';
import { Keypair } from '@solana/web3.js';
import { toViemAccount } from '@phala/dstack-sdk/viem';
import { toKeypair } from '@phala/dstack-sdk/solana';
import { DeriveKeyProvider } from './base';
import { PhalaRemoteAttestationProvider as RemoteAttestationProvider } from './remoteAttestationProvider';

/**
 * Phala TEE Cloud Provider
 * @example
 * ```ts
 * const provider = new PhalaDeriveKeyProvider(runtime.getSetting('TEE_MODE'));
 * ```
 */
/**
 * A class representing a key provider for deriving keys in the Phala TEE environment.
 * Extends the DeriveKeyProvider class.
 */
class PhalaDeriveKeyProvider extends DeriveKeyProvider {
  private client: TappdClient;
  private raProvider: RemoteAttestationProvider;

  constructor(teeMode?: string) {
    super();
    let endpoint: string | undefined;

    // Both LOCAL and DOCKER modes use the simulator, just with different endpoints
    switch (teeMode) {
      case TEEMode.LOCAL:
        endpoint = 'http://localhost:8090';
        logger.log('TEE: Connecting to local simulator at localhost:8090');
        break;
      case TEEMode.DOCKER:
        endpoint = 'http://host.docker.internal:8090';
        logger.log('TEE: Connecting to simulator via Docker at host.docker.internal:8090');
        break;
      case TEEMode.PRODUCTION:
        endpoint = undefined;
        logger.log('TEE: Running in production mode without simulator');
        break;
      default:
        throw new Error(`Invalid TEE_MODE: ${teeMode}. Must be one of: LOCAL, DOCKER, PRODUCTION`);
    }

    this.client = endpoint ? new TappdClient(endpoint) : new TappdClient();
    this.raProvider = new RemoteAttestationProvider(teeMode);
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
    const reportdata = JSON.stringify(deriveKeyData);
    logger.log('Generating Remote Attestation Quote for Derive Key...');
    const quote = await this.raProvider.generateAttestation(reportdata);
    logger.log('Remote Attestation Quote generated successfully!');
    return quote;
  }

  /**
   * Derives a raw key from the given path and subject.
   * @param path - The path to derive the key from. This is used to derive the key from the root of trust.
   * @param subject - The subject to derive the key from. This is used for the certificate chain.
   * @returns The derived key.
   */
  async rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResponse> {
    try {
      if (!path || !subject) {
        logger.error('Path and Subject are required for key derivation');
      }

      logger.log('Deriving Raw Key in TEE...');
      const derivedKey = await this.client.deriveKey(path, subject);

      logger.log('Raw Key Derived Successfully!');
      return derivedKey;
    } catch (error) {
      logger.error('Error deriving raw key:', error);
      throw error;
    }
  }

  /**
   * Derives an Ed25519 keypair from the given path and subject.
   * @param path - The path to derive the key from. This is used to derive the key from the root of trust.
   * @param subject - The subject to derive the key from. This is used for the certificate chain.
   * @param agentId - The agent ID to generate an attestation for.
   * @returns An object containing the derived keypair and attestation.
   */
  async deriveEd25519Keypair(
    path: string,
    subject: string,
    agentId: string
  ): Promise<{ keypair: Keypair; attestation: RemoteAttestationQuote }> {
    try {
      if (!path || !subject) {
        logger.error('Path and Subject are required for key derivation');
      }

      logger.log('Deriving Key in TEE...');
      const derivedKey = await this.client.deriveKey(path, subject);
      const keypair = toKeypair(derivedKey);

      // Generate an attestation for the derived key data for public to verify
      const attestation = await this.generateDeriveKeyAttestation(
        agentId,
        keypair.publicKey.toBase58()
      );
      logger.log('Key Derived Successfully!');

      return { keypair, attestation };
    } catch (error) {
      logger.error('Error deriving key:', error);
      throw error;
    }
  }

  /**
   * Derives an ECDSA keypair from the given path and subject.
   * @param path - The path to derive the key from. This is used to derive the key from the root of trust.
   * @param subject - The subject to derive the key from. This is used for the certificate chain.
   * @param agentId - The agent ID to generate an attestation for. This is used for the certificate chain.
   * @returns An object containing the derived keypair and attestation.
   */
  async deriveEcdsaKeypair(
    path: string,
    subject: string,
    agentId: string
  ): Promise<{
    keypair: PrivateKeyAccount;
    attestation: RemoteAttestationQuote;
  }> {
    try {
      if (!path || !subject) {
        logger.error('Path and Subject are required for key derivation');
      }

      logger.log('Deriving ECDSA Key in TEE...');
      const deriveKeyResponse: DeriveKeyResponse = await this.client.deriveKey(path, subject);
      const keypair = toViemAccount(deriveKeyResponse);

      // Generate an attestation for the derived key data for public to verify
      const attestation = await this.generateDeriveKeyAttestation(agentId, keypair.address);
      logger.log('ECDSA Key Derived Successfully!');

      return { keypair, attestation };
    } catch (error) {
      logger.error('Error deriving ecdsa key:', error);
      throw error;
    }
  }
}

// Define the ProviderResult interface if not already imported
interface ProviderResult {
  data?: any;
  values?: Record<string, string>;
  text?: string;
}

const phalaDeriveKeyProvider: Provider = {
  name: 'phala-derive-key',
  get: async (runtime: IAgentRuntime, _message?: Memory): Promise<ProviderResult> => {
    const teeMode = runtime.getSetting('TEE_MODE');
    const provider = new PhalaDeriveKeyProvider(teeMode);
    const agentId = runtime.agentId;
    try {
      // Validate wallet configuration
      if (!runtime.getSetting('WALLET_SECRET_SALT')) {
        logger.error('Wallet secret salt is not configured in settings');
        return {
          data: null,
          values: {},
          text: 'Wallet secret salt is not configured in settings',
        };
      }

      try {
        const secretSalt = runtime.getSetting('WALLET_SECRET_SALT') || 'secret_salt';
        const solanaKeypair = await provider.deriveEd25519Keypair(secretSalt, 'solana', agentId);
        const evmKeypair = await provider.deriveEcdsaKeypair(secretSalt, 'evm', agentId);

        // Original data structure
        const walletData = {
          solana: solanaKeypair.keypair.publicKey,
          evm: evmKeypair.keypair.address,
        };

        // Values for template injection
        const values = {
          solana_public_key: solanaKeypair.keypair.publicKey.toString(),
          evm_address: evmKeypair.keypair.address,
        };

        // Text representation
        const text = `Solana Public Key: ${values.solana_public_key}\nEVM Address: ${values.evm_address}`;

        return {
          data: walletData,
          values: values,
          text: text,
        };
      } catch (error) {
        logger.error('Error creating PublicKey:', error);
        return {
          data: null,
          values: {},
          text: `Error creating PublicKey: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        };
      }
    } catch (error) {
      logger.error('Error in derive key provider:', error.message);
      return {
        data: null,
        values: {},
        text: `Failed to fetch derive key information: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      };
    }
  },
};

export { phalaDeriveKeyProvider, PhalaDeriveKeyProvider };

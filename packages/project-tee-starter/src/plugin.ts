import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, logger } from '@elizaos/core';
import { z } from 'zod';
import { type DeriveKeyResponse, TappdClient } from '@phala/dstack-sdk';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { Keypair } from '@solana/web3.js';
import crypto from 'node:crypto';

// Create a custom TEE Client to make calls to the TEE through the Dstack SDK.

/**
 * Define the configuration schema for the plugin with the following properties:
 *
 * @param {string} WALLET_SECRET_SALT - The secret salt for the wallet (min length of 1, optional)
 * @returns {object} - The configured schema object
 */
const configSchema = z.object({
  WALLET_SECRET_SALT: z
    .string()
    .min(1, 'Wallet secret salt is not provided')
    .optional()
    .transform((val) => {
      if (!val) {
        logger.warn('Warning: Wallet secret salt is not provided');
      }
      return val;
    }),
});

// Functional TEE service configuration
type TeeServiceConfig = {
  teeClient: TappdClient;
  secretSalt: string;
  runtime: IAgentRuntime;
};

/**
 * Creates a TEE service configuration object
 */
const createTeeServiceConfig = (runtime: IAgentRuntime): TeeServiceConfig => ({
  teeClient: new TappdClient(),
  secretSalt: process.env.WALLET_SECRET_SALT || 'secret_salt',
  runtime,
});

/**
 * Derives ECDSA keypair from TEE response
 */
const deriveEcdsaKeypair = (deriveKeyResponse: DeriveKeyResponse): PrivateKeyAccount => {
  const hex = keccak256(deriveKeyResponse.asUint8Array());
  return privateKeyToAccount(hex);
};

/**
 * Derives ED25519 keypair from TEE response
 */
const deriveEd25519Keypair = (deriveKeyResponse: DeriveKeyResponse): Keypair => {
  const uint8ArrayDerivedKey = deriveKeyResponse.asUint8Array();
  const hash = crypto.createHash('sha256');
  hash.update(uint8ArrayDerivedKey);
  const seed = hash.digest();
  const seedArray = new Uint8Array(seed);
  return Keypair.fromSeed(seedArray.slice(0, 32));
};

/**
 * Handles TEE key derivation and logging
 */
const handleTeeKeyDerivation = async (config: TeeServiceConfig): Promise<void> => {
  try {
    const deriveKeyResponse: DeriveKeyResponse = await config.teeClient.deriveKey(
      config.secretSalt
    );

    // ECDSA Key
    const ecdsaKeypair = deriveEcdsaKeypair(deriveKeyResponse);

    // ED25519 Key
    const ed25519Keypair = deriveEd25519Keypair(deriveKeyResponse);

    logger.log('ECDSA Key Derived Successfully!');
    logger.log('ECDSA Keypair:', ecdsaKeypair.address);
    logger.log('ED25519 Keypair:', ed25519Keypair.publicKey);
    
    const signature = await ecdsaKeypair.signMessage({ message: 'Hello, world!' });
    logger.log('Sign message w/ ECDSA keypair: Hello world!, Signature: ', signature);
  } catch (error) {
    // Handle TEE connection errors gracefully
    if (error instanceof Error && error.message.includes('ENOENT')) {
      logger.warn('TEE daemon not available - running in non-TEE mode for testing');
      logger.warn('To run with TEE, ensure tappd is running at /var/run/tappd.sock');
    } else {
      logger.error('Error connecting to TEE:', error);
    }
    // Continue without TEE functionality for testing
  }
};

/**
 * Starts the TEE starter service using functional approach
 */
const startTeeService = async (runtime: IAgentRuntime): Promise<TeeServiceConfig> => {
  logger.info("*** Starting Mr. TEE's custom service (Functional) ***");
  
  const config = createTeeServiceConfig(runtime);
  await handleTeeKeyDerivation(config);
  
  return config;
};

/**
 * Stops the TEE starter service using functional approach
 */
const stopTeeService = async (runtime: IAgentRuntime): Promise<void> => {
  logger.info("*** Stopping Mr. TEE's custom service (Functional) ***");
  // In functional approach, cleanup is handled here if needed
  // No explicit service instance to stop
};

/**
 * TEE starter service factory function
 */
export const createTeeStarterService = () => ({
  serviceType: 'starter',
  capabilityDescription: 'This is a starter service, can be customized for Mr. TEE.',
  start: startTeeService,
  stop: stopTeeService,
});

const teeStarterPlugin: Plugin = {
  name: 'mr-tee-starter-plugin',
  description: "Mr. TEE's starter plugin - using plugin-tee for attestation",
  config: {
    TEE_MODE: process.env.TEE_MODE,
    WALLET_SECRET_SALT: process.env.WALLET_SECRET_SALT,
  },
  async init(config: Record<string, string>) {
    logger.info('*** Initializing Mr. TEE plugin ***');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  routes: [
    {
      name: 'mr-tee-status-route',
      path: '/mr-tee-status',
      type: 'GET',
      handler: async (
        _req: Record<string, unknown>,
        res: { json: (data: Record<string, unknown>) => void }
      ) => {
        res.json({
          message: 'Mr. TEE is operational, fool!',
          tee_mode: process.env.TEE_MODE || 'NOT SET',
          tee_vendor: process.env.TEE_VENDOR || 'NOT SET',
        });
      },
    },
  ],
  events: {
    MESSAGE_RECEIVED: [
      async (params) => {
        logger.info(
          '[MR_TEE_PLUGIN] MESSAGE_RECEIVED event',
          params.message?.content?.text?.substring(0, 50)
        );
      },
    ],
    VOICE_MESSAGE_RECEIVED: [
      async (params) => {
        logger.info('[MR_TEE_PLUGIN] VOICE_MESSAGE_RECEIVED event');
      },
    ],
    WORLD_CONNECTED: [
      async (params) => {
        logger.info('[MR_TEE_PLUGIN] WORLD_CONNECTED event');
      },
    ],
    WORLD_JOINED: [
      async (params) => {
        logger.info('[MR_TEE_PLUGIN] WORLD_JOINED event');
      },
    ],
  },
  // Enable this service to run when TEE mode is enabled
  services: [
    /* createTeeStarterService() */
  ],
  actions: [],
  providers: [],
};

export default teeStarterPlugin;

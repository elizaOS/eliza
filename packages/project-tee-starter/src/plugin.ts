import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, logger, Service } from '@elizaos/core';
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
 * @param {string} TEE_MODE - The TEE mode (OFF, LOCAL, DOCKER, PRODUCTION)
 * @param {string} TEE_VENDOR - The TEE vendor (must be 'phala')
 * @param {string} WALLET_SECRET_SALT - The secret salt for the wallet (min length of 8)
 * @returns {object} - The configured schema object
 */
const configSchema = z.object({
  TEE_MODE: z
    .string()
    .optional()
    .transform((val) => {
      // Provide test defaults when NODE_ENV is test
      if (process.env.NODE_ENV === 'test' && !val) {
        return 'OFF';
      }
      return val;
    })
    .refine(
      (val) => {
        if (!val) return true; // Allow undefined in non-test environments
        return ['OFF', 'LOCAL', 'DOCKER', 'PRODUCTION'].includes(val);
      },
      { message: 'TEE_MODE must be one of: OFF, LOCAL, DOCKER, PRODUCTION' }
    ),

  TEE_VENDOR: z
    .string()
    .optional()
    .transform((val) => {
      // Provide test defaults when NODE_ENV is test
      if (process.env.NODE_ENV === 'test' && !val) {
        return 'phala';
      }
      return val;
    })
    .refine(
      (val) => {
        if (!val) return true; // Allow undefined in non-test environments
        return val === 'phala';
      },
      { message: 'TEE_VENDOR must be: phala' }
    ),

  WALLET_SECRET_SALT: z
    .string()
    .optional()
    .transform((val) => {
      // SECURITY WARNING: Test defaults are ONLY for test environments
      // NEVER use these defaults in production - always provide a secure salt
      if (process.env.NODE_ENV === 'test' && !val) {
        logger.debug('Using test default for WALLET_SECRET_SALT - NEVER use in production');
        return 'test_default_salt_12345';
      }
      if (!val) {
        logger.warn('Warning: Wallet secret salt is not provided');
        return val;
      }
      // Trim whitespace to prevent security bypass
      return val.trim();
    })
    .refine(
      (val) => {
        if (val === undefined) return true; // Allow undefined in non-test environments
        // Empty string after trimming is not allowed (reject whitespace-only values)
        if (!val || val.length === 0) return false;
        // Check trimmed length for security (val is already trimmed from transform)
        return val.length >= 8;
      },
      {
        message:
          'Wallet secret salt must be at least 8 characters long for security (excluding whitespace)',
      }
    )
    .refine(
      (val) => {
        if (val === undefined) return true; // Allow undefined in non-test environments
        // Empty strings not allowed (already checked in previous refine, but be consistent)
        if (!val || val.length === 0) return false;
        // Check trimmed length (val is already trimmed from transform)
        return val.length <= 128;
      },
      { message: 'Wallet secret salt must not exceed 128 characters (excluding whitespace)' }
    ),
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
  // Ensure salt is trimmed to match validation behavior
  secretSalt: (process.env.WALLET_SECRET_SALT || 'secret_salt').trim(),
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
 * Checks if an error is a TEE connection error
 * @param error The error to check
 * @returns True if the error is a TEE connection error
 */
const isTeeConnectionError = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    (error.message.includes('ENOENT') || error.message.includes('Failed to connect'))
  );
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
    logger.log({ address: ecdsaKeypair.address }, 'ECDSA Keypair:');
    logger.log({ publicKey: ed25519Keypair.publicKey }, 'ED25519 Keypair:');

    const signature = await ecdsaKeypair.signMessage({ message: 'Hello, world!' });
    logger.log({ signature }, 'Sign message w/ ECDSA keypair: Hello world!, Signature:');
  } catch (error) {
    // Handle TEE connection errors gracefully
    if (isTeeConnectionError(error)) {
      logger.warn('TEE daemon not available - running in non-TEE mode for testing');
      logger.warn('To run with TEE, ensure tappd is running at /var/run/tappd.sock');
    } else {
      logger.warn({ error }, 'TEE daemon connection failed, running in non-TEE mode:');
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
 * StarterService class for TEE functionality
 */
export class StarterService extends Service {
  public static serviceType = 'starter';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<StarterService> {
    const service = new StarterService(runtime);
    await startTeeService(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await stopTeeService(this.runtime);
  }

  public get capabilityDescription(): string {
    return 'This is a starter service, can be customized for Mr. TEE.';
  }
}

const teeStarterPlugin: Plugin = {
  name: 'mr-tee-starter-plugin',
  description: "Mr. TEE's starter plugin - using plugin-tee for attestation",
  // Use dynamic getters so tests/CI always see current env values
  config: Object.defineProperties(
    {},
    {
      TEE_MODE: {
        get: () => process.env.TEE_MODE,
        enumerable: true,
      },
      TEE_VENDOR: {
        get: () => process.env.TEE_VENDOR,
        enumerable: true,
      },
      WALLET_SECRET_SALT: {
        get: () => process.env.WALLET_SECRET_SALT,
        enumerable: true,
      },
    }
  ) as Record<string, string>,
  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    logger.info('*** Initializing Mr. TEE plugin ***');
    try {
      // Merge process.env values with config, config takes precedence
      const rawConfig = {
        TEE_MODE: config.TEE_MODE ?? process.env.TEE_MODE,
        TEE_VENDOR: config.TEE_VENDOR ?? process.env.TEE_VENDOR,
        WALLET_SECRET_SALT: config.WALLET_SECRET_SALT ?? process.env.WALLET_SECRET_SALT,
      };

      // Parse and validate configuration with schema (includes test defaults)
      const validatedConfig = configSchema.parse(rawConfig);

      // Production safety check - ensure test defaults aren't used in production
      if (
        process.env.NODE_ENV === 'production' &&
        validatedConfig.WALLET_SECRET_SALT === 'test_default_salt_12345'
      ) {
        throw new Error(
          'CRITICAL: Test salt detected in production environment. Please provide a secure WALLET_SECRET_SALT.'
        );
      }

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Check if this is validation with an invalid TEE_MODE from the test
        const hasInvalidMode = error.issues.some(
          (e) => e.path[0] === 'TEE_MODE' && e.message.includes('TEE_MODE must be')
        );
        if (hasInvalidMode) {
          // Throw the specific validation error for TEE_MODE
          const teeError = error.issues.find((e) => e.path[0] === 'TEE_MODE');
          throw new Error(
            teeError?.message || 'TEE_MODE must be one of: OFF, LOCAL, DOCKER, PRODUCTION'
          );
        }

        // Check if this is validation with an invalid TEE_VENDOR from the test
        const hasInvalidVendor = error.issues.some(
          (e) => e.path[0] === 'TEE_VENDOR' && e.message.includes('TEE_VENDOR must be')
        );
        if (hasInvalidVendor) {
          const vendorError = error.issues.find((e) => e.path[0] === 'TEE_VENDOR');
          throw new Error(vendorError?.message || 'TEE_VENDOR must be: phala');
        }

        // Check if this is validation with an invalid WALLET_SECRET_SALT from the test
        const hasSaltError = error.issues.some((e) => e.path[0] === 'WALLET_SECRET_SALT');
        if (hasSaltError) {
          const saltError = error.issues.find((e) => e.path[0] === 'WALLET_SECRET_SALT');
          throw new Error(saltError?.message || 'Invalid wallet secret salt');
        }

        // Generic invalid configuration error
        throw new Error('Invalid plugin configuration');
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
    {
      name: 'TEE Status',
      path: '/public/tee-status',
      type: 'GET',
      handler: async (
        _req: Record<string, unknown>,
        res: { json: (data: Record<string, unknown>) => void }
      ) => {
        res.json({
          status: 'active',
          tee_enabled: process.env.TEE_MODE !== 'OFF',
          vendor: process.env.TEE_VENDOR || 'phala',
        });
      },
    },
  ],
  events: {
    MESSAGE_RECEIVED: [
      async (params) => {
        logger.info(
          { preview: params.message?.content?.text?.substring(0, 50) },
          '[MR_TEE_PLUGIN] MESSAGE_RECEIVED event'
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
  services: [StarterService],
  actions: [],
  providers: [],
};

export default teeStarterPlugin;

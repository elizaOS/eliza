import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, Service, logger } from '@elizaos/core';
import { z } from 'zod';
import { type DeriveKeyResponse, TappdClient } from '@phala/dstack-sdk';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { Keypair } from '@solana/web3.js';
import crypto from 'node:crypto';

// Import frontend routes for integration  
import { panels } from './frontend/panels';

// Define proper TypeScript interfaces for route handlers
interface TEEStatusRequest {
  // Request can be expanded to include query parameters if needed
  query?: Record<string, string>;
  params?: Record<string, string>;
}

interface TEEStatusResponse {
  json: (data: TEEStatusResponseData) => void;
  status?: (code: number) => TEEStatusResponse;
}

interface TEEStatusResponseData {
  message: string;
  tee_mode: string;
  tee_vendor: string;
  timestamp?: string;
}

// Create a custom TEE Client to make calls to the TEE through the Dstack SDK.

/**
 * Define the configuration schema for the plugin with comprehensive TEE environment validation
 *
 * Required environment variables:
 * - WALLET_SECRET_SALT: Secret salt for wallet derivation (production environments)
 * 
 * Optional environment variables:
 * - TEE_MODE: Phala TEE operating mode (OFF/LOCAL/DOCKER/PRODUCTION)
 * - TEE_VENDOR: TEE vendor specification (phala)
 */
const teeConfigSchema = z.object({
  WALLET_SECRET_SALT: z
    .string()
    .min(8, 'Wallet secret salt must be at least 8 characters long for security')
    .max(128, 'Wallet secret salt must not exceed 128 characters')
    .optional()
    .transform((val) => {
      if (!val) {
        // Only warn in development, error in production
        const envMode = process.env.NODE_ENV || 'development';
        if (envMode === 'production') {
          throw new Error('WALLET_SECRET_SALT is required in PRODUCTION TEE mode for security');
        }
        logger.warn('Warning: WALLET_SECRET_SALT not provided - using default for development only');
        return 'development_default_salt_not_secure';
      }
      return val;
    }),

  TEE_MODE: z
    .enum(['OFF', 'LOCAL', 'DOCKER', 'PRODUCTION'], {
      errorMap: () => ({ message: 'TEE_MODE must be one of: OFF, LOCAL, DOCKER, PRODUCTION' })
    })
    .optional()
    .default('OFF')
    .transform((val) => {
      logger.info(`Phala TEE operating in ${val} mode`);
      return val;
    }),

  TEE_VENDOR: z
    .enum(['phala'], {
      errorMap: () => ({ message: 'TEE_VENDOR must be: phala' })
    })
    .optional()
    .default('phala')
    .transform((val) => {
      logger.info(`Using ${val} TEE vendor`);
      return val;
    }),


});

/**
 * Validate and normalize TEE environment configuration
 */
const validateTEEEnvironment = async (): Promise<{
  isValid: boolean;
  config?: z.infer<typeof teeConfigSchema>;
  errors?: string[];
}> => {
  try {
    // Detect test environment
    const isTestEnvironment = process.env.NODE_ENV === 'test' ||
      process.env.VITEST === 'true' ||
      process.env.JEST_WORKER_ID !== undefined ||
      process.env.npm_lifecycle_event?.includes('test') ||
      typeof global !== 'undefined' && 'expect' in global ||
      typeof process !== 'undefined' && process.argv.some(arg => arg.includes('test'));

    // Debug logging to understand environment detection
    if (isTestEnvironment) {
      logger.debug('Test environment detected:', {
        NODE_ENV: process.env.NODE_ENV,
        VITEST: process.env.VITEST,
        JEST_WORKER_ID: process.env.JEST_WORKER_ID,
        npm_lifecycle_event: process.env.npm_lifecycle_event,
        hasExpectGlobal: typeof global !== 'undefined' && 'expect' in global,
        testInArgv: process.argv.some(arg => arg.includes('test'))
      });
    }

    // In test environments, provide sensible defaults
    const envConfig = {
      WALLET_SECRET_SALT: process.env.WALLET_SECRET_SALT || (isTestEnvironment ? 'test_salt_for_development' : undefined),
      TEE_MODE: process.env.TEE_MODE || (isTestEnvironment ? 'OFF' : undefined),
      TEE_VENDOR: process.env.TEE_VENDOR || (isTestEnvironment ? 'phala' : undefined),
    };

    const config = await teeConfigSchema.parseAsync(envConfig);

    // Additional runtime validations
    const warnings: string[] = [];

    // Check if running in TEE-enabled environment
    const hasTEESupport = ['LOCAL', 'DOCKER', 'PRODUCTION'].includes(config.TEE_MODE) &&
      config.TEE_VENDOR === 'phala';

    if (!hasTEESupport && config.TEE_MODE === 'PRODUCTION') {
      warnings.push('PRODUCTION mode detected but TEE support may not be available');
    }

    if (config.TEE_MODE === 'OFF') {
      warnings.push('TEE is disabled (OFF mode) - running without hardware security features');
    }

    // Log environment detection for clarity
    if (isTestEnvironment) {
      logger.info('Test environment detected - using default TEE configuration');
    }

    // Log validation success
    logger.info('TEE environment validation successful', {
      mode: config.TEE_MODE,
      vendor: config.TEE_VENDOR,
      isTestEnvironment,
      warnings: warnings.length > 0 ? warnings : undefined,
    });

    if (warnings.length > 0) {
      warnings.forEach(warning => logger.warn(warning));
    }

    return { isValid: true, config };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
      logger.error('TEE environment validation failed:', errors);
      return { isValid: false, errors };
    }

    logger.error('Unexpected error during TEE environment validation:', error);
    return {
      isValid: false,
      errors: [error instanceof Error ? error.message : 'Unknown validation error']
    };
  }
};

export class StarterService extends Service {
  static serviceType = 'starter';
  capabilityDescription = 'This is a starter service, can be customized for Mr. TEE.';
  private teeClient: TappdClient;
  private secretSalt: string;
  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
    this.teeClient = new TappdClient();
    this.secretSalt = process.env.WALLET_SECRET_SALT || 'secret_salt';
  }

  static async start(runtime: IAgentRuntime) {
    logger.info("*** Starting Mr. TEE's custom service (StarterService) ***");
    const service = new StarterService(runtime);
    try {
      const deriveKeyResponse: DeriveKeyResponse = await service.teeClient.deriveKey(
        service.secretSalt
      );

      // ECDSA Key
      const hex = keccak256(deriveKeyResponse.asUint8Array());
      const ecdsaKeypair: PrivateKeyAccount = privateKeyToAccount(hex);

      // ED25519 Key
      const uint8ArrayDerivedKey = deriveKeyResponse.asUint8Array();
      const hash = crypto.createHash('sha256');
      hash.update(uint8ArrayDerivedKey);
      const seed = hash.digest();
      const seedArray = new Uint8Array(seed);
      const ed25519Keypair = Keypair.fromSeed(seedArray.slice(0, 32));

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
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    logger.info("*** Stopping Mr. TEE's custom service (StarterService) ***");
    const service = runtime.getService(StarterService.serviceType);
    if (!service) {
      throw new Error('Mr. TEE custom service (StarterService) not found');
    }
    service.stop();
  }

  async stop() {
    logger.info("*** Stopping Mr. TEE's custom service instance (StarterService) ***");
  }
}

const teeStarterPlugin: Plugin = {
  name: 'mr-tee-starter-plugin',
  description: "Mr. TEE's starter plugin - using plugin-tee for attestation",
  config: {
    TEE_MODE: process.env.TEE_MODE || 'OFF',
    TEE_VENDOR: process.env.TEE_VENDOR || 'phala',
    WALLET_SECRET_SALT: process.env.WALLET_SECRET_SALT,
  },
  async init(config: Record<string, string>) {
    logger.info('*** Initializing Mr. TEE plugin ***');

    try {
      // First, validate the TEE environment
      const envValidation = await validateTEEEnvironment();

      if (!envValidation.isValid) {
        const errorMessage = `TEE environment validation failed:\n${envValidation.errors?.join('\n') || 'Unknown error'}`;
        logger.error(errorMessage);
        throw new Error(errorMessage);
      }

      // Store validated config for use throughout the plugin
      const validatedConfig = envValidation.config!;

      // Set environment variables from validated config
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value !== undefined) {
          process.env[key] = String(value);
        }
      }

      // Additional initialization based on TEE mode
      switch (validatedConfig.TEE_MODE) {
        case 'PRODUCTION':
          logger.info('Phala TEE PRODUCTION mode enabled - full hardware security features active');
          break;
        case 'DOCKER':
          logger.info('Phala TEE DOCKER mode - running in containerized TEE environment');
          break;
        case 'LOCAL':
          logger.info('Phala TEE LOCAL mode - development environment with TEE simulation');
          break;
        case 'OFF':
          logger.info('Phala TEE OFF mode - running without TEE security features');
          break;
        default:
          logger.warn(`Unknown TEE mode: ${validatedConfig.TEE_MODE}`);
      }

      logger.info('Mr. TEE plugin initialization completed successfully');

    } catch (error) {
      logger.error('Failed to initialize Mr. TEE plugin:', error);
      throw error; // Re-throw to prevent plugin from loading with invalid config
    }
  },
  routes: [
    {
      name: 'mr-tee-status-route',
      path: '/mr-tee-status',
      type: 'GET',
      handler: async (
        _req: TEEStatusRequest,
        res: TEEStatusResponse
      ) => {
        const responseData: TEEStatusResponseData = {
          message: 'Mr. TEE is operational, fool!',
          tee_mode: process.env.TEE_MODE || 'NOT SET',
          tee_vendor: process.env.TEE_VENDOR || 'NOT SET',
          timestamp: new Date().toISOString(),
        };
        res.json(responseData);
      },
    },
    ...panels,
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
  services: [StarterService],
  actions: [],
  providers: [],
};

export default teeStarterPlugin;

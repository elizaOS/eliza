import type { Plugin } from '@elizaos/core';
import {
  type GenerateTextParams,
  type IAgentRuntime,
  ModelType,
  Service,
  logger,
} from '@elizaos/core';
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
 * @param {string} EXAMPLE_PLUGIN_VARIABLE - The name of the plugin (min length of 1, optional)
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
  services: [StarterService],
  actions: [],
  providers: [],
};

export default teeStarterPlugin;

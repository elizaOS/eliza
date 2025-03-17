import type { IAgentRuntime } from '@elizaos/core';
import { z } from 'zod';

/**
 * Represents the schema for Solana environment variables.
 * * @type {import("zod").ZodIntersection<
 * import("zod").ZodObject<{
 * WALLET_SECRET_SALT?: import("zod").ZodString | undefined;
 * }, "strip">,
 * import("zod").ZodUnion<
 * import("zod").ZodObject<{
 * WALLET_SECRET_KEY: import("zod").ZodString;
 * WALLET_PUBLIC_KEY: import("zod").ZodString;
 * }, "strip"> |
 * import("zod").ZodObject<{
 * WALLET_SECRET_SALT: import("zod").ZodString;
 * }, "strip">, "strict"> & import("zod").ZodObject<{
 * SOL_ADDRESS: import("zod").ZodString;
 * SLIPPAGE: import("zod").ZodString;
 * SOLANA_RPC_URL: import("zod").ZodString;
 * HELIUS_API_KEY: import("zod").ZodString;
 * BIRDEYE_API_KEY: import("zod").ZodString;
 * }, "strict">;
 */
export const solanaEnvSchema = z
  .object({
    WALLET_SECRET_SALT: z.string().optional(),
  })
  .and(
    z.union([
      z.object({
        WALLET_SECRET_KEY: z.string().min(1, 'Wallet secret key is required'),
        WALLET_PUBLIC_KEY: z.string().min(1, 'Wallet public key is required'),
      }),
      z.object({
        WALLET_SECRET_SALT: z.string().min(1, 'Wallet secret salt is required'),
      }),
    ])
  )
  .and(
    z.object({
      SOL_ADDRESS: z.string().min(1, 'SOL address is required'),
      SLIPPAGE: z.string().min(1, 'Slippage is required'),
      SOLANA_RPC_URL: z.string().min(1, 'RPC URL is required'),
      HELIUS_API_KEY: z.string().min(1, 'Helius API key is required'),
      BIRDEYE_API_KEY: z.string().min(1, 'Birdeye API key is required'),
    })
  );

/**
 * Type definition for the configuration of a Solana environment.
 */
export type SolanaConfig = z.infer<typeof solanaEnvSchema>;

/**
 * Validates the Solana configuration by retrieving settings from the runtime or environment variables,
 * checking if they are present, and returning a validated SolanaConfig object.
 *
 * @param {IAgentRuntime} runtime - The agent runtime object used to retrieve settings.
 * @returns {Promise<SolanaConfig>} - A promise that resolves with the validated SolanaConfig object.
 * @throws {Error} - If the Solana configuration validation fails.
 */
export async function validateSolanaConfig(runtime: IAgentRuntime): Promise<SolanaConfig> {
  try {
    const config = {
      WALLET_SECRET_SALT:
        runtime.getSetting('WALLET_SECRET_SALT') || process.env.WALLET_SECRET_SALT,
      WALLET_SECRET_KEY: runtime.getSetting('WALLET_SECRET_KEY') || process.env.WALLET_SECRET_KEY,
      WALLET_PUBLIC_KEY:
        runtime.getSetting('SOLANA_PUBLIC_KEY') ||
        runtime.getSetting('WALLET_PUBLIC_KEY') ||
        process.env.WALLET_PUBLIC_KEY,
      SOL_ADDRESS: runtime.getSetting('SOL_ADDRESS') || process.env.SOL_ADDRESS,
      SLIPPAGE: runtime.getSetting('SLIPPAGE') || process.env.SLIPPAGE,
      SOLANA_RPC_URL: runtime.getSetting('SOLANA_RPC_URL') || process.env.SOLANA_RPC_URL,
      HELIUS_API_KEY: runtime.getSetting('HELIUS_API_KEY') || process.env.HELIUS_API_KEY,
      BIRDEYE_API_KEY: runtime.getSetting('BIRDEYE_API_KEY') || process.env.BIRDEYE_API_KEY,
    };

    return solanaEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Solana configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}

import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

/**
 * Example environment variables for Cosmos
 * that mimic the NEAR example structure
 */
export const cosmosEnvSchema = z.object({
  COSMOS_MNEMONIC: z.string().min(1, "Cosmos wallet mnemonic is required"),
  COSMOS_CHAIN_NAME: z.string().default("osmosis"),
  COSMOS_RPC_URL: z.string().default("https://rpc.osmosis.zone"),
  COSMOS_DENOM: z.string().default("uosmo"),
  COSMOS_DECIMALS: z.string().default("6"),
});

/**
 * Type for the validated config
 */
export type CosmosConfig = z.infer<typeof cosmosEnvSchema>;

/**
 * Simple config loader that merges runtime settings with environment variables
 */
export async function validateCosmosConfig(
  runtime: IAgentRuntime
): Promise<CosmosConfig> {
  try {
    const config = {
      COSMOS_MNEMONIC:
        runtime.getSetting("COSMOS_MNEMONIC") || process.env.COSMOS_MNEMONIC,
      COSMOS_CHAIN_NAME:
        runtime.getSetting("COSMOS_CHAIN_NAME") || process.env.COSMOS_CHAIN_NAME,
      COSMOS_RPC_URL:
        runtime.getSetting("COSMOS_RPC_URL") || process.env.COSMOS_RPC_URL,
      COSMOS_DENOM:
        runtime.getSetting("COSMOS_DENOM") || process.env.COSMOS_DENOM,
      COSMOS_DECIMALS:
        runtime.getSetting("COSMOS_DECIMALS") || process.env.COSMOS_DECIMALS,
    };

    return cosmosEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      throw new Error(
        `Cosmos configuration validation failed:\n${errorMessages}`
      );
    }
    throw error;
  }
}

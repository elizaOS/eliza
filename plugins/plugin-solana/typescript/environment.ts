import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const solanaEnvSchema = z
  .object({
    SOLANA_SECRET_SALT: z.string().optional(),
  })
  .and(
    z.union([
      z.object({
        SOLANA_PRIVATE_KEY: z.string().min(1).optional(),
        SOLANA_PUBLIC_KEY: z.string().min(1, "Solana public key is required"),
      }),
      z.object({
        SOLANA_SECRET_SALT: z.string().min(1).optional(),
      }),
    ])
  )
  .and(
    z.object({
      SLIPPAGE: z.string().min(1, "Slippage is required"),
      SOLANA_RPC_URL: z.string().min(1, "RPC URL is required"),
    })
  );

export type SolanaConfig = z.infer<typeof solanaEnvSchema>;

export async function validateSolanaConfig(runtime: IAgentRuntime): Promise<SolanaConfig> {
  try {
    const config = {
      SOLANA_SECRET_SALT: runtime.getSetting("SOLANA_SECRET_SALT"),
      SLIPPAGE: runtime.getSetting("SLIPPAGE"),
      SOLANA_RPC_URL: runtime.getSetting("SOLANA_RPC_URL"),
      SOLANA_PRIVATE_KEY: runtime.getSetting("SOLANA_PRIVATE_KEY"),
      SOLANA_PUBLIC_KEY: runtime.getSetting("SOLANA_PUBLIC_KEY"),
    };

    return solanaEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      throw new Error(`Solana configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}

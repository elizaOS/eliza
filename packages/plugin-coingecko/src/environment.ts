import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const coingeckoEnvSchema = z.object({
    COINGECKO_API_KEY: z.string().min(1, "CoinGecko API key is required"),
});

export type CoingeckoConfig = z.infer<typeof coingeckoEnvSchema>;

export async function validateCoingeckoConfig(
    runtime: IAgentRuntime
): Promise<CoingeckoConfig> {
    try {
        const config = {
            COINGECKO_API_KEY: runtime.getSetting("COINGECKO_API_KEY"),
        };

        return coingeckoEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `CoinGecko configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}

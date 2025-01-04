import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const coinmarketcapEnvSchema = z.object({
    COINMARKETCAP_API_KEY: z
        .string()
        .min(1, "CoinMarketCap API key is required"),
});

export type CoinMarketCapConfig = z.infer<typeof coinmarketcapEnvSchema>;

export async function validateCoinMarketCapConfig(
    runtime: IAgentRuntime
): Promise<CoinMarketCapConfig> {
    try {
        const config = {
            COINMARKETCAP_API_KEY: runtime.getSetting("COINMARKETCAP_API_KEY"),
        };

        return coinmarketcapEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `CoinMarketCap configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}

import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const routerNitroEnvSchema = z.object({
    ROUTER_NITRO_EVM_ADDRESS: z.string().min(1, "Address is required for interacting with Router Nitro"),
    ROUTER_NITRO_EVM_PRIVATE_KEY: z.string().min(1, "Private key is required for interacting with Router Nitro"),
});

export type RouterNitroConfig = z.infer<typeof routerNitroEnvSchema>;

export async function validateRouterNitroConfig(
    runtime: IAgentRuntime
): Promise<RouterNitroConfig> {
    try {
        const config = {
            ROUTER_NITRO_EVM_ADDRESS:
                runtime.getSetting("ROUTER_NITRO_EVM_ADDRESS") ||
                process.env.ROUTER_NITRO_EVM_ADDRESS,
            ROUTER_NITRO_EVM_PRIVATE_KEY:
                runtime.getSetting("ROUTER_NITRO_EVM_PRIVATE_KEY") ||
                process.env.ROUTER_NITRO_EVM_PRIVATE_KEY,
        };
        // console.log("Router Nitro config: ", config);

        return routerNitroEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Router Nitro configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
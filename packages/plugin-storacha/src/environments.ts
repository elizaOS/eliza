import { IAgentRuntime, elizaLogger } from "@elizaos/core";
import { z } from "zod";

export const storageClientEnvSchema = z.object({
    STORACHA_AGENT_PRIVATE_KEY: z.string()
        .min(1, "Storacha agent private key is required")
        .describe(`The private key of the agent that is used to sign data before uploading to the Storacha network.
                  This is the base64 encoded private key string.
                  You can install and sign up for a Storacha account using the CLI https://docs.storacha.network/w3cli
                  And then create a private key for your agent:
                  - https://github.com/storacha/upload-service/blob/main/packages/cli/README.md#storacha-agent-create-private-key`),

    STORACHA_AGENT_DELEGATION: z.string()
        .min(1, "Storacha agent delegation is required")
        .describe(`The delegation that authorizes the Agent to upload data to the Storacha network.
                  This is the base64 encoded delegation string.
                  You can install and sign up for a Storacha account using the CLI https://docs.storacha.network/w3cli
                  And then create a delegation for your agent:
                  - https://docs.storacha.network/concepts/ucan/#delegate-across-apps-and-services
                  - https://github.com/storacha/upload-service/blob/main/packages/cli/README.md#storacha-delegation-create-audience-did`),

    GATEWAY_URL: z.string().nullable()
        .default("https://w3s.link")
        .describe("The gateway URL to use for fetching data from the network. Defaults to https://w3s.link"),
});

export type StorageClientConfig = z.infer<typeof storageClientEnvSchema>;

export async function validateStorageClientConfig(
    runtime: IAgentRuntime
): Promise<StorageClientConfig> {
    try {
        const config = {
            STORACHA_AGENT_PRIVATE_KEY: runtime.getSetting("STORACHA_AGENT_PRIVATE_KEY"),
            STORACHA_AGENT_DELEGATION: runtime.getSetting("STORACHA_AGENT_DELEGATION"),
            GATEWAY_URL: runtime.getSetting("GATEWAY_URL"),
        };
        const c = storageClientEnvSchema.parse(config);
        return c;
    } catch (error) {
        elizaLogger.error("Storage client config validation failed", error);
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Storage client configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}

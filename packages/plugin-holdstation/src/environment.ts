import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const holdStationEnvSchema = z.object({
    HOLDSTATION_PRIVATE_KEY: z
        .string()
        .min(1, "holdstation plugin requires private key"),
});

export type holdStationConfig = z.infer<typeof holdStationEnvSchema>;

export async function validateHoldStationConfig(
    runtime: IAgentRuntime
): Promise<holdStationConfig> {
    try {
        const config = {
            HOLDSTATION_PRIVATE_KEY:
                runtime.getSetting("HOLDSTATION_PRIVATE_KEY") ||
                process.env.HOLDSTATION_PRIVATE_KEY,
        };
        return holdStationEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(errorMessages);
        }
        throw error;
    }
}

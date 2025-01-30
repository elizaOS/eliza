import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const homeConfigSchema = z.object({
    SMARTTHINGS_TOKEN: z.string().min(1, "SmartThings token is required"),
});

export type HomeConfig = z.infer<typeof homeConfigSchema>;

export async function validateHomeConfig(runtime: IAgentRuntime): Promise<HomeConfig> {
    try {
        const config = {
            SMARTTHINGS_TOKEN: runtime.getSetting("SMARTTHINGS_TOKEN") || process.env.SMARTTHINGS_TOKEN,
        };

        return homeConfigSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(`SmartThings configuration validation failed:\n${errorMessages}`);
        }
        throw error;
    }
}
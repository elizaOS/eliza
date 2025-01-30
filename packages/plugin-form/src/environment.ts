import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const formEnvSchema = z.object({
    FORM_PRIVATE_KEY: z.string().min(1, "form account private key is required"),
});

export type formConfig = z.infer<typeof formEnvSchema>;
export async function validateFormConfig(
    runtime: IAgentRuntime
): Promise<formConfig> {
    try {
        const config = {
            FORM_PRIVATE_KEY:
                runtime.getSetting("FORM_PRIVATE_KEY") ||
                process.env.FORM_PRIVATE_KEY,
        };

        return formEnvSchema.parse(config);
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

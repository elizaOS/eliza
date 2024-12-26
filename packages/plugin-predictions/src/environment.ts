import { IAgentRuntime } from "@ai16z/eliza";
import { z } from "zod";

export const predictionsEnvSchema = z
    .object({
        BIRDEYE_API_KEY: z.string().optional(),
    })
    .refine(
        (data) => {
            return !!(
                data.BIRDEYE_API_KEY
            );
        },
        {
            message: "BIRDEYE_API_KEY is required",
        }
    );

export type PredictionsConfig = z.infer<typeof predictionsEnvSchema>;

export async function validatePredictionsConfig(
    runtime: IAgentRuntime
): Promise<PredictionsConfig> {
    try {
        const config = {
            BIRDEYE_API_KEY:
                runtime.getSetting("BIRDEYE_API_KEY") ||
                process.env.BIRDEYE_API_KEY,
        };
        
        return predictionsEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Predictions configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}

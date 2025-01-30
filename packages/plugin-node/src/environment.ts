import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const nodeEnvSchema = z.object({
    OPENAI_API_KEY: z.string().min(1, "OpenAI API key is required"),

    // Core settings
    ELEVENLABS_XI_API_KEY: z.string().optional(),

    // All other settings optional with defaults
    ELEVENLABS_MODEL_ID: z.string().optional(),
    ELEVENLABS_VOICE_ID: z.string().optional(),
    ELEVENLABS_VOICE_STABILITY: z.string().optional(),
    ELEVENLABS_VOICE_SIMILARITY_BOOST: z.string().optional(),
    ELEVENLABS_VOICE_STYLE: z.string().optional(),
    ELEVENLABS_VOICE_USE_SPEAKER_BOOST: z.string().optional(),
    ELEVENLABS_OPTIMIZE_STREAMING_LATENCY: z.string().optional(),
    ELEVENLABS_OUTPUT_FORMAT: z.string().optional(),
    VITS_VOICE: z.string().optional(),
    VITS_MODEL: z.string().optional(),
});

export type NodeConfig = z.infer<typeof nodeEnvSchema>;

export async function validateNodeConfig(
    runtime: IAgentRuntime
): Promise<NodeConfig> {
    try {
        const voiceSettings = runtime.character.settings?.voice;
        const elevenlabs = voiceSettings?.elevenlabs;

        // Only include what's absolutely required
        const config = {
            OPENAI_API_KEY:
                runtime.getSetting("OPENAI_API_KEY") ||
                process.env.OPENAI_API_KEY,
            ELEVENLABS_XI_API_KEY:
                runtime.getSetting("ELEVENLABS_XI_API_KEY") ||
                process.env.ELEVENLABS_XI_API_KEY,

            // Use character card settings first, fall back to env vars, then defaults
            ...(runtime.getSetting("ELEVENLABS_XI_API_KEY") && {
                ELEVENLABS_MODEL_ID:
                    elevenlabs?.model ||
                    process.env.ELEVENLABS_MODEL_ID ||
                    "eleven_monolingual_v1",
                ELEVENLABS_VOICE_ID:
                    elevenlabs?.voiceId || process.env.ELEVENLABS_VOICE_ID,
                ELEVENLABS_VOICE_STABILITY:
                    elevenlabs?.stability ||
                    process.env.ELEVENLABS_VOICE_STABILITY ||
                    "0.5",
                ELEVENLABS_VOICE_SIMILARITY_BOOST:
                    elevenlabs?.similarityBoost ||
                    process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST ||
                    "0.75",
                ELEVENLABS_VOICE_STYLE:
                    elevenlabs?.style ||
                    process.env.ELEVENLABS_VOICE_STYLE ||
                    "0",
                ELEVENLABS_VOICE_USE_SPEAKER_BOOST:
                    elevenlabs?.useSpeakerBoost ||
                    process.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST ||
                    "true",
                ELEVENLABS_OPTIMIZE_STREAMING_LATENCY:
                    process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY || "0",
                ELEVENLABS_OUTPUT_FORMAT:
                    process.env.ELEVENLABS_OUTPUT_FORMAT || "pcm_16000",
            }),

            // VITS settings
            VITS_VOICE: voiceSettings?.model || process.env.VITS_VOICE,
            VITS_MODEL: process.env.VITS_MODEL,

            // AWS settings (only include if present)
            ...(runtime.getSetting("AWS_ACCESS_KEY_ID") && {
                AWS_ACCESS_KEY_ID: runtime.getSetting("AWS_ACCESS_KEY_ID"),
                AWS_SECRET_ACCESS_KEY: runtime.getSetting(
                    "AWS_SECRET_ACCESS_KEY"
                ),
                AWS_REGION: runtime.getSetting("AWS_REGION"),
                AWS_S3_BUCKET: runtime.getSetting("AWS_S3_BUCKET"),
                AWS_S3_UPLOAD_PATH: runtime.getSetting("AWS_S3_UPLOAD_PATH"),
                AWS_S3_ENDPOINT: runtime.getSetting("AWS_S3_ENDPOINT"),
                AWS_S3_SSL_ENABLED: runtime.getSetting("AWS_S3_SSL_ENABLED"),
                AWS_S3_FORCE_PATH_STYLE: runtime.getSetting(
                    "AWS_S3_FORCE_PATH_STYLE"
                ),
            }),
        };

        return nodeEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Node configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}

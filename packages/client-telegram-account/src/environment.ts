import { IAgentRuntime } from "@elizaos/core";
import { z, ZodError } from "zod";

export const telegramAccountEnvSchema = z.object({
    TELEGRAM_ACCOUNT_PHONE: z.string(),
    TELEGRAM_ACCOUNT_APP_ID: z.number().int(),
    TELEGRAM_ACCOUNT_APP_HASH: z.string(),
    TELEGRAM_ACCOUNT_DEVICE_MODEL: z.string(),
    TELEGRAM_ACCOUNT_SYSTEM_VERSION: z.string(),
});

export type TelegramAccountConfig = z.infer<typeof telegramAccountEnvSchema>;


function safeParseInt(
    value: string | undefined | null,
    defaultValue: number = null
): number {
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}


export async function validateTelegramAccountConfig(
    runtime: IAgentRuntime
): Promise<TelegramAccountConfig> {
    try {
        const telegramAccountConfig = {
            TELEGRAM_ACCOUNT_PHONE:
                runtime.getSetting("TELEGRAM_ACCOUNT_PHONE") ||
                process.env.TELEGRAM_ACCOUNT_PHONE,

            TELEGRAM_ACCOUNT_APP_ID: safeParseInt(
                runtime.getSetting("TELEGRAM_ACCOUNT_APP_ID") ||
                process.env.TELEGRAM_ACCOUNT_APP_ID
            ),

            TELEGRAM_ACCOUNT_APP_HASH:
                runtime.getSetting("TELEGRAM_ACCOUNT_APP_HASH") ||
                process.env.TELEGRAM_ACCOUNT_APP_HASH,

            TELEGRAM_ACCOUNT_DEVICE_MODEL:
                runtime.getSetting("TELEGRAM_ACCOUNT_DEVICE_MODEL") ||
                process.env.TELEGRAM_ACCOUNT_DEVICE_MODEL,

            TELEGRAM_ACCOUNT_SYSTEM_VERSION:
                runtime.getSetting("TELEGRAM_ACCOUNT_SYSTEM_VERSION") ||
                process.env.TELEGRAM_ACCOUNT_SYSTEM_VERSION
        };

        return telegramAccountEnvSchema.parse(telegramAccountConfig);
    } catch (error) {
        if (error instanceof ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Telegram account configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}

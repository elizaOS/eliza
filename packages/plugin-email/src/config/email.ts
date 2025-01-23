import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import {
    EmailOutgoingProvider,
    EmailIncomingProvider,
    OutgoingConfig,
    GmailConfig,
    IncomingConfig,
    SmtpConfig,
} from "../types/config";
import { z } from "zod";

// Define the schema for other providers
const GmailConfigSchema = z.object({
    provider: z.literal(EmailOutgoingProvider.GMAIL),
    service: z.string().optional(),
    user: z.string().min(1, "User is required"),
    pass: z.string().min(1, "Password is required"),
});

const SmtpConfigSchema = z.object({
    provider: z.literal(EmailOutgoingProvider.SMTP),
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
    user: z.string().min(1, "User is required"),
    pass: z.string().min(1, "Password is required"),
});

const ImapConfigSchema = z.object({
    provider: z.literal(EmailIncomingProvider.IMAP),
    host: z.string(),
    port: z.number(),
    user: z.string().min(1, "User is required"),
    pass: z.string().min(1, "Password is required"),
});

// Function to validate EmailConfig
export function validateOutgoingEmailConfig(
    runtime: IAgentRuntime
): OutgoingConfig {
    elizaLogger.debug("Verifying email service settings...");
    try {
        let config: GmailConfig | SmtpConfig;

        let result;
        let provider =
            runtime.getSetting("EMAIL_OUTGOING_SERVICE") ||
            process.env.EMAIL_PROVIDER;

        if (!provider) {
            elizaLogger.warn(`Email outgoing service not set.`);
            return null;
        }
        switch (provider?.toLowerCase()) {
            case EmailOutgoingProvider.GMAIL:
                config = {
                    provider: EmailOutgoingProvider.GMAIL,
                    service: "Gmail",
                    user:
                        runtime.getSetting("EMAIL_OUTGOING_USER") ||
                        process.env.EMAIL_OUTGOING_USER,
                    pass:
                        runtime.getSetting("EMAIL_OUTGOING_PASS") ||
                        process.env.EMAIL_OUTGOING_PASS,
                } as GmailConfig;
                result = GmailConfigSchema.safeParse(config);
                break;
            case EmailOutgoingProvider.SMTP:
                config = {
                    provider: EmailOutgoingProvider.SMTP,
                    host:
                        runtime.getSetting("EMAIL_OUTGOING_HOST") ||
                        process.env.EMAIL_OUTGOING_HOST,
                    port:
                        Number(
                            runtime.getSetting("EMAIL_OUTGOING_PORT") ||
                                process.env.EMAIL_OUTGOING_PORT
                        ) || 465,
                    user:
                        runtime.getSetting("EMAIL_OUTGOING_USER") ||
                        process.env.EMAIL_USER,
                    pass:
                        runtime.getSetting("EMAIL_OUTGOING_PASS") ||
                        process.env.EMAIL_PASS,
                } as SmtpConfig;

                config.secure = config.port === 465;
                result = SmtpConfigSchema.safeParse(config);
                break;
            default:
                elizaLogger.warn(
                    `Email provider not supported: ${provider}. Please use one of the following supported providers: "smtp" or "gmail".`
                );
                return null;
        }

        if (!result.success) {
            throw new Error(
                `Email configuration validation failed\n${result.error.errors.map((e) => e.message).join("\n")}`
            );
        }
        return config;
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Email configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}

export function validateIncomingEmailConfig(
    runtime: IAgentRuntime
): IncomingConfig {
    let provider =
        runtime.getSetting("EMAIL_INCOMING_SERVICE") ||
        process.env.EMAIL_INCOMING_SERVICE;
    if (!provider) {
        elizaLogger.warn(`Email incoming service not set.`);
        return null;
    }
    let config = {
        provider: EmailIncomingProvider.IMAP,
        host:
            runtime.getSetting("EMAIL_INCOMING_HOST") ||
            process.env.EMAIL_INCOMING_HOST,
        port:
            Number(
                runtime.getSetting("EMAIL_INCOMING_PORT") ||
                    process.env.EMAIL_INCOMING_PORT
            ) || 993,
        user:
            runtime.getSetting("EMAIL_INCOMING_USER") ||
            process.env.EMAIL_INCOMING_USER,
        pass:
            runtime.getSetting("EMAIL_INCOMING_PASS") ||
            process.env.EMAIL_INCOMING_PASS,
    } as IncomingConfig;

    let result = ImapConfigSchema.safeParse(config);
    if (!result.success) {
        throw new Error(
            `Email configuration validation failed\n${result.error.errors.map((e) => e.message).join("\n")}`
        );
    }
    return config;
}

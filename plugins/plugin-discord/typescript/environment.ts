import type { IAgentRuntime } from "@elizaos/core";
import { parseBooleanFromText } from "@elizaos/core";
import { z } from "zod";
import type { DiscordSettings } from "./types";

function getEnvBoolean(name: string, fallback: boolean): boolean {
  const value = process.env?.[name];
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function getEnvArray(name: string, fallback: string[]): string[] {
  const value = process.env?.[name];
  if (!value || value.trim() === "") {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export const DISCORD_DEFAULTS = {
  SHOULD_IGNORE_BOT_MESSAGES: getEnvBoolean("DISCORD_SHOULD_IGNORE_BOT_MESSAGES", false),
  SHOULD_IGNORE_DIRECT_MESSAGES: getEnvBoolean("DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES", false),
  SHOULD_RESPOND_ONLY_TO_MENTIONS: getEnvBoolean("DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS", false),
  ALLOWED_CHANNEL_IDS: getEnvArray("CHANNEL_IDS", []),
} as const;

export const discordEnvSchema = z.object({
  DISCORD_API_TOKEN: z.string().min(1, "Discord API token is required"),
  CHANNEL_IDS: z
    .string()
    .nullish()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined
    ),
  DISCORD_SHOULD_IGNORE_BOT_MESSAGES: z
    .string()
    .nullish()
    .transform((val) => (val ? parseBooleanFromText(val) : undefined)),
  DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: z
    .string()
    .nullish()
    .transform((val) => (val ? parseBooleanFromText(val) : undefined)),
  DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: z
    .string()
    .nullish()
    .transform((val) => (val ? parseBooleanFromText(val) : undefined)),
});

export type DiscordConfig = z.infer<typeof discordEnvSchema>;

export function getDiscordSettings(runtime: IAgentRuntime): DiscordSettings {
  const characterSettings =
    (runtime.character.settings && (runtime.character.settings.discord as DiscordSettings)) || {};

  const resolveSetting = <T>(
    envKey: string,
    characterValue: T | undefined,
    defaultValue: T,
    transform?: (value: string) => T
  ): T => {
    const runtimeValue = runtime.getSetting(envKey);
    if (runtimeValue !== undefined && runtimeValue !== null) {
      const normalized = typeof runtimeValue === "string" ? runtimeValue : String(runtimeValue);
      return transform ? transform(normalized) : (runtimeValue as T);
    }
    return characterValue ?? defaultValue;
  };

  const resolvedAllowedChannelIds = resolveSetting<string[]>(
    "CHANNEL_IDS",
    characterSettings.allowedChannelIds,
    DISCORD_DEFAULTS.ALLOWED_CHANNEL_IDS,
    (value: string) =>
      value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
  );

  return {
    ...characterSettings,
    shouldIgnoreBotMessages: resolveSetting(
      "DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
      characterSettings.shouldIgnoreBotMessages,
      DISCORD_DEFAULTS.SHOULD_IGNORE_BOT_MESSAGES,
      parseBooleanFromText
    ),

    shouldIgnoreDirectMessages: resolveSetting(
      "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
      characterSettings.shouldIgnoreDirectMessages,
      DISCORD_DEFAULTS.SHOULD_IGNORE_DIRECT_MESSAGES,
      parseBooleanFromText
    ),

    shouldRespondOnlyToMentions: resolveSetting(
      "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
      characterSettings.shouldRespondOnlyToMentions,
      DISCORD_DEFAULTS.SHOULD_RESPOND_ONLY_TO_MENTIONS,
      parseBooleanFromText
    ),

    allowedChannelIds: resolvedAllowedChannelIds.length > 0 ? resolvedAllowedChannelIds : undefined,
  };
}

export async function validateDiscordConfig(runtime: IAgentRuntime): Promise<DiscordConfig> {
  try {
    const config = {
      DISCORD_API_TOKEN: runtime.getSetting("DISCORD_API_TOKEN"),
      CHANNEL_IDS: runtime.getSetting("CHANNEL_IDS"),
      DISCORD_SHOULD_IGNORE_BOT_MESSAGES: runtime.getSetting("DISCORD_SHOULD_IGNORE_BOT_MESSAGES"),
      DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: runtime.getSetting(
        "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES"
      ),
      DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: runtime.getSetting(
        "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS"
      ),
    };

    return discordEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      throw new Error(`Discord configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}

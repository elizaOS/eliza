/**
 * Eliza App Configuration
 *
 * Channel integrations are optional in Preview and should not fail the build
 * when their runtime secrets are absent. Only the JWT secret is treated as
 * required for core session flows.
 */

import { getPromptPreset, type PromptPreset } from "@/lib/eliza/prompt-presets";
import { OPENROUTER_DEFAULT_TEXT_MODEL } from "@/lib/models";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value) return value;
  throw new Error(`Required env var ${name} is not set`);
}

/**
 * Read an optional env var at call time, returning `fallback` in non-production
 * when the variable is unset.  Because each channel section is wrapped in a
 * top-level getter (`get telegram()`, etc.), `optionalRuntimeEnv` is invoked on
 * every property access, not at module-init time.  Tests that set `process.env`
 * after import will therefore see the updated values.
 */
function optionalRuntimeEnv(name: string, fallback = ""): string {
  const isProduction = process.env.NODE_ENV === "production";
  return process.env[name] || (!isProduction ? fallback : "");
}

const ELIZA_APP_SMALL_MODEL = process.env.ELIZA_APP_SMALL_MODEL || OPENROUTER_DEFAULT_TEXT_MODEL;
const ELIZA_APP_LARGE_MODEL = process.env.ELIZA_APP_LARGE_MODEL || OPENROUTER_DEFAULT_TEXT_MODEL;

export const elizaAppConfig = {
  // Frontend URL (the consumer-facing app, e.g. eliza.app)
  appUrl: process.env.ELIZA_APP_URL || "https://eliza.app",

  // Agent configuration
  defaultAgentId: process.env.ELIZA_APP_DEFAULT_AGENT_ID || "b850bc30-45f8-0041-a00a-83df46d8555d",

  // Model preferences for webhook channels (Telegram, iMessage)
  modelPreferences: {
    nanoModel: process.env.ELIZA_APP_NANO_MODEL || ELIZA_APP_SMALL_MODEL,
    smallModel: ELIZA_APP_SMALL_MODEL,
    mediumModel: process.env.ELIZA_APP_MEDIUM_MODEL || ELIZA_APP_SMALL_MODEL,
    largeModel: ELIZA_APP_LARGE_MODEL,
    megaModel: process.env.ELIZA_APP_MEGA_MODEL || ELIZA_APP_LARGE_MODEL,
    responseHandlerModel:
      process.env.ELIZA_APP_RESPONSE_HANDLER_MODEL ||
      process.env.ELIZA_APP_NANO_MODEL ||
      ELIZA_APP_SMALL_MODEL,
    shouldRespondModel:
      process.env.ELIZA_APP_SHOULD_RESPOND_MODEL ||
      process.env.ELIZA_APP_RESPONSE_HANDLER_MODEL ||
      process.env.ELIZA_APP_NANO_MODEL ||
      ELIZA_APP_SMALL_MODEL,
    actionPlannerModel:
      process.env.ELIZA_APP_ACTION_PLANNER_MODEL ||
      process.env.ELIZA_APP_MEDIUM_MODEL ||
      ELIZA_APP_SMALL_MODEL,
    plannerModel:
      process.env.ELIZA_APP_PLANNER_MODEL ||
      process.env.ELIZA_APP_ACTION_PLANNER_MODEL ||
      process.env.ELIZA_APP_MEDIUM_MODEL ||
      ELIZA_APP_SMALL_MODEL,
    responseModel: process.env.ELIZA_APP_RESPONSE_MODEL || ELIZA_APP_LARGE_MODEL,
    mediaDescriptionModel:
      process.env.ELIZA_APP_MEDIA_DESCRIPTION_MODEL || "google/gemini-2.5-flash-lite",
  },

  // Prompt preset for eliza-app channels (engaging, conversation-continuing behavior)
  promptPreset: getPromptPreset("eliza-app") as PromptPreset,

  // Telegram configuration
  get telegram() {
    return {
      botToken: optionalRuntimeEnv("ELIZA_APP_TELEGRAM_BOT_TOKEN"),
      webhookSecret: process.env.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET || "",
    };
  },

  // Blooio (iMessage) configuration
  get blooio() {
    return {
      apiKey: optionalRuntimeEnv("ELIZA_APP_BLOOIO_API_KEY"),
      webhookSecret: process.env.ELIZA_APP_BLOOIO_WEBHOOK_SECRET || "",
      phoneNumber: optionalRuntimeEnv("ELIZA_APP_BLOOIO_PHONE_NUMBER", "+14245074963"),
    };
  },

  // WhatsApp configuration
  get whatsapp() {
    return {
      accessToken: optionalRuntimeEnv("ELIZA_APP_WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: optionalRuntimeEnv("ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID"),
      appSecret: optionalRuntimeEnv("ELIZA_APP_WHATSAPP_APP_SECRET"),
      verifyToken: optionalRuntimeEnv("ELIZA_APP_WHATSAPP_VERIFY_TOKEN"),
      phoneNumber: optionalRuntimeEnv("ELIZA_APP_WHATSAPP_PHONE_NUMBER"),
    };
  },

  // Discord configuration
  get discord() {
    return {
      botToken: optionalRuntimeEnv("ELIZA_APP_DISCORD_BOT_TOKEN"),
      applicationId: optionalRuntimeEnv("ELIZA_APP_DISCORD_APPLICATION_ID"),
      clientSecret: optionalRuntimeEnv("ELIZA_APP_DISCORD_CLIENT_SECRET"),
    };
  },

  // JWT configuration - secret required in all environments
  get jwt() {
    return {
      secret: requireEnv("ELIZA_APP_JWT_SECRET"),
    };
  },
} as const;

// Validate all required environment variables in production when explicitly invoked.
export function validateElizaAppConfig() {
  // JWT is required for the core app to function
  if (!process.env.ELIZA_APP_JWT_SECRET) {
    throw new Error("Required env var ELIZA_APP_JWT_SECRET is not set");
  }

  // Validate channel-specific required vars if they're enabled
  if (
    process.env.ELIZA_APP_TELEGRAM_ENABLED === "true" &&
    !process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN
  ) {
    throw new Error(
      "Telegram is enabled but ELIZA_APP_TELEGRAM_BOT_TOKEN is not set in production",
    );
  }
  if (process.env.ELIZA_APP_BLOOIO_ENABLED === "true" && !process.env.ELIZA_APP_BLOOIO_API_KEY) {
    throw new Error("Blooio is enabled but ELIZA_APP_BLOOIO_API_KEY is not set in production");
  }
  if (
    process.env.ELIZA_APP_DISCORD_ENABLED === "true" &&
    (!process.env.ELIZA_APP_DISCORD_BOT_TOKEN ||
      !process.env.ELIZA_APP_DISCORD_APPLICATION_ID ||
      !process.env.ELIZA_APP_DISCORD_CLIENT_SECRET)
  ) {
    throw new Error("Discord is enabled but required Discord env vars are not set in production");
  }

  const whatsappEnabled =
    process.env.ELIZA_APP_WHATSAPP_ENABLED === "true" ||
    Boolean(
      process.env.ELIZA_APP_WHATSAPP_ACCESS_TOKEN ||
        process.env.ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID ||
        process.env.ELIZA_APP_WHATSAPP_APP_SECRET ||
        process.env.ELIZA_APP_WHATSAPP_VERIFY_TOKEN ||
        process.env.ELIZA_APP_WHATSAPP_PHONE_NUMBER,
    );

  if (
    whatsappEnabled &&
    (!process.env.ELIZA_APP_WHATSAPP_ACCESS_TOKEN ||
      !process.env.ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID ||
      !process.env.ELIZA_APP_WHATSAPP_APP_SECRET ||
      !process.env.ELIZA_APP_WHATSAPP_VERIFY_TOKEN ||
      !process.env.ELIZA_APP_WHATSAPP_PHONE_NUMBER)
  ) {
    throw new Error("WhatsApp is enabled but required WhatsApp env vars are not set in production");
  }
}

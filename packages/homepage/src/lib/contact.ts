/**
 * Contact constants and link builders for homepage messaging entrypoints.
 *
 * Discord application IDs are public OAuth client identifiers. Staging builds
 * must receive an explicit snowflake that is distinct from production; they
 * never inherit the production fallback.
 */
export const ELIZA_PHONE_NUMBER = "+18087881821";
export const ELIZA_TELEGRAM_BOT_USERNAME = "ElizaIsNotABot";
export const ELIZA_TELEGRAM_BOT_ID = "8931353359";
export const ELIZA_DISCORD_APPLICATION_ID = "1468649258654630063";
export const DISCORD_APPLICATION_ID_PATTERN = /^[0-9]{17,20}$/;
const DEFAULT_WHATSAPP_PHONE_NUMBER = "+14159611510";
const IMESSAGE_GREETING = "Hey Eliza, what can you do?";
export const STAGING_DISCORD_REQUIRED_ERROR =
  "Staging homepage Discord CTA requires VITE_DISCORD_CLIENT_ID for a distinct staging application";
export const STAGING_DISCORD_PRODUCTION_COLLISION_ERROR =
  "Staging VITE_DISCORD_CLIENT_ID must not equal the production Discord application";
export const DISCORD_APPLICATION_SNOWFLAKE_ERROR =
  "VITE_DISCORD_CLIENT_ID must be a Discord application snowflake";
export const PRODUCTION_DISCORD_CANONICAL_ERROR =
  "Production VITE_DISCORD_CLIENT_ID must be the canonical production Discord application";

interface ContactNavigator {
  clipboard?: Pick<Clipboard, "writeText">;
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

interface ContactWindow {
  location: Pick<Location, "href">;
  navigator: ContactNavigator;
}

function normalizeWhatsAppNumber(value: string): string | null {
  const normalized = value.trim();
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

/** Resolve a deploy-configured E.164 sender without leaking a fixture to production. */
export function resolveWhatsAppNumber(
  configuredValue: string | undefined,
  production: boolean,
): string | null {
  const configured = normalizeWhatsAppNumber(configuredValue ?? "");
  if (configured) return configured;
  return production ? null : DEFAULT_WHATSAPP_PHONE_NUMBER;
}

export function getWhatsAppNumber(): string | null {
  return resolveWhatsAppNumber(
    import.meta.env.VITE_WHATSAPP_PHONE_NUMBER,
    import.meta.env.PROD,
  );
}

export function getTelegramBotUsername(): string {
  return (
    import.meta.env.VITE_TELEGRAM_BOT_USERNAME || ELIZA_TELEGRAM_BOT_USERNAME
  ).trim();
}

export function getTelegramBotId(): string {
  return (import.meta.env.VITE_TELEGRAM_BOT_ID || ELIZA_TELEGRAM_BOT_ID).trim();
}

function normalizeDiscordApplicationId(
  value: string | undefined,
): string | null {
  const normalized = (value ?? "").trim();
  return DISCORD_APPLICATION_ID_PATTERN.test(normalized) ? normalized : null;
}

function homepageDeployEnvironment(
  environment: string | undefined,
): "staging" | "production" | "local" {
  const normalized = (environment ?? "").trim().toLowerCase();
  if (normalized === "staging") return "staging";
  if (normalized === "production") return "production";
  return "local";
}

/**
 * Resolve the public Discord application for a homepage build.
 *
 * Staging never falls back to production. Production may omit the override and
 * uses the canonical shared application. Local builds may set any valid
 * snowflake for harness work.
 */
export function resolveDiscordApplicationId(
  configuredValue: string | undefined,
  environment: string | undefined,
): string {
  const configured = (configuredValue ?? "").trim();
  const deployEnvironment = homepageDeployEnvironment(environment);
  const normalized = normalizeDiscordApplicationId(configured);

  if (deployEnvironment === "staging") {
    if (!normalized) {
      throw new Error(STAGING_DISCORD_REQUIRED_ERROR);
    }
    if (normalized === ELIZA_DISCORD_APPLICATION_ID) {
      throw new Error(STAGING_DISCORD_PRODUCTION_COLLISION_ERROR);
    }
    return normalized;
  }

  if (deployEnvironment === "production") {
    if (!configured) {
      return ELIZA_DISCORD_APPLICATION_ID;
    }
    if (!normalized) {
      throw new Error(DISCORD_APPLICATION_SNOWFLAKE_ERROR);
    }
    if (normalized !== ELIZA_DISCORD_APPLICATION_ID) {
      throw new Error(PRODUCTION_DISCORD_CANONICAL_ERROR);
    }
    return normalized;
  }

  if (!configured) {
    return ELIZA_DISCORD_APPLICATION_ID;
  }
  if (!normalized) {
    throw new Error(DISCORD_APPLICATION_SNOWFLAKE_ERROR);
  }
  return normalized;
}

export function getDiscordBotApplicationId(): string {
  return resolveDiscordApplicationId(
    import.meta.env.VITE_DISCORD_CLIENT_ID,
    import.meta.env.VITE_ENVIRONMENT,
  );
}

export function buildElizaSmsHref(message: string = IMESSAGE_GREETING): string {
  return `sms:${ELIZA_PHONE_NUMBER}?&body=${encodeURIComponent(message)}`;
}

export function buildElizaTelHref(): string {
  return `tel:${ELIZA_PHONE_NUMBER}`;
}

function canOpenNativeContactLink(navigatorValue: ContactNavigator): boolean {
  const platform =
    navigatorValue.userAgentData?.platform ?? navigatorValue.platform ?? "";
  const browserIdentity = `${platform} ${navigatorValue.userAgent ?? ""}`;
  return /Android|iPhone|iPad|iPod|Mac/i.test(browserIdentity);
}

/** Whether this browser runs on a platform with a dependable native SMS handler. */
export function canOpenElizaSmsLink(navigatorValue: ContactNavigator): boolean {
  return canOpenNativeContactLink(navigatorValue);
}

/** Open Messages where supported, otherwise copy the sender for manual use. */
export async function openOrCopyElizaMessage(
  windowValue: ContactWindow,
  message: string = IMESSAGE_GREETING,
): Promise<"handoff" | "copied"> {
  if (canOpenElizaSmsLink(windowValue.navigator)) {
    windowValue.location.href = buildElizaSmsHref(message);
    return "handoff";
  }

  if (!windowValue.navigator.clipboard) {
    throw new Error("Clipboard access is unavailable");
  }
  await windowValue.navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
  return "copied";
}

/** Open Phone where supported, otherwise copy the number for manual use. */
export async function openOrCopyElizaCall(
  windowValue: ContactWindow,
): Promise<"handoff" | "copied"> {
  if (canOpenNativeContactLink(windowValue.navigator)) {
    windowValue.location.href = buildElizaTelHref();
    return "handoff";
  }

  if (!windowValue.navigator.clipboard) {
    throw new Error("Clipboard access is unavailable");
  }
  await windowValue.navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
  return "copied";
}

export function buildElizaWhatsAppHref(): string | null {
  const number = getWhatsAppNumber();
  return number ? `https://wa.me/${number.replace(/\D/g, "")}` : null;
}

export function buildElizaTelegramHref(): string {
  return `https://t.me/${getTelegramBotUsername()}`;
}

export function buildElizaDiscordHrefForApplicationId(
  applicationId: string,
): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    integration_type: "1",
    scope: "applications.commands",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function buildElizaDiscordHref(): string {
  return buildElizaDiscordHrefForApplicationId(getDiscordBotApplicationId());
}

/**
 * Prepares first-run connector configuration for every application host.
 * Validation and legacy field normalization are pure; hosts retain credential
 * resolution, durable config commits, environment updates, and authorization.
 */
import type { ConnectorConfig, ElizaConfig } from "./config/types.eliza.js";
import { asRecord } from "./type-guards.js";

export interface CanonicalBlooioConnectorConfig {
  apiKey: string;
  webhookSecret: string;
  fromNumber: string;
  channelId: string;
}

export type BlooioFirstRunResolution =
  | { requested: false }
  | { requested: true; config: CanonicalBlooioConnectorConfig }
  | { requested: true; error: string };

function firstNonBlankString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Resolves legacy first-run fields into the complete canonical connector. */
export function resolveBlooioFirstRunConfig(input: {
  current?: Record<string, unknown> | null;
  explicit?: Record<string, unknown> | null;
  explicitConnectorRequested?: boolean;
  blooioApiKey?: unknown;
  blooioWebhookSecret?: unknown;
  blooioPhoneNumber?: unknown;
  blooioChannelId?: unknown;
}): BlooioFirstRunResolution {
  const legacyRequested = [
    input.blooioApiKey,
    input.blooioWebhookSecret,
    input.blooioPhoneNumber,
    input.blooioChannelId,
  ].some((value) => value !== undefined);
  const requested =
    input.explicitConnectorRequested === true ||
    (input.current !== null && input.current !== undefined) ||
    legacyRequested;
  if (!requested) return { requested: false };

  const apiKey = firstNonBlankString(
    input.explicit?.apiKey,
    input.blooioApiKey,
    input.current?.apiKey,
  );
  const webhookSecret = firstNonBlankString(
    input.explicit?.webhookSecret,
    input.blooioWebhookSecret,
    input.current?.webhookSecret,
  );
  const fromNumber = firstNonBlankString(
    input.explicit?.fromNumber,
    input.explicit?.phoneNumber,
    input.blooioPhoneNumber,
    input.current?.fromNumber,
    input.current?.phoneNumber,
  );
  const channelId = firstNonBlankString(
    input.explicit?.channelId,
    input.blooioChannelId,
    input.current?.channelId,
  );

  const missing = [
    ["apiKey", apiKey],
    ["webhookSecret", webhookSecret],
    ["fromNumber", fromNumber],
    ["channelId", channelId],
  ]
    .filter((entry) => !entry[1])
    .map((entry) => entry[0]);
  if (!apiKey || !webhookSecret || !fromNumber || !channelId) {
    return {
      requested: true,
      error: `Incomplete Blooio connector configuration; missing: ${missing.join(", ")}`,
    };
  }

  return {
    requested: true,
    config: {
      apiKey,
      webhookSecret,
      fromNumber,
      channelId,
    },
  };
}

export type FirstRunConnectorPreparation =
  | {
      ok: true;
      connectors: NonNullable<ElizaConfig["connectors"]>;
      env: Record<string, string>;
    }
  | { ok: false; error: string };

/** Resolve the complete connector update before any host persists setup state. */
export function prepareFirstRunConnectors(
  current: Pick<ElizaConfig, "connectors">,
  body: Record<string, unknown>,
): FirstRunConnectorPreparation {
  const requested = asRecord(body.connectors);
  const blooio = resolveBlooioFirstRunConfig({
    current: asRecord(current.connectors?.blooio),
    explicit: asRecord(requested?.blooio),
    explicitConnectorRequested: Boolean(
      requested && Object.hasOwn(requested, "blooio"),
    ),
    blooioApiKey: body.blooioApiKey,
    blooioWebhookSecret: body.blooioWebhookSecret,
    blooioPhoneNumber: body.blooioPhoneNumber,
    blooioChannelId: body.blooioChannelId,
  });
  if ("error" in blooio) return { ok: false, error: blooio.error };
  const connectors = { ...current.connectors };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(requested ?? {})) {
    const connector = asRecord(value);
    if (connector) {
      connectors[name] = {
        ...connectors[name],
        ...connector,
      } as ConnectorConfig;
    }
  }
  const telegramToken = firstNonBlankString(body.telegramToken);
  if (telegramToken) connectors.telegram = { botToken: telegramToken };
  const discordToken = firstNonBlankString(body.discordToken);
  if (discordToken) connectors.discord = { token: discordToken };
  const whatsappSessionPath = firstNonBlankString(body.whatsappSessionPath);
  if (whatsappSessionPath)
    connectors.whatsapp = { sessionPath: whatsappSessionPath };
  const twilioAccountSid = firstNonBlankString(body.twilioAccountSid);
  const twilioAuthToken = firstNonBlankString(body.twilioAuthToken);
  if (twilioAccountSid && twilioAuthToken) {
    env.TWILIO_ACCOUNT_SID = twilioAccountSid;
    env.TWILIO_AUTH_TOKEN = twilioAuthToken;
    const phoneNumber = firstNonBlankString(body.twilioPhoneNumber);
    if (phoneNumber) env.TWILIO_PHONE_NUMBER = phoneNumber;
  }
  if (blooio.requested) {
    connectors.blooio = { ...blooio.config };
    Object.assign(env, {
      IMESSAGE_TRANSPORT: "blooio",
      IMESSAGE_BLOOIO_API_KEY: blooio.config.apiKey,
      IMESSAGE_BLOOIO_WEBHOOK_SECRET: blooio.config.webhookSecret,
      IMESSAGE_BLOOIO_FROM_NUMBER: blooio.config.fromNumber,
      IMESSAGE_BLOOIO_CHANNEL_ID: blooio.config.channelId,
      BLOOIO_API_KEY: blooio.config.apiKey,
      BLOOIO_WEBHOOK_SECRET: blooio.config.webhookSecret,
      BLOOIO_FROM_NUMBER: blooio.config.fromNumber,
      BLOOIO_PHONE_NUMBER: blooio.config.fromNumber,
    });
  }
  return { ok: true, connectors, env };
}

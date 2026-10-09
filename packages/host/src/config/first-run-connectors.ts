/**
 * Prepares first-run connector configuration for every application host.
 * Validation is pure; hosts retain credential
 * resolution, durable config commits, environment updates, and authorization.
 */
import { asObjectRecord as asRecord } from "@elizaos/core/protocol";
import type { ConnectorConfig, ElizaConfig } from "./types.eliza.js";

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

interface BlooioFirstRunInput {
  current?: Record<string, unknown> | null;
  explicit?: Record<string, unknown> | null;
  explicitConnectorRequested?: boolean;
}

function readBlooioFields(input: BlooioFirstRunInput) {
  const apiKey = firstNonBlankString(
    input.explicit?.apiKey,
    input.current?.apiKey,
  );
  const webhookSecret = firstNonBlankString(
    input.explicit?.webhookSecret,
    input.current?.webhookSecret,
  );
  const fromNumber = firstNonBlankString(
    input.explicit?.fromNumber,
    input.current?.fromNumber,
  );
  const channelId = firstNonBlankString(
    input.explicit?.channelId,
    input.current?.channelId,
  );

  return { apiKey, webhookSecret, fromNumber, channelId };
}

/** Resolves a complete connector from an explicit update and saved credentials. */
export function resolveBlooioFirstRunConfig(
  input: BlooioFirstRunInput,
): BlooioFirstRunResolution {
  const requested = input.explicitConnectorRequested === true;
  if (!requested) return { requested: false };

  const { apiKey, webhookSecret, fromNumber, channelId } =
    readBlooioFields(input);

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
  const savedBlooio = asRecord(current.connectors?.blooio);
  const explicitBlooio = asRecord(requested?.blooio);
  const blooioDisabled =
    explicitBlooio?.enabled === false ||
    (explicitBlooio?.enabled !== true && savedBlooio?.enabled === false);
  const blooioInput: BlooioFirstRunInput = {
    current: savedBlooio,
    explicit: explicitBlooio,
    explicitConnectorRequested: Boolean(
      requested && Object.hasOwn(requested, "blooio"),
    ),
  };
  const blooio: BlooioFirstRunResolution = blooioDisabled
    ? { requested: false }
    : resolveBlooioFirstRunConfig(blooioInput);
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
  if (blooioDisabled) {
    const supplied = readBlooioFields({ ...blooioInput, current: undefined });
    for (const [field, value] of Object.entries(supplied)) {
      if (value !== undefined) {
        connectors.blooio = { ...connectors.blooio, [field]: value };
      }
    }
  }
  const twilioAccountSid = firstNonBlankString(body.twilioAccountSid);
  const twilioAuthToken = firstNonBlankString(body.twilioAuthToken);
  if (twilioAccountSid && twilioAuthToken) {
    env.TWILIO_ACCOUNT_SID = twilioAccountSid;
    env.TWILIO_AUTH_TOKEN = twilioAuthToken;
    const phoneNumber = firstNonBlankString(body.twilioPhoneNumber);
    if (phoneNumber) env.TWILIO_PHONE_NUMBER = phoneNumber;
  }
  if (blooio.requested) {
    connectors.blooio = { ...connectors.blooio, ...blooio.config };
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

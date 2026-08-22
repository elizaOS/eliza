/**
 * Declares the Cloud connector route, credential-field, and boundary-validation
 * contracts shared by the settings UI and its deterministic contract tests.
 */

export interface ConnectorConfig {
  id: string;
  name: string;
  group: "messaging" | "social" | "productivity";
  authMode: "token" | "oauth";
  oauthPlatform?: string;
  statusPath: string;
  connectPath: string;
  disconnectPath: string;
  fields?: ConnectorField[];
}

export interface ConnectorField {
  key: string;
  label: string;
  description?: string;
  type?: "text" | "password";
  placeholder?: string;
  required?: boolean;
  validation?: "telegram-bot-token" | "e164-phone-number";
}

export const CLOUD_CONNECTORS: ConnectorConfig[] = [
  {
    id: "discord",
    name: "Discord",
    group: "messaging",
    authMode: "token",
    statusPath: "/api/v1/discord/connections",
    connectPath: "/api/v1/discord/connections",
    disconnectPath: "/api/v1/discord/connections",
    fields: [
      {
        key: "applicationId",
        label: "Application ID",
        description: "Your Discord application ID from the Developer Portal.",
        placeholder: "1234567890123456789",
        required: true,
      },
      {
        key: "botToken",
        label: "Bot Token",
        description: "The bot token from your Discord application.",
        type: "password",
        placeholder: "MTk4NjIy...",
        required: true,
      },
    ],
  },
  {
    id: "telegram",
    name: "Telegram",
    group: "messaging",
    authMode: "token",
    statusPath: "/api/v1/telegram/status",
    connectPath: "/api/v1/telegram/connect",
    disconnectPath: "/api/v1/telegram/disconnect",
    fields: [
      {
        key: "botToken",
        label: "Bot Token",
        description: "Get this from @BotFather on Telegram.",
        type: "password",
        placeholder: "123456:ABC-DEF...",
        required: true,
        validation: "telegram-bot-token",
      },
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    group: "messaging",
    authMode: "token",
    statusPath: "/api/v1/whatsapp/status",
    connectPath: "/api/v1/whatsapp/connect",
    disconnectPath: "/api/v1/whatsapp/disconnect",
    fields: [
      {
        key: "accessToken",
        label: "Access Token",
        description: "WhatsApp Business API access token.",
        type: "password",
        placeholder: "EAAG...",
        required: true,
      },
      {
        key: "phoneNumberId",
        label: "Phone Number ID",
        placeholder: "123456789",
        required: true,
      },
      {
        key: "appSecret",
        label: "App Secret",
        description: "Used to verify webhook payloads.",
        type: "password",
        placeholder: "abc123...",
        required: true,
      },
    ],
  },
  {
    id: "twilio",
    name: "Twilio",
    group: "messaging",
    authMode: "token",
    statusPath: "/api/v1/twilio/status",
    connectPath: "/api/v1/twilio/connect",
    disconnectPath: "/api/v1/twilio/disconnect",
    fields: [
      {
        key: "accountSid",
        label: "Account SID",
        placeholder: "AC...",
        required: true,
      },
      {
        key: "authToken",
        label: "Auth Token",
        type: "password",
        placeholder: "your-twilio-auth-token",
        required: true,
      },
      {
        key: "phoneNumber",
        label: "Phone Number",
        placeholder: "+1234567890",
        required: true,
        validation: "e164-phone-number",
      },
    ],
  },
  {
    id: "google",
    name: "Google",
    group: "productivity",
    authMode: "oauth",
    oauthPlatform: "google",
    statusPath: "/api/v1/oauth/connections?platform=google",
    connectPath: "/api/v1/oauth/google/initiate",
    disconnectPath: "/api/v1/oauth/connections",
  },
  {
    id: "microsoft",
    name: "Microsoft",
    group: "productivity",
    authMode: "oauth",
    oauthPlatform: "microsoft",
    statusPath: "/api/v1/oauth/connections?platform=microsoft",
    connectPath: "/api/v1/oauth/microsoft/initiate",
    disconnectPath: "/api/v1/oauth/connections",
  },
  {
    id: "blooio",
    name: "Blooio",
    group: "productivity",
    authMode: "token",
    statusPath: "/api/v1/blooio/status",
    connectPath: "/api/v1/blooio/connect",
    disconnectPath: "/api/v1/blooio/disconnect",
    fields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "your-blooio-api-key",
        required: true,
      },
      { key: "phoneNumber", label: "Phone Number", placeholder: "+1234567890" },
      {
        key: "webhookSecret",
        label: "Webhook Secret",
        description: "Optional secret used to verify Blooio webhook payloads.",
        type: "password",
        placeholder: "your-webhook-secret",
      },
    ],
  },
];

export function getConnectorConfig(id: string): ConnectorConfig | null {
  return CLOUD_CONNECTORS.find((connector) => connector.id === id) ?? null;
}

export function connectorFieldValidationError(
  field: ConnectorField,
  value: string,
): string | null {
  const normalized = value.trim();
  if (field.required && normalized.length === 0)
    return `${field.label} is required.`;
  if (!normalized) return null;
  switch (field.validation) {
    case "telegram-bot-token":
      return normalized.length >= 30 ? null : "Bot Token is invalid.";
    case "e164-phone-number":
      return /^\+[1-9]\d{7,14}$/.test(normalized)
        ? null
        : "Phone Number must use E.164 format, for example +15551234567.";
    case undefined:
      return null;
  }
}

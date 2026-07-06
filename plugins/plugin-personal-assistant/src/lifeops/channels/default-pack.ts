/**
 * Default channel pack.
 *
 * Registers the union of `LIFEOPS_REMINDER_CHANNELS ∪ LIFEOPS_CHANNEL_TYPES
 * ∪ LIFEOPS_MESSAGE_CHANNELS` as `ChannelContribution` records.
 *
 * Channels delegate `send` to the matching `ConnectorContribution` so the
 * channel coverage invariant (`ChannelRegistry.list({ supports: { send } })
 * .length >= ConnectorRegistry.list({ capability: "send" }).length`) holds
 * automatically.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  ConnectorContribution,
  DispatchResult,
} from "../connectors/contract.js";
import { getConnectorRegistry } from "../connectors/registry.js";
import type {
  ChannelCapabilities,
  ChannelContribution,
  ChannelRegistry,
} from "./contract.js";

const NULL_CAPABILITIES: ChannelCapabilities = {
  send: false,
  read: false,
  reminders: false,
  voice: false,
  attachments: false,
  quietHoursAware: false,
};

const OWNER_PREFERRED_CHANNEL_KEY = "owner_preferred";

interface ChannelDescriptor {
  kind: string;
  label: string;
  capabilities: ChannelCapabilities;
  /**
   * The connector kind that supplies the underlying `send` dispatcher.
   * `null` for in-process channels (in_app, push, browser) where the
   * runtime owns delivery directly.
   */
  connectorKind: string | null;
}

const CHANNEL_DESCRIPTORS: readonly ChannelDescriptor[] = [
  // In-process delivery — runtime renders these directly.
  {
    kind: "in_app",
    label: "In-app card",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: false,
      reminders: true,
      attachments: true,
      quietHoursAware: false,
    },
    connectorKind: null,
  },
  {
    kind: "push",
    label: "Push notification",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: false,
      reminders: true,
      quietHoursAware: true,
    },
    connectorKind: null,
  },
  {
    kind: "browser",
    label: "Browser bridge",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: false,
      read: true,
    },
    connectorKind: null,
  },
  // Connector-backed channels.
  {
    kind: "email",
    label: "Email (Gmail)",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      read: true,
      reminders: false,
      attachments: true,
      quietHoursAware: true,
    },
    connectorKind: "google",
  },
  {
    kind: "imessage",
    label: "iMessage",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      read: true,
      reminders: true,
      attachments: true,
      quietHoursAware: true,
    },
    connectorKind: "imessage",
  },
  {
    kind: "telegram",
    label: "Telegram",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      read: true,
      reminders: true,
      attachments: true,
      quietHoursAware: true,
    },
    connectorKind: "telegram",
  },
  {
    kind: "discord",
    label: "Discord",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      read: true,
      reminders: true,
      attachments: true,
      quietHoursAware: true,
    },
    connectorKind: "discord",
  },
  {
    kind: "signal",
    label: "Signal",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      read: true,
      reminders: true,
      attachments: true,
      quietHoursAware: true,
    },
    connectorKind: "signal",
  },
  {
    kind: "whatsapp",
    label: "WhatsApp",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      read: true,
      reminders: true,
      attachments: true,
      quietHoursAware: true,
    },
    connectorKind: "whatsapp",
  },
  {
    kind: "x",
    label: "X (Twitter)",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      read: true,
      attachments: true,
    },
    connectorKind: "x",
  },
  {
    kind: "x_dm",
    label: "X DM",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      read: true,
      attachments: true,
      quietHoursAware: true,
    },
    connectorKind: "x",
  },
  {
    kind: "sms",
    label: "SMS (Twilio)",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      reminders: true,
      quietHoursAware: true,
    },
    connectorKind: "twilio",
  },
  {
    kind: "voice",
    label: "Voice (Twilio)",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      voice: true,
      reminders: true,
      quietHoursAware: true,
    },
    connectorKind: "twilio",
  },
  {
    kind: "twilio_voice",
    label: "Twilio voice call",
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      voice: true,
      reminders: true,
      quietHoursAware: true,
    },
    connectorKind: "twilio",
  },
];

const OWNER_CONNECTOR_PRIORITY = [
  "telegram",
  "discord",
  "signal",
  "whatsapp",
  "imessage",
  "twilio",
  "google",
  "x",
] as const;

const CHANNEL_TO_CONNECTOR_KIND: Readonly<Record<string, string>> = {
  email: "google",
  imessage: "imessage",
  telegram: "telegram",
  discord: "discord",
  signal: "signal",
  whatsapp: "whatsapp",
  x: "x",
  x_dm: "x",
  sms: "twilio",
  voice: "twilio",
  twilio_voice: "twilio",
};

function readSendPayloadTarget(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const target = (payload as { target?: unknown }).target;
  return typeof target === "string" && target.trim().length > 0
    ? target.trim()
    : null;
}

function withPayloadTarget(payload: unknown, target: string): unknown {
  return payload && typeof payload === "object"
    ? { ...(payload as Record<string, unknown>), target }
    : payload;
}

function parseExplicitConnectorTarget(
  target: string | null,
): { connectorKind: string; target: string } | null {
  if (!target) return null;
  const separatorIndex = target.indexOf(":");
  if (separatorIndex <= 0) return null;
  const prefix = target.slice(0, separatorIndex);
  const connectorKind = CHANNEL_TO_CONNECTOR_KIND[prefix] ?? prefix;
  const connectorTarget = target.slice(separatorIndex + 1).trim();
  return connectorTarget ? { connectorKind, target: connectorTarget } : null;
}

async function connectedConnector(
  connectors: ConnectorContribution[],
): Promise<ConnectorContribution | null> {
  const byKind = new Map(
    connectors.map((connector) => [connector.kind, connector]),
  );
  const priorityKinds = new Set<string>(OWNER_CONNECTOR_PRIORITY);
  for (const kind of OWNER_CONNECTOR_PRIORITY) {
    const connector = byKind.get(kind);
    if (!connector?.send) continue;
    const status = await connector.status();
    if (status.state === "ok") return connector;
  }
  for (const connector of connectors) {
    if (!connector.send || priorityKinds.has(connector.kind)) continue;
    const status = await connector.status();
    if (status.state === "ok") return connector;
  }
  return null;
}

function createOwnerPreferredChannel(
  runtime: IAgentRuntime,
): ChannelContribution {
  return {
    kind: OWNER_PREFERRED_CHANNEL_KEY,
    describe: { label: "Owner preferred connected channel" },
    capabilities: {
      ...NULL_CAPABILITIES,
      send: true,
      reminders: true,
      attachments: true,
      quietHoursAware: true,
    },
    async send(payload: unknown): Promise<DispatchResult> {
      const registry = getConnectorRegistry(runtime);
      if (!registry) {
        return {
          ok: false,
          reason: "transport_error",
          userActionable: false,
          message:
            "ConnectorRegistry is not registered on the runtime; owner-preferred channel cannot resolve a dispatcher.",
        };
      }
      const target = readSendPayloadTarget(payload);
      const explicit = parseExplicitConnectorTarget(target);
      const sendCapable = registry.list().filter((connector) => connector.send);
      if (explicit) {
        const connector = registry.get(explicit.connectorKind);
        if (!connector?.send) {
          return {
            ok: false,
            reason: "disconnected",
            userActionable: true,
            message: `Owner-preferred target "${target}" routes through connector "${explicit.connectorKind}", which is not registered or has no send.`,
          };
        }
        const status = await connector.status();
        if (status.state !== "ok") {
          return {
            ok: false,
            reason:
              status.state === "disconnected"
                ? "disconnected"
                : "transport_error",
            userActionable: true,
            message:
              status.message ??
              `Connector "${explicit.connectorKind}" is ${status.state}.`,
          };
        }
        return connector.send(withPayloadTarget(payload, explicit.target));
      }

      const connector = await connectedConnector(sendCapable);
      if (!connector?.send) {
        return {
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message:
            "No connected owner messaging connector is available for owner-preferred escalation.",
        };
      }
      if (!target || target === OWNER_PREFERRED_CHANNEL_KEY) {
        return {
          ok: false,
          reason: "unknown_recipient",
          userActionable: true,
          message:
            "Owner-preferred escalation needs a connector-qualified target such as telegram:<chat-id> or discord:<channel-id>.",
        };
      }
      return connector.send(payload);
    },
  };
}

function buildChannelContribution(
  descriptor: ChannelDescriptor,
  runtime: IAgentRuntime,
): ChannelContribution {
  if (!descriptor.capabilities.send || !descriptor.connectorKind) {
    return {
      kind: descriptor.kind,
      describe: { label: descriptor.label },
      capabilities: descriptor.capabilities,
    };
  }
  // Voice channels rewrite the send target so Twilio knows to use TwiML.
  const targetPrefix =
    descriptor.kind === "voice" || descriptor.kind === "twilio_voice"
      ? "voice:"
      : "";
  const connectorKind = descriptor.connectorKind;
  return {
    kind: descriptor.kind,
    describe: { label: descriptor.label },
    capabilities: descriptor.capabilities,
    async send(payload: unknown): Promise<DispatchResult> {
      const registry = getConnectorRegistry(runtime);
      if (!registry) {
        return {
          ok: false,
          reason: "transport_error",
          userActionable: false,
          message:
            "ConnectorRegistry is not registered on the runtime; channel send cannot resolve a dispatcher.",
        };
      }
      const connector = registry.get(connectorKind);
      if (!connector?.send) {
        return {
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message: `Channel "${descriptor.kind}" routes through connector "${connectorKind}" which is not registered or has no send.`,
        };
      }
      if (targetPrefix && payload && typeof payload === "object") {
        const p = payload as Record<string, unknown>;
        if (
          typeof p.target === "string" &&
          !p.target.startsWith(targetPrefix)
        ) {
          return connector.send({ ...p, target: `${targetPrefix}${p.target}` });
        }
      }
      return connector.send(payload);
    },
  };
}

/**
 * Empty default for callers that want a pre-built array; the descriptor
 * list is the source of truth.
 */
export const DEFAULT_CHANNEL_PACK: readonly ChannelContribution[] = [];

/**
 * The channel kinds shipped by the default pack. Mirrors the union of
 * `LIFEOPS_REMINDER_CHANNELS`, `LIFEOPS_CHANNEL_TYPES`, and
 * `LIFEOPS_MESSAGE_CHANNELS`.
 */
export const DEFAULT_CHANNEL_KINDS: readonly string[] = CHANNEL_DESCRIPTORS.map(
  (descriptor) => descriptor.kind,
).concat(OWNER_PREFERRED_CHANNEL_KEY);

export function registerDefaultChannelPack(
  registry: ChannelRegistry,
  runtime?: IAgentRuntime,
): void {
  if (!runtime) {
    // Some callsites pass only the registry; preserve that path.
    return;
  }
  for (const descriptor of CHANNEL_DESCRIPTORS) {
    registry.register(buildChannelContribution(descriptor, runtime));
  }
  registry.register(createOwnerPreferredChannel(runtime));
}

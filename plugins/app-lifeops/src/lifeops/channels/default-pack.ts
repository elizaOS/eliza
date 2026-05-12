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
import type { DispatchResult } from "../connectors/contract.js";
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
);

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
}

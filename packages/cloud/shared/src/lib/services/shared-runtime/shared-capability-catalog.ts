/**
 * Builds Shared's capability catalog from the services actually injected for
 * this turn, keeping prompts, refusal routing, and client handoffs consistent.
 */

import {
  type AgentCapabilityCatalog,
  type AgentCapabilityConsequence,
  type AgentCapabilityDescriptor,
  type AgentCapabilityId,
  type AgentCapabilityNextAction,
  type AgentCapabilityTransport,
} from "@elizaos/core/capability-catalog";

export interface SharedCapabilityFlags {
  webSearch: boolean;
  reminders: boolean;
  todos: boolean;
  media: boolean;
  transport?: AgentCapabilityTransport;
  /**
   * The Network's member capabilities. Present only on Network turns; when set,
   * the matching personal-workspace entries are described as available
   * Network actions instead of "needs workspace".
   */
  network?: { relay: boolean; scheduling: boolean; concierge: boolean };
}

/** Network replacements for workspace-only entries, keyed by catalog id. */
const NETWORK_CAPABILITIES: Partial<
  Record<
    AgentCapabilityId,
    { flag: "relay" | "scheduling" | "concierge"; definition: CapabilityDefinition }
  >
> = {
  communications: {
    flag: "relay",
    definition: {
      id: "communications",
      label: "Relay a message to another Network member",
      examples: ["Text Sam I'm in", "Tell Grace I'm running late"],
      consequence: "consequential",
      requiresConfirmation: true,
      nextAction: "none",
    },
  },
  calendar: {
    flag: "scheduling",
    definition: {
      id: "calendar",
      label: "Schedule time with another Network member",
      examples: ["Reschedule our coffee", "Find a time with Ada next week"],
      consequence: "consequential",
      requiresConfirmation: true,
      nextAction: "none",
    },
  },
  bookings: {
    flag: "concierge",
    definition: {
      id: "bookings",
      label: "Network concierge search",
      examples: ["Book a table for us", "Find a climbing gym near Ada"],
      consequence: "consequential",
      requiresConfirmation: true,
      nextAction: "none",
    },
  },
};

/** Map only trusted server-owned channel sources into catalog transports. */
export function sharedCapabilityTransportForSource(
  source: string | undefined,
  channelType?: string,
): AgentCapabilityTransport {
  if (channelType === "VOICE_DM" || channelType === "VOICE_GROUP") {
    return "voice";
  }
  switch (source?.trim().toLowerCase()) {
    case "discord":
    case "gateway-discord":
      return "discord";
    case "telegram":
      return "telegram";
    case "twilio-voice":
      return "voice";
    case "twilio":
    case "twilio-sms":
    case "blooio":
    case "sms":
    case "whatsapp":
      return "sms";
    case "client_chat":
    case "client-chat":
    case "app":
      return "app";
    case "web":
    case "client-web":
      return "web";
    default:
      return "api";
  }
}

const ALL_TRANSPORTS: readonly AgentCapabilityTransport[] = [
  "app",
  "web",
  "sms",
  "voice",
  "discord",
  "telegram",
  "api",
];

interface CapabilityDefinition {
  id: AgentCapabilityId;
  label: string;
  examples: readonly string[];
  consequence: AgentCapabilityConsequence;
  requiresConfirmation: boolean;
  nextAction: AgentCapabilityNextAction;
  connection?: string;
}

const ALWAYS_AVAILABLE: readonly CapabilityDefinition[] = [
  {
    id: "conversation",
    label: "Conversation and planning",
    examples: ["Make a plan", "Think through a decision"],
    consequence: "read_only",
    requiresConfirmation: false,
    nextAction: "none",
  },
  {
    id: "drafting",
    label: "Writing and drafting",
    examples: ["Draft an email", "Rewrite a note"],
    consequence: "read_only",
    requiresConfirmation: false,
    nextAction: "none",
  },
];

const PERSONAL_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: "calendar",
    label: "Calendar",
    examples: ["Check tomorrow", "Schedule a meeting"],
    consequence: "consequential",
    requiresConfirmation: true,
    nextAction: "upgrade_workspace",
    connection: "calendar",
  },
  {
    id: "bookings",
    label: "Bookings",
    examples: ["Reserve dinner", "Book travel"],
    consequence: "consequential",
    requiresConfirmation: true,
    nextAction: "upgrade_workspace",
  },
  {
    id: "communications",
    label: "Email, calls, and messages",
    examples: ["Send an email", "Text a contact"],
    consequence: "consequential",
    requiresConfirmation: true,
    nextAction: "upgrade_workspace",
    connection: "communications",
  },
  {
    id: "purchases",
    label: "Purchases",
    examples: ["Order groceries", "Buy tickets"],
    consequence: "consequential",
    requiresConfirmation: true,
    nextAction: "upgrade_workspace",
  },
  {
    id: "notes",
    label: "Persistent notes",
    examples: ["Save a note", "Find my notes"],
    consequence: "reversible_write",
    requiresConfirmation: false,
    nextAction: "upgrade_workspace",
  },
  {
    id: "cloud-apps",
    label: "Connected apps",
    examples: ["Search Gmail", "Read Google Drive"],
    consequence: "consequential",
    requiresConfirmation: true,
    nextAction: "upgrade_workspace",
    connection: "external account",
  },
  {
    id: "coding-runtime",
    label: "Coding workspace",
    examples: ["Edit a repository", "Run tests"],
    consequence: "reversible_write",
    requiresConfirmation: false,
    nextAction: "upgrade_workspace",
  },
  {
    id: "shell",
    label: "Shell",
    examples: ["Run a command"],
    consequence: "consequential",
    requiresConfirmation: true,
    nextAction: "upgrade_workspace",
  },
  {
    id: "filesystem",
    label: "Files",
    examples: ["Read a file", "Edit a document"],
    consequence: "reversible_write",
    requiresConfirmation: false,
    nextAction: "upgrade_workspace",
  },
  {
    id: "browser-control",
    label: "Browser control",
    examples: ["Open a page", "Fill a form"],
    consequence: "consequential",
    requiresConfirmation: true,
    nextAction: "upgrade_workspace",
  },
  {
    id: "profile-memory",
    label: "Personal profile and preferences",
    examples: ["Remember my location", "Remember how I work"],
    consequence: "reversible_write",
    requiresConfirmation: false,
    nextAction: "upgrade_workspace",
  },
];

function availableCapability(
  definition: CapabilityDefinition,
  transport: AgentCapabilityTransport,
): AgentCapabilityDescriptor {
  return {
    ...definition,
    availability: "available",
    currentTier: "shared",
    requiredTier: "shared",
    transports: [transport],
    prerequisites: [],
    nextAction: "none",
  };
}

function optionalSharedCapability(
  definition: CapabilityDefinition,
  available: boolean,
  transport: AgentCapabilityTransport,
): AgentCapabilityDescriptor {
  return available
    ? availableCapability(definition, transport)
    : {
        ...definition,
        availability: "unavailable",
        currentTier: "shared",
        requiredTier: "shared",
        transports: [transport],
        prerequisites: [],
        nextAction: "retry",
      };
}

/** Build the truthful per-turn catalog from host-attested runtime services. */
export function buildSharedCapabilityCatalog(flags: SharedCapabilityFlags): AgentCapabilityCatalog {
  const transport = flags.transport ?? "api";
  const optional: Array<[CapabilityDefinition, boolean]> = [
    [
      {
        id: "web-search",
        label: "Public web research",
        examples: ["Find current public information"],
        consequence: "read_only",
        requiresConfirmation: false,
        nextAction: "retry",
      },
      flags.webSearch,
    ],
    [
      {
        id: "reminders",
        label: "Reminders",
        examples: ["Remind me tomorrow"],
        consequence: "reversible_write",
        requiresConfirmation: false,
        nextAction: "retry",
      },
      flags.reminders,
    ],
    [
      {
        id: "todos",
        label: "Todos",
        examples: ["Add this to my list"],
        consequence: "reversible_write",
        requiresConfirmation: false,
        nextAction: "retry",
      },
      flags.todos,
    ],
    [
      {
        id: "image-generation",
        label: "Image generation",
        examples: ["Create an image"],
        consequence: "read_only",
        requiresConfirmation: false,
        nextAction: "retry",
      },
      flags.media,
    ],
  ];
  const network = flags.network;
  const networkAvailable = PERSONAL_CAPABILITIES.flatMap((definition) => {
    const replacement = NETWORK_CAPABILITIES[definition.id];
    return replacement && network?.[replacement.flag] === true
      ? [availableCapability(replacement.definition, transport)]
      : [];
  });
  const networkIds = new Set(networkAvailable.map((capability) => capability.id));
  const personal = PERSONAL_CAPABILITIES.filter(
    (definition) => !networkIds.has(definition.id),
  ).map<AgentCapabilityDescriptor>((definition) => ({
    ...definition,
    availability: "needs_workspace",
    currentTier: "shared",
    requiredTier: "personal",
    transports: ALL_TRANSPORTS,
    prerequisites: [
      {
        kind: "workspace",
        id: "personal",
        label: "Personal workspace",
      },
      ...(definition.connection
        ? [
            {
              kind: "connection" as const,
              id: definition.connection,
              label: `Connect ${definition.connection}`,
            },
          ]
        : []),
    ],
  }));
  return {
    version: 1,
    tier: "shared",
    transport,
    capabilities: [
      ...ALWAYS_AVAILABLE.map((definition) => availableCapability(definition, transport)),
      ...optional.map(([definition, available]) =>
        optionalSharedCapability(definition, available, transport),
      ),
      ...networkAvailable,
      ...personal,
    ],
  };
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

/** Detailed model-facing projection of the same typed catalog used by gates. */
export function formatSharedCapabilityCatalogForPrompt(catalog: AgentCapabilityCatalog): string {
  const capabilities = catalog.capabilities.map((capability) => {
    const prerequisites = capability.prerequisites.length
      ? capability.prerequisites.map((item) => item.label).join(", ")
      : "none";
    return [
      `- ${capability.label} (${capability.id})`,
      `availability: ${humanize(capability.availability)}`,
      `tier: ${capability.currentTier} -> ${capability.requiredTier}`,
      `examples: ${capability.examples.join("; ")}`,
      `prerequisites: ${prerequisites}`,
      `consequence: ${humanize(capability.consequence)}`,
      `confirmation: ${capability.requiresConfirmation ? "required before effect" : "not required"}`,
      `next: ${humanize(capability.nextAction)}`,
    ].join("; ");
  });
  return [
    `Capability tier: ${catalog.tier}. Transport: ${catalog.transport}.`,
    ...capabilities,
    "Offer only the smallest next setup step needed for the user's request.",
  ].join("\n");
}

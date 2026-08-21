/**
 * Builds Shared's capability catalog from the services actually injected for
 * this turn, keeping prompts, refusal routing, and client handoffs consistent.
 */

import type {
  AgentCapabilityCatalog,
  AgentCapabilityConsequence,
  AgentCapabilityDescriptor,
  AgentCapabilityId,
  AgentCapabilityNextAction,
  AgentCapabilityTransport,
} from "@elizaos/shared";

export interface SharedCapabilityFlags {
  webSearch: boolean;
  reminders: boolean;
  todos: boolean;
  media: boolean;
  transport?: AgentCapabilityTransport;
}

/** Map only trusted server-owned channel sources into catalog transports. */
export function sharedCapabilityTransportForSource(
  source: string | undefined,
): AgentCapabilityTransport {
  const normalized = source?.toLowerCase() ?? "";
  if (normalized.includes("discord")) return "discord";
  if (normalized.includes("telegram")) return "telegram";
  if (normalized.includes("voice")) return "voice";
  if (
    normalized.includes("twilio") ||
    normalized.includes("blooio") ||
    normalized.includes("sms")
  ) {
    return "sms";
  }
  if (normalized.includes("client") || normalized.includes("app")) return "app";
  if (normalized.includes("web")) return "web";
  return "api";
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
  const personal = PERSONAL_CAPABILITIES.map<AgentCapabilityDescriptor>((definition) => ({
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

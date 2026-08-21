/**
 * Registers the Shared runtime's self-description and safe Dedicated-upgrade
 * handoff action without provisioning compute or accepting billing consent.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core/edge";
import {
  type AgentCapabilityDescriptor,
  type AgentCapabilityId,
  type AgentCapabilityTransport,
  type CapabilityHandoffRequest,
  findAgentCapability,
} from "@elizaos/shared";
import {
  buildSharedCapabilityCatalog,
  formatSharedCapabilityCatalogForPrompt,
} from "./shared-capability-catalog";

export const SHARED_RUNTIME_CAPABILITIES_PROVIDER = "SHARED_RUNTIME_CAPABILITIES";
export const REQUEST_DEDICATED_UPGRADE_ACTION = "REQUEST_DEDICATED_UPGRADE";

export const SHARED_RUNTIME_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "conversation-durable-object",
  effects: ["upgrade-review-link"],
  requiredBindings: ["SHARED_RUNTIME_CONVERSATIONS"],
  requiredSecrets: [],
} as const;

/**
 * Audited plugin boundary for Workerd. Every first-party plugin that publishes
 * an explicit `./edge` entrypoint is registered; Node-only plugins stay behind
 * the Dedicated handoff instead of being bundled speculatively.
 */
export const SHARED_RUNTIME_PLUGIN_COMPATIBILITY = [
  {
    plugin: "@elizaos/core/edge",
    status: "enabled",
    provides: ["AgentRuntime", "basic actions", "character and dynamic providers"],
  },
  {
    plugin: "@elizaos/plugin-web-search/edge",
    status: "enabled",
    provides: ["public web search"],
  },
  {
    plugin: "@elizaos/plugin-scheduling/edge",
    status: "enabled-when-bound",
    provides: ["private reminders"],
  },
  {
    plugin: "@elizaos/plugin-todos/edge",
    status: "enabled-when-bound",
    provides: ["persistent todos"],
  },
  {
    plugin: "shared-cloud-media",
    status: "enabled-when-bound",
    provides: ["image generation"],
  },
  {
    plugin: "node-or-container-only plugins",
    status: "dedicated-required",
    provides: ["coding", "shell", "filesystem", "browser", "private account connectors"],
  },
] as const;

export interface SharedRuntimeCapabilityOptions {
  agentId: string;
  webSearch: boolean;
  reminders: boolean;
  todos: boolean;
  media: boolean;
  transport?: AgentCapabilityTransport;
}

export function createSharedRuntimeCapabilitiesProvider(
  options: SharedRuntimeCapabilityOptions,
): Provider {
  return {
    name: SHARED_RUNTIME_CAPABILITIES_PROVIDER,
    description: "The current Shared runtime's available and Dedicated-only capabilities.",
    position: -100,
    cacheStable: true,
    cacheScope: "turn",
    roleGate: { minRole: "GUEST" },
    get: async (): Promise<ProviderResult> => {
      const catalog = buildSharedCapabilityCatalog(options);
      const available = catalog.capabilities
        .filter((capability) => capability.availability === "available")
        .map((capability) => capability.label);
      const dedicatedRequired = catalog.capabilities
        .filter((capability) => capability.requiredTier === "personal")
        .map((capability) => capability.label);
      return {
        text: [
          "# Runtime capabilities",
          "",
          formatSharedCapabilityCatalogForPrompt(catalog),
          `Use ${REQUEST_DEDICATED_UPGRADE_ACTION} only when the user asks to review upgrading for a capability Shared cannot perform. It opens a review flow and never starts paid compute by itself.`,
        ].join("\n"),
        values: {
          capabilityTier: catalog.tier,
          capabilityTransport: catalog.transport,
        },
        data: {
          runtimeMode: "shared",
          agentId: options.agentId,
          available,
          dedicatedRequired,
          agentCapabilityCatalog: catalog,
          canRequestDedicatedReview: true,
          canActivateDedicatedWithoutConfirmation: false,
        },
      };
    },
  };
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function handoffFor(
  options: SharedRuntimeCapabilityOptions,
  capability: AgentCapabilityDescriptor,
  message: Memory,
): CapabilityHandoffRequest {
  if (capability.availability === "available") {
    throw new Error(`Capability ${capability.id} does not need setup`);
  }
  const originalIntent = boundedString(message.content?.text, 4_000);
  const idempotency = message.content?.chatIdempotency;
  const clientMessageId =
    idempotency && typeof idempotency === "object" && "clientMessageId" in idempotency
      ? boundedString(idempotency.clientMessageId, 128)
      : undefined;
  return {
    version: 1,
    kind: "capability_handoff",
    capabilityId: capability.id,
    label: capability.label,
    availability: capability.availability,
    reason: `${capability.label} needs setup before it can be used safely.`,
    currentTier: capability.currentTier,
    requiredTier: capability.requiredTier,
    nextAction: capability.nextAction === "none" ? "retry" : capability.nextAction,
    // A workspace upgrade is itself consequential even when the requested
    // capability (for example research) would not require confirmation.
    requiresConfirmation: true,
    cta: {
      label: "Set up personal workspace",
      href: `/cloud/agents/${encodeURIComponent(options.agentId)}`,
    },
    ...(originalIntent || clientMessageId
      ? {
          continuation: {
            ...(originalIntent ? { originalIntent } : {}),
            ...(clientMessageId ? { clientMessageId } : {}),
          },
        }
      : {}),
  };
}

function readParameters(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return record.parameters && typeof record.parameters === "object"
    ? (record.parameters as Record<string, unknown>)
    : record;
}

export function createRequestDedicatedUpgradeAction(
  options: SharedRuntimeCapabilityOptions,
): Action {
  const catalog = buildSharedCapabilityCatalog(options);
  const dedicatedIds = catalog.capabilities
    .filter((capability) => capability.requiredTier === "personal")
    .map((capability) => capability.id);
  return {
    name: REQUEST_DEDICATED_UPGRADE_ACTION,
    similes: ["UPGRADE_AGENT", "ENABLE_ADVANCED_CAPABILITIES", "GET_DEDICATED"],
    tags: ["resource:cloud", "capability:read"],
    contexts: ["general"],
    roleGate: { minRole: "GUEST" },
    suppressEarlyReply: true,
    description:
      "Return the explicit review link for moving this Shared agent to Dedicated when the user asks for coding, shell, browser control, connected accounts, or another unavailable advanced capability. After this action, explain the result naturally in the agent's voice. This action does not purchase, provision, or activate anything.",
    parameters: [
      {
        name: "capabilityId",
        description: "The unavailable capability id from the runtime capability provider.",
        required: true,
        schema: { type: "string", enum: dedicatedIds },
      },
    ],
    validate: async () => true,
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      handlerOptions?: unknown,
      _callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const parameters = readParameters(handlerOptions);
      const capabilityId = boundedString(parameters.capabilityId, 64) as
        | AgentCapabilityId
        | undefined;
      const capability = capabilityId ? findAgentCapability(catalog, capabilityId) : undefined;
      if (!capability || capability.availability === "available") {
        return {
          success: false,
          text: "The requested capability does not need a personal-workspace handoff.",
          error: new Error("Unknown or already available capability"),
        };
      }
      const capabilityHandoff = handoffFor(options, capability, message);
      // This is a structured tool receipt, not end-user copy. The normal
      // post-action model continuation turns it into an in-character response.
      const text = `Personal-workspace review is available for ${capability.label}; no mutation or charge was performed.`;
      return {
        success: true,
        text,
        data: {
          actionName: REQUEST_DEDICATED_UPGRADE_ACTION,
          capabilityId: capability.id,
          capabilityHandoff,
          upgradePath: capabilityHandoff.cta.href,
          mutationPerformed: false,
          requiresUserConfirmation: true,
        },
        values: { capabilityHandoff },
      };
    },
  };
}

export function createSharedRuntimeCapabilitiesPlugin(
  options: SharedRuntimeCapabilityOptions,
): Plugin {
  return {
    name: "shared-runtime-capabilities",
    description: "Shared runtime capability context and safe Dedicated review handoff.",
    providers: [createSharedRuntimeCapabilitiesProvider(options)],
    actions: [createRequestDedicatedUpgradeAction(options)],
  };
}

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
}

function availableCapabilities(options: SharedRuntimeCapabilityOptions): string[] {
  return [
    "conversation and reasoning",
    "conversation memory",
    ...(options.webSearch ? ["public web search"] : []),
    ...(options.reminders ? ["private reminders"] : []),
    ...(options.todos ? ["persistent todos"] : []),
    ...(options.media ? ["image generation"] : []),
  ];
}

const DEDICATED_CAPABILITIES = [
  "coding and sub-agents",
  "shell and filesystem",
  "browser or computer control",
  "connected private accounts",
  "arbitrary outbound communications",
] as const;

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
      const available = availableCapabilities(options);
      return {
        text: [
          "# Runtime capabilities",
          "",
          "This agent is running on Shared, stateless edge compute.",
          `Available now: ${available.join(", ")}.`,
          `Dedicated required: ${DEDICATED_CAPABILITIES.join(", ")}.`,
          `Use ${REQUEST_DEDICATED_UPGRADE_ACTION} only when the user asks to review upgrading for a capability Shared cannot perform. It opens a review flow and never starts paid compute by itself.`,
        ].join("\n"),
        data: {
          runtimeMode: "shared",
          agentId: options.agentId,
          available,
          dedicatedRequired: [...DEDICATED_CAPABILITIES],
          canRequestDedicatedReview: true,
          canActivateDedicatedWithoutConfirmation: false,
        },
      };
    },
  };
}

function readParameters(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return record.parameters && typeof record.parameters === "object"
    ? (record.parameters as Record<string, unknown>)
    : record;
}

export function createRequestDedicatedUpgradeAction(agentId: string): Action {
  return {
    name: REQUEST_DEDICATED_UPGRADE_ACTION,
    similes: ["UPGRADE_AGENT", "ENABLE_ADVANCED_CAPABILITIES", "GET_DEDICATED"],
    tags: ["resource:cloud", "capability:read"],
    contexts: ["general"],
    roleGate: { minRole: "GUEST" },
    suppressEarlyReply: true,
    suppressPostActionContinuation: true,
    description:
      "Give the user the explicit review link for moving this Shared agent to Dedicated when they ask for coding, shell, browser control, connected accounts, or another unavailable advanced capability. This action does not purchase, provision, or activate anything.",
    parameters: [
      {
        name: "capability",
        description: "The unavailable capability that motivated the user's upgrade request.",
        required: false,
        schema: { type: "string", maxLength: 160 },
      },
    ],
    validate: async () => true,
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state?: State,
      handlerOptions?: unknown,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const parameters = readParameters(handlerOptions);
      const capability =
        typeof parameters.capability === "string" && parameters.capability.trim()
          ? parameters.capability.trim().slice(0, 160)
          : "advanced capabilities";
      const upgradePath = `/cloud/agents/${encodeURIComponent(agentId)}`;
      const text = `Shared can't perform ${capability}. You can review Dedicated capabilities, price, and confirmation here: ${upgradePath}. Nothing has been activated or charged.`;
      await callback?.({ text });
      return {
        success: true,
        text,
        data: {
          actionName: REQUEST_DEDICATED_UPGRADE_ACTION,
          capability,
          upgradePath,
          mutationPerformed: false,
          requiresUserConfirmation: true,
        },
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
    actions: [createRequestDedicatedUpgradeAction(options.agentId)],
  };
}

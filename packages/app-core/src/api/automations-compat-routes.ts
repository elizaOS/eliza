/**
 * Automations node-catalog endpoint.
 *
 * The full Automations list/CRUD surface (`GET /api/automations` etc.) lives in
 * `@elizaos/plugin-workflow` (`src/routes/automations.ts`) — the workflow
 * plugin owns the unified workflow + trigger model.
 *
 * This file remains in app-core because the node catalog (`/api/automations/nodes`)
 * is multi-domain: it enumerates runtime actions/providers, static automation
 * specs, and dynamically-registered contributors via
 * `listAutomationNodeContributors()`. Other plugins (LifeOps, etc.) register
 * contributors here, so the registry must live where it can be loaded by all
 * consumers without a workflow plugin dependency.
 */

import type http from "node:http";
import { loadElizaConfig } from "@elizaos/agent";
import { type AgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import type {
  AutomationNodeCatalogResponse,
  AutomationNodeDescriptor,
} from "@elizaos/ui";
import { ensureRouteAuthorized } from "./auth";
import { listAutomationNodeContributors } from "./automation-node-contributors";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

const BLOCKED_AUTOMATION_PROVIDER_NODES = new Set([
  "recent-conversations",
  "relevant-conversations",
]);

interface StaticAutomationNodeSpec {
  id: string;
  label: string;
  description: string;
  class: AutomationNodeDescriptor["class"];
  backingCapability: string;
  actionNames: string[];
  pluginNames: string[];
  ownerScoped: boolean;
  enabledWithoutRuntimeCapability: boolean;
  disabledReason: string;
}

const STATIC_AUTOMATION_NODE_SPECS: StaticAutomationNodeSpec[] = [
  {
    id: "crypto:evm.swap",
    label: "EVM swap",
    description:
      "EVM token swap automation backed by a loaded EVM runtime action.",
    class: "action",
    backingCapability: "SWAP",
    actionNames: ["SWAP", "SWAP_TOKENS", "SWAP_TOKEN"],
    pluginNames: ["evm", "wallet", "plugin-wallet", "@elizaos/plugin-wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the EVM plugin with swap support.",
  },
  {
    id: "crypto:evm.bridge",
    label: "EVM bridge",
    description:
      "EVM cross-chain bridge automation backed by a loaded EVM runtime action.",
    class: "action",
    backingCapability: "CROSS_CHAIN_TRANSFER",
    actionNames: ["CROSS_CHAIN_TRANSFER", "BRIDGE", "BRIDGE_TOKENS"],
    pluginNames: ["evm", "wallet", "plugin-wallet", "@elizaos/plugin-wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the EVM plugin with bridge support.",
  },
  {
    id: "crypto:solana.swap",
    label: "Solana swap",
    description:
      "Solana token swap automation backed by a loaded Solana runtime action.",
    class: "action",
    backingCapability: "SWAP_SOLANA",
    actionNames: [
      "SWAP_SOLANA",
      "SWAP_SOL",
      "SWAP_TOKENS_SOLANA",
      "TOKEN_SWAP_SOLANA",
      "TRADE_TOKENS_SOLANA",
      "EXCHANGE_TOKENS_SOLANA",
    ],
    pluginNames: [
      "chain_solana",
      "solana",
      "wallet",
      "plugin-wallet",
      "@elizaos/plugin-wallet",
    ],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the Solana plugin with swap support.",
  },
  {
    id: "crypto:hyperliquid.action",
    label: "Hyperliquid action",
    description:
      "Hyperliquid automation entry point backed by a loaded Hyperliquid runtime plugin.",
    class: "action",
    backingCapability: "HYPERLIQUID_ACTION",
    actionNames: [
      "HYPERLIQUID_ACTION",
      "HYPERLIQUID_ORDER",
      "HYPERLIQUID_TRADE",
    ],
    pluginNames: [
      "hyperliquid",
      "plugin-hyperliquid",
      "@elizaos/plugin-hyperliquid",
    ],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the Hyperliquid runtime plugin.",
  },
  {
    id: "trigger:order.schedule",
    label: "Order schedule",
    description:
      "Schedule order-intent workflows; venue execution still requires a loaded trading action.",
    class: "trigger",
    backingCapability: "ORDER_SCHEDULE",
    actionNames: [],
    pluginNames: [],
    ownerScoped: false,
    enabledWithoutRuntimeCapability: true,
    disabledReason: "Automation schedules are unavailable.",
  },
  {
    id: "trigger:order.event",
    label: "Order event",
    description:
      "React to order lifecycle events emitted by a loaded trading venue plugin.",
    class: "trigger",
    backingCapability: "ORDER_EVENT",
    actionNames: [
      "ORDER_EVENT",
      "ORDER_FILLED",
      "ORDER_UPDATED",
      "HYPERLIQUID_ACTION",
    ],
    pluginNames: [
      "hyperliquid",
      "plugin-hyperliquid",
      "@elizaos/plugin-hyperliquid",
    ],
    ownerScoped: false,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load an order-event-capable runtime plugin.",
  },
];

function humanizeCapabilityName(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveAgentName(
  runtime: AgentRuntime | null,
  config: ReturnType<typeof loadElizaConfig>,
): string {
  return (
    runtime?.character?.name?.trim() ||
    config.ui?.assistant?.name?.trim() ||
    "Eliza"
  );
}

function resolveAdminEntityId(
  config: ReturnType<typeof loadElizaConfig>,
  agentName: string,
): UUID {
  const configured = config.agents?.defaults?.adminEntityId?.trim();
  if (configured) {
    return configured as UUID;
  }
  return stringToUuid(`${agentName}-admin-entity`) as UUID;
}

function normalizeCapabilityName(value: string): string {
  return value.trim().toLowerCase();
}

function getRuntimeActionCapabilityNames(runtime: AgentRuntime): Set<string> {
  const names = new Set<string>();
  for (const action of runtime.actions) {
    names.add(normalizeCapabilityName(action.name));
    for (const simile of action.similes ?? []) {
      names.add(normalizeCapabilityName(simile));
    }
  }
  return names;
}

function getRuntimePluginNames(runtime: AgentRuntime): Set<string> {
  return new Set(
    (runtime.plugins ?? [])
      .map((plugin) => normalizeCapabilityName(plugin.name))
      .filter((name) => name.length > 0),
  );
}

function hasMatchingRuntimeCapability(
  spec: StaticAutomationNodeSpec,
  actionNames: Set<string>,
  pluginNames: Set<string>,
): boolean {
  if (spec.enabledWithoutRuntimeCapability) {
    return true;
  }
  return (
    spec.actionNames.some((name) =>
      actionNames.has(normalizeCapabilityName(name)),
    ) ||
    spec.pluginNames.some((name) =>
      pluginNames.has(normalizeCapabilityName(name)),
    )
  );
}

function buildStaticAutomationNode(
  spec: StaticAutomationNodeSpec,
  actionNames: Set<string>,
  pluginNames: Set<string>,
): AutomationNodeDescriptor {
  const enabled = hasMatchingRuntimeCapability(spec, actionNames, pluginNames);
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    class: spec.class,
    source: "static_catalog",
    backingCapability: spec.backingCapability,
    ownerScoped: spec.ownerScoped,
    requiresSetup: !enabled,
    availability: enabled ? "enabled" : "disabled",
    ...(enabled ? {} : { disabledReason: spec.disabledReason }),
  };
}

async function buildAutomationNodeCatalog(
  state: CompatRuntimeState,
): Promise<AutomationNodeCatalogResponse> {
  const runtime = state.current;
  if (!runtime) {
    throw new Error("Agent runtime is not available");
  }

  const config = loadElizaConfig();
  const agentName = resolveAgentName(runtime, config);
  const adminEntityId = resolveAdminEntityId(config, agentName);

  const runtimeActionNodes: AutomationNodeDescriptor[] = runtime.actions
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((action) => ({
      id: `action:${action.name}`,
      label: humanizeCapabilityName(action.name),
      description: action.description || `${action.name} runtime action`,
      class:
        action.name === "START_CODING_TASK" ||
        action.name === "CREATE_TASK" ||
        action.name === "CODE_TASK"
          ? "agent"
          : "action",
      source: "runtime_action",
      backingCapability: action.name,
      ownerScoped: false,
      requiresSetup: false,
      availability: "enabled",
    }));

  const runtimeProviderNodes: AutomationNodeDescriptor[] = runtime.providers
    .slice()
    .filter((provider) => !BLOCKED_AUTOMATION_PROVIDER_NODES.has(provider.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((provider) => ({
      id: `provider:${provider.name}`,
      label: humanizeCapabilityName(provider.name),
      description: provider.description || `${provider.name} runtime provider`,
      class: "context",
      source: "runtime_provider",
      backingCapability: provider.name,
      ownerScoped: false,
      requiresSetup: false,
      availability: "enabled",
    }));

  const runtimeActionCapabilityNames = getRuntimeActionCapabilityNames(runtime);
  const runtimePluginNames = getRuntimePluginNames(runtime);
  const staticAutomationNodes = STATIC_AUTOMATION_NODE_SPECS.map((spec) =>
    buildStaticAutomationNode(
      spec,
      runtimeActionCapabilityNames,
      runtimePluginNames,
    ),
  );
  const contributorNodeGroups = await Promise.all(
    listAutomationNodeContributors().map((contributor) =>
      contributor({ runtime, config, agentName, adminEntityId }),
    ),
  );
  const contributorNodes = contributorNodeGroups.flat();

  const nodes = [
    ...runtimeActionNodes,
    ...runtimeProviderNodes,
    ...staticAutomationNodes,
    ...contributorNodes,
  ].sort((left, right) => {
    if (left.class !== right.class) {
      return left.class.localeCompare(right.class);
    }
    return left.label.localeCompare(right.label);
  });

  return {
    nodes,
    summary: {
      total: nodes.length,
      enabled: nodes.filter((node) => node.availability === "enabled").length,
      disabled: nodes.filter((node) => node.availability === "disabled").length,
    },
  };
}

export async function handleAutomationsCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/automations")) {
    return false;
  }

  if (!(await ensureRouteAuthorized(req, res, state))) {
    return true;
  }

  if (method === "GET" && url.pathname === "/api/automations/nodes") {
    if (!state.current) {
      sendJsonErrorResponse(res, 503, "Agent runtime is not available");
      return true;
    }
    const payload = await buildAutomationNodeCatalog(state);
    sendJsonResponse(res, 200, payload);
    return true;
  }

  // /api/automations (root listing) is served by @elizaos/plugin-workflow.
  return false;
}

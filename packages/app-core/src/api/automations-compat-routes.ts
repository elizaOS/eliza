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
} from "@elizaos/shared";
import { ensureRouteAuthorized } from "./auth.ts";
import { classifyRuntimeActionNode } from "./automation-action-classifier.ts";
import {
  buildRuntimeCapabilityNodes,
  listAutomationNodeContributors,
  type RuntimeCapabilityNodeSpec,
} from "./automation-node-contributors";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

const BLOCKED_AUTOMATION_PROVIDER_NODES = new Set([
  "recent-conversations",
  "relevant-conversations",
]);

/**
 * Domain-agnostic automation trigger nodes that app-core owns directly. Nodes
 * backed by a specific plugin's actions (wallet/EVM/Solana swaps + bridges,
 * Hyperliquid trading, venue order events) are contributed by their owning
 * plugin via {@link registerAutomationNodeContributor}, so a plugin action
 * rename can never silently disable a node from here.
 */
const STATIC_AUTOMATION_NODE_SPECS: RuntimeCapabilityNodeSpec[] = [
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

  const runtimeActionNodes: AutomationNodeDescriptor[] = (runtime.actions ?? [])
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((action) => ({
      id: `action:${action.name}`,
      label: humanizeCapabilityName(action.name),
      description: action.description || `${action.name} runtime action`,
      class: classifyRuntimeActionNode(action),
      source: "runtime_action",
      backingCapability: action.name,
      ownerScoped: false,
      requiresSetup: false,
      availability: "enabled",
    }));

  const runtimeProviderNodes: AutomationNodeDescriptor[] = (
    runtime.providers ?? []
  )
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

  const staticAutomationNodes = buildRuntimeCapabilityNodes(
    STATIC_AUTOMATION_NODE_SPECS,
    runtime,
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

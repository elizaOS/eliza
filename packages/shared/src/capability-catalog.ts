/**
 * Cross-runtime capability contracts keep agent prompts, safety gates, and UI
 * handoffs aligned without importing a server or renderer implementation.
 */

export type AgentExecutionTier = "shared" | "personal";

export type AgentCapabilityAvailability =
  | "available"
  | "needs_account"
  | "needs_workspace"
  | "needs_connection"
  | "needs_permission"
  | "provisioning"
  | "unavailable";

export type AgentCapabilityConsequence =
  | "read_only"
  | "reversible_write"
  | "consequential";

export type AgentCapabilityNextAction =
  | "none"
  | "sign_up"
  | "upgrade_workspace"
  | "connect_account"
  | "request_permission"
  | "wait_for_provisioning"
  | "retry";

export type AgentCapabilityId =
  | "conversation"
  | "drafting"
  | "web-search"
  | "reminders"
  | "todos"
  | "image-generation"
  | "calendar"
  | "bookings"
  | "communications"
  | "purchases"
  | "notes"
  | "cloud-apps"
  | "coding-runtime"
  | "shell"
  | "filesystem"
  | "browser-control"
  | "profile-memory";

export type AgentCapabilityTransport =
  | "app"
  | "web"
  | "sms"
  | "voice"
  | "discord"
  | "telegram"
  | "api";

export interface AgentCapabilityPrerequisite {
  kind: "account" | "workspace" | "connection" | "permission";
  id: string;
  label: string;
}

export interface AgentCapabilityDescriptor {
  id: AgentCapabilityId;
  label: string;
  examples: readonly string[];
  availability: AgentCapabilityAvailability;
  currentTier: AgentExecutionTier;
  requiredTier: AgentExecutionTier;
  transports: readonly AgentCapabilityTransport[];
  prerequisites: readonly AgentCapabilityPrerequisite[];
  consequence: AgentCapabilityConsequence;
  requiresConfirmation: boolean;
  nextAction: AgentCapabilityNextAction;
}

export interface AgentCapabilityCatalog {
  version: 1;
  tier: AgentExecutionTier;
  transport: AgentCapabilityTransport;
  capabilities: readonly AgentCapabilityDescriptor[];
}

export interface CapabilityHandoffRequest {
  version: 1;
  kind: "capability_handoff";
  capabilityId: AgentCapabilityId;
  label: string;
  availability: Exclude<AgentCapabilityAvailability, "available">;
  reason: string;
  currentTier: AgentExecutionTier;
  requiredTier: AgentExecutionTier;
  nextAction: Exclude<AgentCapabilityNextAction, "none">;
  requiresConfirmation: boolean;
  cta: {
    label: string;
    href: string;
  };
  continuation?: {
    clientMessageId?: string;
    originalIntent?: string;
  };
}

/** Find one capability without making callers duplicate catalog traversal. */
export function findAgentCapability(
  catalog: AgentCapabilityCatalog,
  id: AgentCapabilityId,
): AgentCapabilityDescriptor | undefined {
  return catalog.capabilities.find((capability) => capability.id === id);
}

/** Compact prompt projection; the structured catalog remains authoritative. */
export function formatAgentCapabilityCatalog(
  catalog: AgentCapabilityCatalog,
): string {
  const available = catalog.capabilities
    .filter((capability) => capability.availability === "available")
    .map((capability) => capability.label);
  const gated = catalog.capabilities
    .filter((capability) => capability.availability !== "available")
    .map(
      (capability) =>
        `${capability.label} (${capability.availability.replaceAll("_", " ")})`,
    );
  return [
    `Capability tier: ${catalog.tier}. Transport: ${catalog.transport}.`,
    `Available now: ${available.join(", ") || "none"}.`,
    `Needs setup: ${gated.join(", ") || "none"}.`,
    "Offer the smallest valid setup step only when it unlocks the user's request.",
  ].join("\n");
}

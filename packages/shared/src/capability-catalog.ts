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

const CAPABILITY_IDS: ReadonlySet<string> = new Set<AgentCapabilityId>([
  "conversation",
  "drafting",
  "web-search",
  "reminders",
  "todos",
  "image-generation",
  "calendar",
  "bookings",
  "communications",
  "purchases",
  "notes",
  "cloud-apps",
  "coding-runtime",
  "shell",
  "filesystem",
  "browser-control",
  "profile-memory",
]);
const PERSONAL_WORKSPACE_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "calendar",
  "bookings",
  "communications",
  "purchases",
  "notes",
  "cloud-apps",
  "coding-runtime",
  "shell",
  "filesystem",
  "browser-control",
  "profile-memory",
]);
const HANDOFF_AVAILABILITIES: ReadonlySet<string> = new Set([
  "needs_account",
  "needs_workspace",
  "needs_connection",
  "needs_permission",
  "provisioning",
  "unavailable",
]);
const HANDOFF_NEXT_ACTIONS: ReadonlySet<string> = new Set([
  "sign_up",
  "upgrade_workspace",
  "connect_account",
  "request_permission",
  "wait_for_provisioning",
  "retry",
]);

function handoffRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function hasOwnHandoffField(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return Object.hasOwn(value, key);
}

function boundedHandoffText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : null;
}

function completeHandoffText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Extract the source Shared-agent id from the sole contained setup route. */
export function capabilityHandoffTargetAgentId(href: string): string | null {
  const match = /^\/cloud\/agents\/([^/?#]+)$/.exec(href);
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    if (
      decoded.length === 0 ||
      decoded.length > 256 ||
      !/^(?:personal:)?[A-Za-z0-9_-]+$/.test(decoded)
    ) {
      return null;
    }
    const encoded = encodeURIComponent(decoded);
    if (
      match[1] !== decoded &&
      match[1].toUpperCase() !== encoded.toUpperCase()
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Validate the review-only Shared-to-personal handoff accepted by app clients.
 * Unknown versions, enum values, relationship combinations, oversized text,
 * and non-contained routes fail closed instead of being coerced.
 */
export function parsePersonalWorkspaceCapabilityHandoff(
  value: unknown,
  expectedAgentId?: string | null,
): CapabilityHandoffRequest | null {
  try {
    return parsePersonalWorkspaceCapabilityHandoffUnsafe(
      value,
      expectedAgentId,
    );
  } catch {
    return null;
  }
}

function parsePersonalWorkspaceCapabilityHandoffUnsafe(
  value: unknown,
  expectedAgentId?: string | null,
): CapabilityHandoffRequest | null {
  const handoff = handoffRecord(value);
  if (!handoff) return null;
  if (
    handoff.version !== 1 ||
    handoff.kind !== "capability_handoff" ||
    handoff.currentTier !== "shared" ||
    handoff.requiredTier !== "personal" ||
    handoff.availability !== "needs_workspace" ||
    handoff.nextAction !== "upgrade_workspace" ||
    handoff.requiresConfirmation !== true ||
    typeof handoff.capabilityId !== "string" ||
    !CAPABILITY_IDS.has(handoff.capabilityId) ||
    !PERSONAL_WORKSPACE_CAPABILITY_IDS.has(handoff.capabilityId) ||
    typeof handoff.availability !== "string" ||
    !HANDOFF_AVAILABILITIES.has(handoff.availability) ||
    typeof handoff.nextAction !== "string" ||
    !HANDOFF_NEXT_ACTIONS.has(handoff.nextAction)
  ) {
    return null;
  }
  const label = boundedHandoffText(handoff.label, 120);
  const reason = boundedHandoffText(handoff.reason, 500);
  const cta = handoffRecord(handoff.cta);
  const ctaLabel = boundedHandoffText(cta?.label, 120);
  const href = boundedHandoffText(cta?.href, 512);
  if (!label || !reason || !cta || !ctaLabel || !href) return null;
  const agentId = capabilityHandoffTargetAgentId(href);
  if (!agentId || (expectedAgentId && agentId !== expectedAgentId)) return null;
  let originalIntent: string | null = null;
  let clientMessageId: string | null = null;
  if (hasOwnHandoffField(handoff, "continuation")) {
    const continuation = handoffRecord(handoff.continuation);
    if (!continuation) return null;
    if (hasOwnHandoffField(continuation, "originalIntent")) {
      originalIntent = completeHandoffText(continuation.originalIntent);
      if (!originalIntent) return null;
    }
    if (hasOwnHandoffField(continuation, "clientMessageId")) {
      clientMessageId = boundedHandoffText(continuation.clientMessageId, 128);
      if (!clientMessageId) return null;
    }
  }
  return {
    version: 1,
    kind: "capability_handoff",
    capabilityId: handoff.capabilityId as AgentCapabilityId,
    label,
    availability: "needs_workspace",
    reason,
    currentTier: "shared",
    requiredTier: "personal",
    nextAction: "upgrade_workspace",
    requiresConfirmation: true,
    cta: {
      label: ctaLabel,
      href: `/cloud/agents/${encodeURIComponent(agentId)}`,
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

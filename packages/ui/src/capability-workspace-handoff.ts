/**
 * Validates Shared-runtime capability gates and preserves their continuation
 * metadata through personal-workspace provisioning and any connector setup the
 * capability still requires.
 */

import type { CapabilityHandoffRequest } from "@elizaos/shared";
import type { ChatActionResultSummary } from "./api/client-types-chat";

export const CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY =
  "elizaos:capability-workspace-handoff";
export const CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY =
  "elizaos:capability-connector-continuation";
const CAPABILITY_WORKSPACE_HANDOFF_TTL_MS = 30 * 60 * 1_000;
const CONNECTION_CAPABILITIES = new Set<
  CapabilityHandoffRequest["capabilityId"]
>(["calendar", "communications", "cloud-apps"]);
const HANDOFF_CAPABILITIES = new Set<CapabilityHandoffRequest["capabilityId"]>([
  "calendar",
  "reminders",
  "todos",
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
const MAX_CONTINUATION_INTENT_LENGTH = 4_000;
const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;

export interface CapabilityConnectorContinuation {
  version: 1;
  agentId: string;
  capabilityId: CapabilityHandoffRequest["capabilityId"];
  originalIntent: string;
  clientMessageId?: string;
  requiresConfirmation: true;
  connectorId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeAppPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
  );
}

/**
 * Return the newest typed capability handoff from a completed action set.
 * Action values are an untrusted wire boundary, so malformed or successful
 * lookalikes are ignored. `fallbackIntent` retains the exact submitted turn
 * when an older server did not yet include continuation metadata.
 */
export function findCapabilityWorkspaceHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
  fallbackIntent?: string,
): CapabilityHandoffRequest | null {
  if (!Array.isArray(actionResults)) return null;
  for (let index = actionResults.length - 1; index >= 0; index--) {
    const result = actionResults[index];
    const isCapabilityWall =
      result?.actionName === "DEDICATED_CAPABILITY_REQUIRED" && !result.success;
    const isPlannerHandoff =
      result?.actionName === "ENABLE_CAPABILITY" && result.success;
    if (
      (!isCapabilityWall && !isPlannerHandoff) ||
      !isRecord(result.values) ||
      !isRecord(result.values.capabilityHandoff)
    ) {
      continue;
    }

    const candidate = result.values.capabilityHandoff;
    const cta = candidate.cta;
    const continuation = candidate.continuation;
    if (
      candidate.version !== 1 ||
      candidate.kind !== "capability_handoff" ||
      typeof candidate.capabilityId !== "string" ||
      !HANDOFF_CAPABILITIES.has(
        candidate.capabilityId as CapabilityHandoffRequest["capabilityId"],
      ) ||
      typeof candidate.label !== "string" ||
      !candidate.label ||
      typeof candidate.reason !== "string" ||
      !candidate.reason ||
      candidate.currentTier !== "shared" ||
      candidate.requiredTier !== "personal" ||
      candidate.availability !== "needs_workspace" ||
      candidate.nextAction !== "upgrade_workspace" ||
      typeof candidate.requiresConfirmation !== "boolean" ||
      !isRecord(cta) ||
      typeof cta.label !== "string" ||
      !cta.label ||
      !isSafeAppPath(cta.href) ||
      (continuation !== undefined && !isRecord(continuation))
    ) {
      continue;
    }

    const originalIntent =
      isRecord(continuation) &&
      typeof continuation.originalIntent === "string" &&
      continuation.originalIntent.trim() &&
      continuation.originalIntent.trim().length <=
        MAX_CONTINUATION_INTENT_LENGTH
        ? continuation.originalIntent
        : fallbackIntent?.trim() &&
            fallbackIntent.trim().length <= MAX_CONTINUATION_INTENT_LENGTH
          ? fallbackIntent
          : undefined;
    const clientMessageId =
      isRecord(continuation) &&
      typeof continuation.clientMessageId === "string" &&
      continuation.clientMessageId.trim() &&
      continuation.clientMessageId.trim().length <= MAX_CLIENT_MESSAGE_ID_LENGTH
        ? continuation.clientMessageId
        : undefined;

    return {
      version: 1,
      kind: "capability_handoff",
      capabilityId:
        candidate.capabilityId as CapabilityHandoffRequest["capabilityId"],
      label: candidate.label,
      availability:
        candidate.availability as CapabilityHandoffRequest["availability"],
      reason: candidate.reason,
      currentTier: "shared",
      requiredTier: "personal",
      nextAction:
        candidate.nextAction as CapabilityHandoffRequest["nextAction"],
      requiresConfirmation: candidate.requiresConfirmation,
      cta: { label: cta.label, href: cta.href },
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
  return null;
}

/** Save a setup handoff so provisioning can resume the exact user request. */
export function persistCapabilityWorkspaceHandoff(
  handoff: CapabilityHandoffRequest,
  now: () => number = Date.now,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(
      CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY,
      JSON.stringify({ savedAt: now(), handoff }),
    );
    return true;
  } catch {
    // error-policy:J4 caller surfaces that automatic continuation is unavailable
    // while still allowing the requested setup navigation to proceed.
    return false;
  }
}

/**
 * Consume the pending intent only when the completed personal workspace is the
 * setup target that created it. A generic agents-page target may be consumed by
 * the next successful workspace handoff; a different explicit agent is kept.
 */
function readCapabilityWorkspaceHandoff(
  agentId: string,
  consume: boolean,
  now: () => number = Date.now,
): CapabilityHandoffRequest | null {
  if (typeof window === "undefined") return null;
  try {
    const serialized = window.sessionStorage.getItem(
      CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY,
    );
    if (!serialized) return null;
    const parsed: unknown = JSON.parse(serialized);
    const currentTime = now();
    if (
      !isRecord(parsed) ||
      typeof parsed.savedAt !== "number" ||
      !Number.isFinite(parsed.savedAt) ||
      parsed.savedAt > currentTime ||
      currentTime - parsed.savedAt > CAPABILITY_WORKSPACE_HANDOFF_TTL_MS
    ) {
      window.sessionStorage.removeItem(
        CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY,
      );
      return null;
    }
    const handoff = findCapabilityWorkspaceHandoff([
      {
        actionName: "ENABLE_CAPABILITY",
        success: true,
        values: { capabilityHandoff: parsed.handoff },
      },
    ]);
    if (!handoff) return null;
    const explicitTarget = handoff.cta.href.match(
      /^\/cloud\/agents\/([^/?#]+)$/,
    );
    if (
      explicitTarget &&
      decodeURIComponent(explicitTarget[1] ?? "") !== agentId
    ) {
      return null;
    }
    if (consume) {
      window.sessionStorage.removeItem(
        CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY,
      );
    }
    return handoff;
  } catch {
    // error-policy:J3 malformed or unavailable session storage is treated as no
    // resumable handoff; never manufacture an intent or remove another target.
    return null;
  }
}

/** Reads a pending setup request without consuming it before server completion. */
export function peekCapabilityWorkspaceHandoff(
  agentId: string,
  now: () => number = Date.now,
): CapabilityHandoffRequest | null {
  return readCapabilityWorkspaceHandoff(agentId, false, now);
}

export function consumeCapabilityWorkspaceHandoff(
  agentId: string,
  now: () => number = Date.now,
): CapabilityHandoffRequest | null {
  return readCapabilityWorkspaceHandoff(agentId, true, now);
}

/** Preserve a typed continuation only for capabilities with an account prerequisite. */
export function persistCapabilityConnectorContinuation(
  handoff: CapabilityHandoffRequest,
  agentId: string,
  now: () => number = Date.now,
): boolean {
  const originalIntent = handoff.continuation?.originalIntent?.trim();
  if (
    typeof window === "undefined" ||
    !originalIntent ||
    handoff.requiresConfirmation !== true ||
    !CONNECTION_CAPABILITIES.has(handoff.capabilityId)
  ) {
    return false;
  }
  const continuation: CapabilityConnectorContinuation = {
    version: 1,
    agentId,
    capabilityId: handoff.capabilityId,
    originalIntent,
    requiresConfirmation: handoff.requiresConfirmation,
    ...(handoff.continuation?.clientMessageId
      ? { clientMessageId: handoff.continuation.clientMessageId }
      : {}),
  };
  try {
    window.sessionStorage.setItem(
      CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
      JSON.stringify({ savedAt: now(), continuation }),
    );
    return true;
  } catch {
    // error-policy:J4 caller visibly reports that automatic post-connect
    // continuation is unavailable while the normal connector flow remains usable.
    return false;
  }
}

function readConnectorContinuation(
  now: () => number,
): { savedAt: number; continuation: CapabilityConnectorContinuation } | null {
  if (typeof window === "undefined") return null;
  const serialized = window.sessionStorage.getItem(
    CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
  );
  if (!serialized) return null;
  const parsed: unknown = JSON.parse(serialized);
  const currentTime = now();
  if (
    !isRecord(parsed) ||
    typeof parsed.savedAt !== "number" ||
    !Number.isFinite(parsed.savedAt) ||
    parsed.savedAt > currentTime ||
    currentTime - parsed.savedAt > CAPABILITY_WORKSPACE_HANDOFF_TTL_MS ||
    !isRecord(parsed.continuation)
  ) {
    window.sessionStorage.removeItem(
      CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
    );
    return null;
  }
  const candidate = parsed.continuation;
  if (
    candidate.version !== 1 ||
    typeof candidate.agentId !== "string" ||
    !candidate.agentId ||
    typeof candidate.capabilityId !== "string" ||
    !CONNECTION_CAPABILITIES.has(
      candidate.capabilityId as CapabilityHandoffRequest["capabilityId"],
    ) ||
    typeof candidate.originalIntent !== "string" ||
    !candidate.originalIntent.trim() ||
    candidate.originalIntent.trim().length > MAX_CONTINUATION_INTENT_LENGTH ||
    candidate.requiresConfirmation !== true ||
    (candidate.clientMessageId !== undefined &&
      (typeof candidate.clientMessageId !== "string" ||
        !candidate.clientMessageId.trim() ||
        candidate.clientMessageId.trim().length >
          MAX_CLIENT_MESSAGE_ID_LENGTH)) ||
    (candidate.connectorId !== undefined &&
      typeof candidate.connectorId !== "string")
  ) {
    window.sessionStorage.removeItem(
      CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
    );
    return null;
  }
  return {
    savedAt: parsed.savedAt,
    continuation: {
      version: 1,
      agentId: candidate.agentId,
      capabilityId:
        candidate.capabilityId as CapabilityHandoffRequest["capabilityId"],
      originalIntent: candidate.originalIntent,
      requiresConfirmation: true,
      ...(candidate.clientMessageId
        ? { clientMessageId: candidate.clientMessageId }
        : {}),
      ...(candidate.connectorId ? { connectorId: candidate.connectorId } : {}),
    },
  };
}

/** Bind the pending request to the connector setup the user actually initiated. */
export function claimCapabilityConnectorContinuation(
  connectorId: string,
  agentId: string,
  now: () => number = Date.now,
): boolean {
  try {
    const pending = readConnectorContinuation(now);
    if (
      !pending ||
      pending.continuation.agentId !== agentId ||
      pending.continuation.connectorId
    ) {
      return false;
    }
    pending.continuation.connectorId = connectorId;
    window.sessionStorage.setItem(
      CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
      JSON.stringify(pending),
    );
    return true;
  } catch {
    // error-policy:J3 malformed or unavailable storage cannot bind an intent;
    // connector setup continues without fabricating continuation metadata.
    return false;
  }
}

/** Bind and read the typed request so OAuth can persist it server-side. */
export function getOrClaimCapabilityConnectorContinuation(
  connectorId: string,
  agentId: string,
  now: () => number = Date.now,
): CapabilityConnectorContinuation | null {
  try {
    const pending = readConnectorContinuation(now);
    if (!pending || pending.continuation.agentId !== agentId) return null;
    if (!pending.continuation.connectorId) {
      pending.continuation.connectorId = connectorId;
      window.sessionStorage.setItem(
        CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
        JSON.stringify(pending),
      );
    }
    return pending.continuation.connectorId === connectorId
      ? pending.continuation
      : null;
  } catch {
    // error-policy:J3 storage is an untrusted boundary; OAuth proceeds without
    // inventing a resumable request when the stored handoff is malformed.
    return null;
  }
}

/** Consume the exact request only after its user-selected connector is connected. */
export function consumeCapabilityConnectorContinuation(
  connectorId: string,
  agentId: string,
  now: () => number = Date.now,
): CapabilityConnectorContinuation | null {
  try {
    const pending = readConnectorContinuation(now);
    if (
      pending?.continuation.connectorId !== connectorId ||
      pending.continuation.agentId !== agentId
    ) {
      return null;
    }
    window.sessionStorage.removeItem(
      CAPABILITY_CONNECTOR_CONTINUATION_STORAGE_KEY,
    );
    return pending.continuation;
  } catch {
    // error-policy:J3 malformed or unavailable storage produces no continuation;
    // never substitute transcript text or another connector's request.
    return null;
  }
}

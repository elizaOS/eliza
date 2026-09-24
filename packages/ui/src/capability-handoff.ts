/**
 * Validates and retains Shared-to-personal capability handoffs at the client
 * boundary so chat can offer setup and resume intent without treating
 * untrusted action-result data as navigation or execution authority.
 */

import {
  type CapabilityHandoffRequest,
  capabilityHandoffTargetAgentId,
  parsePersonalWorkspaceCapabilityHandoff,
} from "@elizaos/shared";
import type {
  ChatActionResultSummary,
  ConversationMessage,
} from "./api/client-types-chat";
import { runAsPrivilegedShell } from "./surface-realm-channel";

const STORED_HANDOFF_PREFIX = "eliza:capability-handoff:message:";
const PENDING_HANDOFF_KEY = "eliza:capability-handoff:pending";
const PENDING_READY_AGENT_KEY = "eliza:capability-handoff:ready-agent";
const HANDOFF_TTL_MS = 24 * 60 * 60 * 1_000;

interface StoredCapabilityHandoff {
  expiresAt: number;
  handoff: CapabilityHandoffRequest;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : null;
}

/** Parse only the personal-workspace review receipt the UI can safely honor. */
export function parseCapabilityHandoff(
  value: unknown,
  expectedAgentId?: string | null,
): CapabilityHandoffRequest | null {
  return parsePersonalWorkspaceCapabilityHandoff(value, expectedAgentId);
}

/** Find the newest valid receipt without trusting an action name or success bit. */
export function findCapabilityHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
  expectedAgentId?: string | null,
): CapabilityHandoffRequest | null {
  if (!Array.isArray(actionResults)) return null;
  for (let index = actionResults.length - 1; index >= 0; index -= 1) {
    const parsed = parseCapabilityHandoff(
      actionResults[index]?.values?.capabilityHandoff,
      expectedAgentId,
    );
    if (parsed) return parsed;
  }
  return null;
}

function storageOrNull(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // error-policy:J4 restricted storage leaves the in-memory receipt visible.
    return null;
  }
}

function writeStored(
  key: string,
  handoff: CapabilityHandoffRequest,
  storage?: Storage,
): void {
  try {
    const target = storageOrNull(storage);
    if (!target) return;
    runAsPrivilegedShell(() =>
      target.setItem(
        key,
        JSON.stringify({
          expiresAt: Date.now() + HANDOFF_TTL_MS,
          handoff,
        } satisfies StoredCapabilityHandoff),
      ),
    );
  } catch {
    // error-policy:J4 storage is an optional reload enhancement.
  }
}

function readStored(
  key: string,
  storage?: Storage,
  expectedAgentId?: string | null,
): CapabilityHandoffRequest | null {
  const target = storageOrNull(storage);
  if (!target) return null;
  try {
    const raw = target.getItem(key);
    if (!raw) return null;
    const envelope = recordOf(JSON.parse(raw));
    const expiresAt = envelope?.expiresAt;
    const parsed = parseCapabilityHandoff(envelope?.handoff, expectedAgentId);
    if (
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      !parsed
    ) {
      runAsPrivilegedShell(() => target.removeItem(key));
      return null;
    }
    return parsed;
  } catch {
    // error-policy:J3 corrupt or unavailable session data is discarded.
    try {
      runAsPrivilegedShell(() => target.removeItem(key));
    } catch {
      // error-policy:J4 restricted storage cannot affect the active turn.
    }
    return null;
  }
}

/** Retain a validated receipt across a transcript reload in this app session. */
export function rememberCapabilityHandoff(
  messageId: string,
  handoff: CapabilityHandoffRequest,
  storage?: Storage,
): void {
  if (!messageId.trim()) return;
  writeStored(`${STORED_HANDOFF_PREFIX}${messageId}`, handoff, storage);
}

/** Reattach receipts to durable assistant rows after GET /messages replaces state. */
export function restoreCapabilityHandoffs(
  messages: readonly ConversationMessage[],
  storage?: Storage,
  expectedAgentId?: string | null,
): ConversationMessage[] {
  let changed = false;
  const restored = messages.map((message) => {
    if (message.capabilityHandoff) {
      const parsed = parseCapabilityHandoff(
        message.capabilityHandoff,
        expectedAgentId,
      );
      if (parsed) {
        return parsed === message.capabilityHandoff
          ? message
          : { ...message, capabilityHandoff: parsed };
      }
      changed = true;
      const { capabilityHandoff: _invalid, ...withoutInvalidHandoff } = message;
      return withoutInvalidHandoff;
    }
    const handoff = readStored(
      `${STORED_HANDOFF_PREFIX}${message.id}`,
      storage,
      expectedAgentId,
    );
    if (!handoff || message.role !== "assistant") return message;
    changed = true;
    return { ...message, capabilityHandoff: handoff };
  });
  return changed ? restored : (messages as ConversationMessage[]);
}

/** Mark setup as explicitly requested; this never provisions or sends intent. */
export function rememberPendingCapabilityHandoff(
  handoff: CapabilityHandoffRequest,
  storage?: Storage,
): void {
  writeStored(PENDING_HANDOFF_KEY, handoff, storage);
  const target = storageOrNull(storage);
  if (!target) return;
  try {
    runAsPrivilegedShell(() => target.removeItem(PENDING_READY_AGENT_KEY));
  } catch {
    // error-policy:J4 the offer remains usable even without persistence.
  }
}

/** Forget an unstarted continuation when contained setup cannot be opened. */
export function clearPendingCapabilityHandoff(storage?: Storage): void {
  const target = storageOrNull(storage);
  if (!target) return;
  try {
    runAsPrivilegedShell(() => {
      target.removeItem(PENDING_HANDOFF_KEY);
      target.removeItem(PENDING_READY_AGENT_KEY);
    });
  } catch {
    // error-policy:J4 restricted storage cannot affect the visible failure.
  }
}

/** Mark review ready only after the matching runtime reports a real switch. */
export function markPendingCapabilityReady(
  agentId: string,
  storage?: Storage,
): boolean {
  const target = storageOrNull(storage);
  const handoff = readStored(PENDING_HANDOFF_KEY, storage);
  if (
    !target ||
    !handoff ||
    capabilityHandoffTargetAgentId(handoff.cta.href) !== agentId
  ) {
    return false;
  }
  try {
    runAsPrivilegedShell(() =>
      target.setItem(PENDING_READY_AGENT_KEY, agentId),
    );
    return true;
  } catch {
    // error-policy:J4 setup succeeded but continuation persistence is unavailable.
    return false;
  }
}

/** Read the ready marker so a temporarily occupied composer can retry later. */
export function readPendingCapabilityReadyAgentId(
  storage?: Storage,
): string | null {
  const target = storageOrNull(storage);
  if (!target) return null;
  try {
    const readyAgentId = boundedText(
      target.getItem(PENDING_READY_AGENT_KEY),
      256,
    );
    if (!readyAgentId) return null;
    if (!readStored(PENDING_HANDOFF_KEY, storage, readyAgentId)) {
      runAsPrivilegedShell(() => target.removeItem(PENDING_READY_AGENT_KEY));
      return null;
    }
    return readyAgentId;
  } catch {
    // error-policy:J4 unavailable storage means no resumable review.
    return null;
  }
}

/** Consume a matching original intent once in this browser session for review. */
export function consumePendingCapabilityIntent(
  agentId: string,
  storage?: Storage,
): string | null {
  const target = storageOrNull(storage);
  const handoff = readStored(PENDING_HANDOFF_KEY, storage);
  const readyAgentId = readPendingCapabilityReadyAgentId(storage);
  if (!target || !handoff || readyAgentId !== agentId) return null;
  const sourceAgentId = capabilityHandoffTargetAgentId(handoff.cta.href);
  const originalIntent = handoff.continuation?.originalIntent?.trim();
  if (sourceAgentId !== agentId || !originalIntent) return null;
  try {
    runAsPrivilegedShell(() => {
      target.removeItem(PENDING_HANDOFF_KEY);
      target.removeItem(PENDING_READY_AGENT_KEY);
    });
  } catch {
    // error-policy:J4 an unavailable store prevents once-only continuation.
    return null;
  }
  return originalIntent;
}

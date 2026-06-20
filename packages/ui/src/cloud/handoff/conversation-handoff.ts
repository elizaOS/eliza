/**
 * Shared → personal cloud-agent handoff.
 *
 * When a user picks the cloud agent they land in chat IMMEDIATELY on a shared
 * agent (keyed to their identity). Their dedicated personal container then
 * provisions in the background; once it's ready we copy the conversation they
 * already had on the shared agent into it and switch them over seamlessly.
 *
 * This module is the pure orchestration — all I/O (reading shared history,
 * importing to the personal container, polling readiness, switching the active
 * agent) is dependency-injected so the whole flow is unit-testable without a
 * live cloud. The agent-side silent-import primitive lives at
 * `POST /api/conversations/:id/import` (no inference, idempotent).
 */

export interface HandoffMessage {
  role: "user" | "assistant";
  text: string;
  /** Original send time (ms). Preserved so order survives the import. */
  timestamp?: number;
}

export type ConversationHandoffStatus =
  | "switched" // personal ready, conversation copied, user switched
  | "switched-empty" // personal ready, nothing to copy yet, user switched
  | "timed-out" // personal never became ready within the budget
  | "failed"; // an I/O step threw

export interface ConversationHandoffResult {
  status: ConversationHandoffStatus;
  imported: number;
  error?: string;
}

export interface PersonalReadiness {
  ready: boolean;
  /** API base of the ready personal container (dedicated subdomain). */
  apiBase?: string;
}

export interface ConversationHandoffDeps {
  /** Poll whether the personal container has finished provisioning. */
  checkPersonalReady: () => Promise<PersonalReadiness>;
  /** Read the conversation the user built on the shared agent. */
  readSharedMessages: () => Promise<HandoffMessage[]>;
  /**
   * Import the messages into the personal container WITHOUT re-running
   * inference. Returns how many were inserted; `alreadyPopulated` when the
   * personal conversation was already migrated (idempotent no-op).
   */
  importToPersonal: (
    messages: HandoffMessage[],
    personal: PersonalReadiness,
  ) => Promise<{ inserted: number; alreadyPopulated?: boolean }>;
  /** Switch the live client to the personal container. Seamless to the user. */
  switchToPersonal: (personal: PersonalReadiness) => void | Promise<void>;
  /** Readiness-poll cadence + budget. */
  intervalMs?: number;
  timeoutMs?: number;
  /** Injected clock/sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until the personal container is ready (or the budget runs out). Kept
 * separate so callers can drive the readiness loop independently of the copy.
 */
export async function waitForPersonalAgent(
  deps: Pick<
    ConversationHandoffDeps,
    "checkPersonalReady" | "intervalMs" | "timeoutMs" | "now" | "sleep" | "log"
  >,
): Promise<PersonalReadiness> {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    let readiness: PersonalReadiness;
    try {
      readiness = await deps.checkPersonalReady();
    } catch (err) {
      deps.log?.(
        `[handoff] readiness check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      readiness = { ready: false };
    }
    if (readiness.ready) return readiness;
    if (now() >= deadline) return { ready: false };
    await sleep(intervalMs);
  }
}

/**
 * Run the full handoff: wait for the personal container, copy the shared
 * conversation into it, then switch. Safe to re-invoke (the import is
 * idempotent and switching is a no-op once switched).
 */
export async function runConversationHandoff(
  deps: ConversationHandoffDeps,
): Promise<ConversationHandoffResult> {
  const personal = await waitForPersonalAgent(deps);
  if (!personal.ready) {
    deps.log?.("[handoff] personal container did not become ready in time");
    return { status: "timed-out", imported: 0 };
  }

  try {
    const messages = await deps.readSharedMessages();
    let imported = 0;
    if (messages.length > 0) {
      const result = await deps.importToPersonal(messages, personal);
      imported = result.inserted;
      deps.log?.(
        `[handoff] imported ${imported}/${messages.length} message(s)` +
          (result.alreadyPopulated ? " (already populated)" : ""),
      );
    }
    await deps.switchToPersonal(personal);
    return {
      status: messages.length > 0 ? "switched" : "switched-empty",
      imported,
    };
  } catch (err) {
    deps.log?.(
      `[handoff] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      status: "failed",
      imported: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Normalize the shared agent's `/messages` payload into handoff messages. */
export function toHandoffMessages(
  raw: ReadonlyArray<{
    role?: unknown;
    text?: unknown;
    timestamp?: unknown;
  }>,
): HandoffMessage[] {
  const out: HandoffMessage[] = [];
  for (const m of raw) {
    const role =
      m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
    const text = typeof m.text === "string" ? m.text.trim() : "";
    if (!role || !text) continue;
    out.push({
      role,
      text,
      ...(typeof m.timestamp === "number" && Number.isFinite(m.timestamp)
        ? { timestamp: m.timestamp }
        : {}),
    });
  }
  return out;
}
